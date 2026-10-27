import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Native in-session agents have no child thread row; keep their bounded projection on the parent.
// No index is needed because reads load the parent; migration is additive and idempotent.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "native_agents_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN native_agents_json TEXT
    `;
  }
});
