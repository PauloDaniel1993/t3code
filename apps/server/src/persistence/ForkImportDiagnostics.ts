import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Also used before upstream's migrations and at startup, so a database that ran
// fork migration 009 before a table was added here still gets it.
export const initializeForkImportDiagnostics = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS fork_v1_import_warnings (
    entity_id TEXT NOT NULL,
    field TEXT NOT NULL,
    reason TEXT NOT NULL,
    original_value TEXT,
    PRIMARY KEY (entity_id, field)
  )`;
  // One row per durable fact about the V1 import, such as a passed compatibility check.
  yield* sql`CREATE TABLE IF NOT EXISTS fork_v1_import_state (
    key TEXT PRIMARY KEY,
    recorded_at TEXT NOT NULL
  )`;
});

/** Keep raw evidence in statev2.sqlite and identify it in the server log. */
export const recordForkImportWarning = Effect.fn("recordForkImportWarning")(function* (
  entityId: string,
  field: string,
  reason: string,
  originalValue: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* initializeForkImportDiagnostics;
  const inserted = yield* sql`INSERT INTO fork_v1_import_warnings
    (entity_id, field, reason, original_value)
    VALUES (${entityId}, ${field}, ${reason}, ${originalValue})
    ON CONFLICT(entity_id, field) DO NOTHING RETURNING entity_id`;
  if (inserted.length > 0) {
    yield* Effect.logWarning("Fork V1 import warning (ticket 28)", {
      entityId,
      field,
      reason,
      evidence: "statev2.sqlite: fork_v1_import_warnings",
    });
  }
});

/** Remove a warning that a later successful pass made untrue. */
export const clearForkImportWarning = Effect.fn("clearForkImportWarning")(function* (
  entityId: string,
  field: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM fork_v1_import_warnings WHERE entity_id = ${entityId} AND field = ${field}`;
});
