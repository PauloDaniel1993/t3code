/** Fork migration: persist resumable database compaction state. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS database_compaction_journal (
      journal_id TEXT PRIMARY KEY,
      safety_watermark INTEGER NOT NULL,
      phase TEXT NOT NULL,
      event_batch_cursor INTEGER NOT NULL,
      projection_batch_cursor INTEGER NOT NULL,
      eligible_event_count INTEGER NOT NULL,
      processed_event_count INTEGER NOT NULL,
      skipped_event_count INTEGER NOT NULL,
      eligible_projection_count INTEGER NOT NULL,
      processed_projection_count INTEGER NOT NULL,
      skipped_projection_count INTEGER NOT NULL,
      logical_bytes_reclaimed INTEGER NOT NULL,
      physical_bytes_before INTEGER,
      physical_bytes_after INTEGER,
      terminal_outcome_json TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
