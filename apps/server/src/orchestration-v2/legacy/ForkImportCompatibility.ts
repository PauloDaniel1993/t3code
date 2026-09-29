import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class ForkImportCompatibilityError extends Schema.TaggedError<ForkImportCompatibilityError>()(
  "ForkImportCompatibilityError",
  { message: Schema.String },
) {}

/** Inspect stored import evidence, including unfinished shell-only imports. No build marker can prove this. */
export const assertForkImportCompatible = Effect.fn("assertForkImportCompatible")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const incompatible = yield* sql<{ thread_id: string; message_id: string }>`
    WITH expected AS (
      SELECT message.*, legacy.transcript_imported_at,
        ROW_NUMBER() OVER (PARTITION BY message.thread_id ORDER BY message.created_at, message.message_id) AS ordinal
      FROM projection_thread_messages AS message
      JOIN orchestration_v2_legacy_imports AS legacy ON legacy.thread_id = message.thread_id
      WHERE message.role IN ('user', 'assistant', 'reasoning')
    )
    SELECT expected.thread_id, expected.message_id FROM expected
    LEFT JOIN orchestration_events AS event ON event.event_id = 'migration:v1:turn-item:' || expected.message_id
    LEFT JOIN orchestration_v2_turn_item_positions AS position
      ON position.thread_id = expected.thread_id AND position.turn_item_id = 'migration:v1:turn-item:' || expected.message_id
    WHERE (event.event_id IS NULL AND expected.transcript_imported_at IS NOT NULL)
      OR (event.event_id IS NOT NULL AND (
        json_extract(event.payload_json, '$.ordinal') IS NOT expected.ordinal
        OR (expected.source IN ('user', 'provider', 'system', 'task-result')
          AND json_extract(event.payload_json, '$.legacyMessageSource') IS NOT expected.source)
      ))
      OR (position.ordinal IS NOT NULL AND position.ordinal != expected.ordinal)
    LIMIT 1
  `;
  const row = incompatible[0];
  if (row !== undefined) {
    return yield* new ForkImportCompatibilityError({
      message: `Incompatible V1 import in statev2.sqlite: an unpatched V2 importer omitted source tags/reasoning or reserved incompatible transcript positions (thread ${row.thread_id}, message ${row.message_id}). Stop the server. Preserve and move statev2.sqlite and its sibling files (statev2.sqlite-wal and statev2.sqlite-shm, if present) aside, then start this build again to make a fresh copy from the untouched state.sqlite. Keep the moved files: they may contain work done in V2 since the import. This build will not delete or overwrite that work.`,
    });
  }
});
