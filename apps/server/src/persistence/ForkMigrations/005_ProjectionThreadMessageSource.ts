import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Message authorship. `role` alone cannot distinguish a user message the person
 * typed from the wake-up message a finished task injects — both are `user` so
 * the provider treats them alike — but the transcript must not render a task
 * result as something the user said.
 *
 * NULL means "predates this column"; readers fall back to deriving from role.
 *
 * Additive and idempotent per the fork migration rules in `ForkMigrations.ts`.
 */
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
