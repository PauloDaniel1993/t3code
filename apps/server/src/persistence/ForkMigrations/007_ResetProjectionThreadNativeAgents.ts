import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Clear `native_agents_json`.
 *
 * Fork migration 006 shipped with a derivation that treated every `task.*`
 * activity as an in-session agent. It is not that channel: Claude Code reports
 * backgrounded shells (`taskType: "local_bash"`) and plan tasks through it too,
 * so threads accumulated rows like "Restart the mockup static server", spinning
 * forever because a background server never exits.
 *
 * The column is a derived cache with no other source of truth, and the fold only
 * ever adds to the stored list, so those rows would never be corrected in place.
 * Dropping the contents is the honest repair: the list rebuilds from the next
 * agent a thread spawns, and it is a bounded live-picture field, so no durable
 * history is lost.
 *
 * Idempotent by construction — clearing an already-empty column is a no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (columns.some((column) => column.name === "native_agents_json")) {
    yield* sql`
      UPDATE projection_threads
      SET native_agents_json = NULL
      WHERE native_agents_json IS NOT NULL
    `;
  }
});
