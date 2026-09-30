import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * In-session agents: a provider's own subagents, projected onto the thread that
 * spawned them.
 *
 * Unlike thread tasks these never become threads of their own, so there is no
 * row to hang them off — they live as a bounded JSON array on the parent's
 * thread projection, next to `task_json` / `task_summary_json`, and every thread
 * read path picks them up without a join.
 *
 * No index: the column is only ever read alongside the row it belongs to, never
 * filtered on.
 *
 * Additive and idempotent per the fork migration rules in `ForkMigrations.ts`.
 */
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
