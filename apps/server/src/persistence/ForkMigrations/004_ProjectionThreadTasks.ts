import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Tasks are full child threads; links and rollups share the thread projection for join-free reads.
// Migration is additive and idempotent, including databases predating the fork ledger.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_thread_id TEXT
    `;
  }

  if (!columns.some((column) => column.name === "task_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN task_json TEXT
    `;
  }

  if (!columns.some((column) => column.name === "task_summary_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN task_summary_json TEXT
    `;
  }

  // Partial index: only task threads carry a parent, so the index stays as
  // small as the number of tasks rather than the number of threads.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent_thread_id
    ON projection_threads (parent_thread_id)
    WHERE parent_thread_id IS NOT NULL
  `;
});
