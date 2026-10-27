import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Task wake messages use the user role but must retain agent authorship in the transcript.
// NULL predates explicit authorship and falls back to role; migration is additive and idempotent.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  if (!columns.some((column) => column.name === "source")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN source TEXT
    `;
  }
});
