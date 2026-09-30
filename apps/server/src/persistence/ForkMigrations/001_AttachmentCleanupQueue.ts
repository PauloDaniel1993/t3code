import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS attachment_cleanup_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL CHECK (operation IN ('delete-thread', 'delete-path')),
      thread_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      created_at TEXT NOT NULL,
      last_attempt_at TEXT,
      last_error TEXT,
      CHECK (
        (operation = 'delete-thread' AND relative_path = '') OR
        (operation = 'delete-path' AND relative_path <> '')
      ),
      UNIQUE (operation, thread_id, relative_path)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_queue_pending
    ON attachment_cleanup_queue(attempt_count, created_at, id)
  `;
});
