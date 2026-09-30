/**
 * Startup check for a V1 import that an unpatched V2 build made first.
 *
 * It refuses only on positive evidence, and the one thing an unpatched build
 * leaves that this build never does is the absence of this build's own writes:
 * reasoning items, source tags and task-link receipts. So the directory is
 * refused when V1 marks legacy messages as reasoning or with a source, in an
 * imported transcript or a shell preview, and the directory holds none of those
 * writes. Upstream's import ids, payload ordinals and position reservations are
 * never evidence, since a merge can rename or compact them; any disagreement
 * with the fork's mapping there starts the server with a warning. A thread
 * without reasoning or sources in V1 is never evidence of anything.
 *
 * Limits, recorded rather than fixed:
 * - The decision is per directory. One this build imported and an unpatched build
 *   extended later starts with a warning.
 * - A shell-only unpatched import whose previews carry no reasoning or source
 *   differs from this build's only in upstream's positions, so it starts with a
 *   warning. Its hydration is then expected to hit upstream's unique ordinal and
 *   keep failing for the affected threads. The three real unpatched databases
 *   the verification used each have tagged previews and are refused.
 * - The verified marker is trusted. A hand-written
 *   `import-compatibility-verified` row skips the check, even on an unpatched
 *   import; no build writes it except this one after a passed check. Recover by
 *   moving the files aside, never by writing or deleting that row.
 * - V1 projects damaged before upstream migration 26 are not repaired:
 *   `ForkLegacyProjects` validates after migrating to 54, and migration 26 fails
 *   first on a malformed `default_model_selection_json`. The supplied baselines
 *   are at migration 35 and 54.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  initializeForkImportDiagnostics,
  recordForkImportWarning,
} from "../../persistence/ForkImportDiagnostics.ts";
import { forkLegacyMessageRoles, forkLegacyMessageSources } from "./ForkLegacyMessages.ts";
import { REPAIR_COMMAND as TASK_LINK_REPAIR_COMMAND } from "./ForkTaskLinkRepair.ts";

export class ForkImportCompatibilityError extends Schema.TaggedError<ForkImportCompatibilityError>()(
  "ForkImportCompatibilityError",
  { message: Schema.String },
) {}

/** Upstream's importer writes each legacy message's timeline item under this id. */
export const FORK_IMPORT_TURN_ITEM_PREFIX = "migration:v1:turn-item:";
export const FORK_IMPORT_VERIFIED_KEY = "import-compatibility-verified";

interface Omission {
  readonly thread_id: string;
  readonly message_id: string;
}

interface Mismatch {
  readonly message_id: string;
  readonly detail: string;
}

export type ForkImportInspection =
  | { readonly _tag: "skipped" | "verified" | "unfinished" }
  | { readonly _tag: "unpatched"; readonly omission: Omission }
  | { readonly _tag: "unknown"; readonly mismatch: Mismatch };

/**
 * Look for an unpatched import, then for evidence the fork's mapping cannot
 * place. The passed check is recorded once every legacy transcript is imported,
 * here or with the last transcript (see `recordForkImportVerifiedWhenComplete`).
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
  const omissions = yield* sql<Omission>`
    WITH legacy AS (
      SELECT message.thread_id, message.message_id, message.role, message.source,
        imported.transcript_imported_at,
        -- A shell's previews: its latest message and its latest user message.
        ROW_NUMBER() OVER (
          PARTITION BY message.thread_id ORDER BY message.created_at DESC, message.message_id DESC
        ) AS latest,
        ROW_NUMBER() OVER (
          PARTITION BY message.thread_id, message.role = 'user'
          ORDER BY message.created_at DESC, message.message_id DESC
        ) AS latest_of_role
      FROM projection_thread_messages AS message
      JOIN orchestration_v2_legacy_imports AS imported ON imported.thread_id = message.thread_id
      WHERE ${sql.in("message.role", forkLegacyMessageRoles)}
    )
    SELECT thread_id, message_id FROM legacy
    WHERE (role = 'reasoning' OR source IN ${sql.in(forkLegacyMessageSources)})
      AND (transcript_imported_at IS NOT NULL OR latest = 1
        OR (role = 'user' AND latest_of_role = 1))
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items AS item
        WHERE json_extract(item.payload_json, '$.legacyMessageSource') IS NOT NULL
          OR (item.type = 'reasoning' AND item.run_id IS NULL AND EXISTS (
            SELECT 1 FROM orchestration_v2_legacy_imports AS imported
            WHERE imported.thread_id = item.thread_id
          ))
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_command_receipts
        WHERE command_type = ${TASK_LINK_REPAIR_COMMAND}
      )
    LIMIT 1
  `;
  const omission = omissions[0];
  if (omission !== undefined) {
    return { _tag: "unpatched", omission } satisfies ForkImportInspection;
  }
  const mismatches = yield* sql<Mismatch>`
    WITH legacy AS (
      SELECT message.thread_id, message.message_id, message.role, message.source,
        imported.transcript_imported_at,
        ROW_NUMBER() OVER (
          PARTITION BY message.thread_id ORDER BY message.created_at, message.message_id
        ) AS ordinal
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
    )
    SELECT message_id,
      json_object('role', role, 'source', source, 'ordinal', ordinal,
        'hasEvent', has_event, 'eventOrdinal', event_ordinal, 'eventSource', event_source,
        'positionOrdinal', position_ordinal,
        'transcriptImported', transcript_imported_at IS NOT NULL) AS detail
    FROM evidence
    WHERE (NOT has_event AND transcript_imported_at IS NOT NULL)
      OR (has_event AND (event_ordinal IS NOT ordinal
        OR (known_source AND event_source IS NOT source)))
      OR (position_ordinal IS NOT NULL AND position_ordinal != ordinal)
    LIMIT 1
  `;
  const mismatch = mismatches[0];
  if (mismatch !== undefined) {
    return { _tag: "unknown", mismatch } satisfies ForkImportInspection;
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
    const { thread_id, message_id } = inspection.omission;
    return yield* new ForkImportCompatibilityError({
      message: `Incompatible V1 import in statev2.sqlite: an unpatched V2 importer wrote it without reasoning or source tags (thread ${thread_id}, message ${message_id}). Stop the server. Preserve and move statev2.sqlite and its sibling files (statev2.sqlite-wal and statev2.sqlite-shm, if present) aside, then start this build again to make a fresh copy from the untouched state.sqlite. Keep the moved files: they may contain work done in V2 since the import. This build will not delete or overwrite that work.`,
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
