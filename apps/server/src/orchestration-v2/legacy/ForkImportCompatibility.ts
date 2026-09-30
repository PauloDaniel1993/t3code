import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  initializeForkImportDiagnostics,
  recordForkImportWarning,
} from "../../persistence/ForkImportDiagnostics.ts";
import { forkLegacyMessageRoles, forkLegacyMessageSources } from "./ForkLegacyMessages.ts";

export class ForkImportCompatibilityError extends Schema.TaggedError<ForkImportCompatibilityError>()(
  "ForkImportCompatibilityError",
  { message: Schema.String },
) {}

/** Upstream's importer writes each legacy message's timeline item under this id. */
export const FORK_IMPORT_TURN_ITEM_PREFIX = "migration:v1:turn-item:";
export const FORK_IMPORT_VERIFIED_KEY = "import-compatibility-verified";

interface Mismatch {
  readonly thread_id: string;
  readonly message_id: string;
  readonly verdict: "unpatched" | "unknown";
  readonly detail: string;
}

export type ForkImportInspection =
  | { readonly _tag: "skipped" | "verified" | "unfinished" }
  | { readonly _tag: "unpatched" | "unknown"; readonly mismatch: Mismatch };

/**
 * Compare stored import evidence with the fork's mapping. An unpatched importer
 * writes nothing for reasoning, neither its event nor its reserved position, and
 * no source tags. Only a thread showing that whole omission is positive
 * evidence, and then only with one of its effects: reasoning missing from a
 * completed transcript whose other items it wrote, ordinals counted without
 * reasoning, or known sources dropped from items it did write. A thread holding
 * anything only the fork writes, or any other disagreement, is "unknown"
 * (for example compaction, or an upstream change to import ids or ordinals).
 *
 * The passed check is recorded once every legacy transcript is imported, here
 * or with the last transcript (see `recordForkImportVerifiedWhenComplete`).
 * After that no importer, patched or not, writes another `migration:v1:*` item:
 * every shell exists, nothing is left to hydrate, and upstream's metadata repair
 * writes only thread metadata. Later starts read that one row and stop.
 */
export const inspectForkImport = Effect.fn("inspectForkImport")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* initializeForkImportDiagnostics;
  const verified = yield* sql`
    SELECT 1 FROM fork_v1_import_state WHERE key = ${FORK_IMPORT_VERIFIED_KEY}
  `;
  if (verified.length > 0) return { _tag: "skipped" } satisfies ForkImportInspection;
  const mismatches = yield* sql<Mismatch>`
    WITH legacy AS (
      SELECT message.thread_id, message.message_id, message.role, message.source,
        imported.transcript_imported_at,
        ROW_NUMBER() OVER (
          PARTITION BY message.thread_id ORDER BY message.created_at, message.message_id
        ) AS ordinal,
        -- Upstream's own ordinal: it counts only user and assistant messages.
        CASE WHEN message.role != 'reasoning' THEN ROW_NUMBER() OVER (
          PARTITION BY message.thread_id, message.role = 'reasoning'
          ORDER BY message.created_at, message.message_id
        ) END AS unpatched_ordinal
      FROM projection_thread_messages AS message
      JOIN orchestration_v2_legacy_imports AS imported ON imported.thread_id = message.thread_id
      WHERE ${sql.in("message.role", forkLegacyMessageRoles)}
    ), evidence AS (
      SELECT legacy.*,
        event.event_id IS NOT NULL AS has_event,
        json_extract(event.payload_json, '$.ordinal') AS event_ordinal,
        json_extract(event.payload_json, '$.legacyMessageSource') AS event_source,
        position.ordinal AS position_ordinal,
        legacy.source IN ${sql.in(forkLegacyMessageSources)} AS known_source
      FROM legacy
      LEFT JOIN orchestration_events AS event
        ON event.event_id = ${FORK_IMPORT_TURN_ITEM_PREFIX} || legacy.message_id
      LEFT JOIN orchestration_v2_turn_item_positions AS position
        ON position.thread_id = legacy.thread_id
        AND position.turn_item_id = ${FORK_IMPORT_TURN_ITEM_PREFIX} || legacy.message_id
    ), judged AS (
      SELECT evidence.*,
        -- The thread's user/assistant items use the id scheme this check expects.
        MAX(evidence.has_event AND evidence.role != 'reasoning') OVER thread AS recognized,
        MAX(evidence.role = 'reasoning') OVER thread AS has_reasoning,
        -- Only the fork's importer writes these, so the thread was not imported unpatched.
        MAX((evidence.role = 'reasoning'
            AND (evidence.has_event OR evidence.position_ordinal IS NOT NULL))
          OR evidence.event_source IS NOT NULL) OVER thread AS fork_written
      FROM evidence
      WINDOW thread AS (PARTITION BY evidence.thread_id)
    )
    SELECT thread_id, message_id,
      CASE WHEN has_reasoning AND NOT fork_written AND (
        (role = 'reasoning' AND transcript_imported_at IS NOT NULL AND recognized)
        OR (has_event AND event_ordinal = unpatched_ordinal AND unpatched_ordinal != ordinal)
        OR (position_ordinal = unpatched_ordinal AND unpatched_ordinal != ordinal)
        OR (has_event AND known_source AND event_source IS NULL
          AND event_ordinal IN (ordinal, unpatched_ordinal))
      ) THEN 'unpatched' ELSE 'unknown' END AS verdict,
      json_object('role', role, 'source', source, 'ordinal', ordinal,
        'hasEvent', has_event, 'eventOrdinal', event_ordinal, 'eventSource', event_source,
        'positionOrdinal', position_ordinal,
        'transcriptImported', transcript_imported_at IS NOT NULL) AS detail
    FROM judged
    WHERE (NOT has_event AND transcript_imported_at IS NOT NULL)
      OR (has_event AND (event_ordinal IS NOT ordinal
        OR (known_source AND event_source IS NOT source)))
      OR (position_ordinal IS NOT NULL AND position_ordinal != ordinal)
    ORDER BY verdict = 'unpatched' DESC
    LIMIT 1
  `;
  const mismatch = mismatches[0];
  if (mismatch !== undefined) {
    return { _tag: mismatch.verdict, mismatch } satisfies ForkImportInspection;
  }
  return (yield* recordForkImportVerifiedWhenComplete())
    ? ({ _tag: "verified" } satisfies ForkImportInspection)
    : ({ _tag: "unfinished" } satisfies ForkImportInspection);
});

