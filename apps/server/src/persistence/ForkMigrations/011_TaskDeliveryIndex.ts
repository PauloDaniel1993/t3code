// Ticket 32: register [11, "TaskDeliveryIndex", migration] in ticket 28's fork ledger on integration.
// Standalone startup runs the same idempotent DDL after upstream's migrations.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // SQLite maintains the extracted timestamp on each task write. Shell reads
  // use only the index keys and never fetch or parse prompt/result payloads.
  yield* sql`CREATE INDEX IF NOT EXISTS fork_v2_task_delivery_idx
    ON orchestration_v2_projection_subagents (
      thread_id, json_extract(payload_json, '$.completionDelivery.deliveredAt')
    ) WHERE origin = 'app_owned'`;
});
