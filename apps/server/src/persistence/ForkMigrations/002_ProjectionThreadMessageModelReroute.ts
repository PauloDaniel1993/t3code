import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Fork migrations must stay idempotent: existing databases migrated this
// schema under the old single-sequence ids (33 or a manual repair), so the
// column may already exist when the fork ledger replays it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN model_reroute_json TEXT
  `.pipe(Effect.catch(() => Effect.void));
});