/**
 * Record the passed check once no legacy transcript is left to import. The
 * importer calls this with the last transcript, in the same transaction, when
 * this start's check found nothing wrong: everything imported since came from
 * this build, so the next start skips the scan.
 */
export const recordForkImportVerifiedWhenComplete = Effect.fn(
  "recordForkImportVerifiedWhenComplete",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const unfinished = yield* sql`
    SELECT 1 FROM projection_threads AS thread
    LEFT JOIN orchestration_v2_legacy_imports AS imported ON imported.thread_id = thread.thread_id
    WHERE imported.transcript_imported_at IS NULL
    LIMIT 1
  `;
  if (unfinished.length > 0) return false;
  yield* initializeForkImportDiagnostics;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO fork_v1_import_state (key, recorded_at)
    VALUES (${FORK_IMPORT_VERIFIED_KEY}, ${now})
    ON CONFLICT(key) DO NOTHING
  `;
  return true;
});

/**
 * Refuse only on positive evidence that an unpatched importer ran first. When
 * the evidence is unrecognised or unreadable, start and record a warning: a
 * wrong refusal locks the owner out of every thread. Returns whether the
 * evidence was confirmed, which lets the importer record the pass later.
 */
export const assertForkImportCompatible = Effect.fn("assertForkImportCompatible")(function* () {
  const inspection = yield* inspectForkImport().pipe(
    Effect.catch((cause) => Effect.succeed({ _tag: "unreadable" as const, detail: String(cause) })),
  );
  if (inspection._tag === "unpatched") {
    const { thread_id, message_id } = inspection.mismatch;
    return yield* new ForkImportCompatibilityError({
      message: `Incompatible V1 import in statev2.sqlite: an unpatched V2 importer omitted source tags/reasoning or reserved incompatible transcript positions (thread ${thread_id}, message ${message_id}). Stop the server. Preserve and move statev2.sqlite and its sibling files (statev2.sqlite-wal and statev2.sqlite-shm, if present) aside, then start this build again to make a fresh copy from the untouched state.sqlite. Keep the moved files: they may contain work done in V2 since the import. This build will not delete or overwrite that work.`,
    });
  }
  if (inspection._tag === "unknown" || inspection._tag === "unreadable") {
    const [entityId, detail] =
      "mismatch" in inspection
        ? [inspection.mismatch.message_id, inspection.mismatch.detail]
        : ["statev2.sqlite", inspection.detail];
    yield* Effect.logWarning(
      "Fork V1 import compatibility could not be confirmed; starting anyway (ticket 28)",
      { entityId, detail },
    );
    yield* recordForkImportWarning(
      entityId,
      "import_compatibility",
      "Stored V1 import evidence is not in a recognised form; the server started without the compatibility check.",
      detail,
    ).pipe(Effect.ignore);
    return false;
  }
  return true;
});
