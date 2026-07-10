import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { reconcileBaseMigrationLedger, runForkMigrations } from "./ForkMigrations.ts";
import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const runAll = Effect.gen(function* () {
  yield* reconcileBaseMigrationLedger();
  yield* runMigrations();
  yield* runForkMigrations();
});

const readState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const baseLedger = yield* sql<{ readonly migration_id: number }>`
    SELECT migration_id FROM effect_sql_migrations
    WHERE migration_id >= 33 ORDER BY migration_id ASC
  `;
  const forkLedger = yield* sql<{ readonly migration_id: number }>`
    SELECT migration_id FROM fork_sql_migrations ORDER BY migration_id ASC
  `;
  return {
    messageColumnNames: messageColumns.map((column) => column.name),
    threadColumnNames: threadColumns.map((column) => column.name),
    baseLedgerIdsFrom33: baseLedger.map((row) => row.migration_id),
    forkLedgerIds: forkLedger.map((row) => row.migration_id),
  };
});

const assertForkSchema = (state: Effect.Success<typeof readState>) => {
  assert.ok(state.threadColumnNames.includes("handoff_json"));
  assert.ok(state.messageColumnNames.includes("source"));
  assert.ok(state.messageColumnNames.includes("source_thread_id"));
  assert.ok(state.messageColumnNames.includes("source_message_id"));
  assert.ok(state.messageColumnNames.includes("model_reroute_json"));
  assert.deepStrictEqual(state.baseLedgerIdsFrom33, []);
  assert.deepStrictEqual(state.forkLedgerIds, [1, 2]);
};

const freshLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

freshLayer("ForkMigrations (fresh database)", (it) => {
  it.effect("applies base and fork migrations into separate ledgers", () =>
    Effect.gen(function* () {
      yield* runAll;
      assertForkSchema(yield* readState);
    }),
  );
});

// A database migrated by a build whose registry ended at 999: base schema
// through 32, the 999 handoff DDL applied, 999 recorded in the base ledger,
// and migration 33 (model reroute) silently skipped.
const legacy999Layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

legacy999Layer("ForkMigrations (legacy database that recorded 999)", (it) => {
  it.effect("cleans the base ledger and repairs the skipped reroute column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN handoff_json TEXT`;
      yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN source TEXT`;
      yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN source_thread_id TEXT`;
      yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN source_message_id TEXT`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (999, 'ProviderThreadHandoff')
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'msg-historical',
          'thread-historical',
          NULL,
          'assistant',
          'response from before the migration',
          0,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runAll;
      assertForkSchema(yield* readState);

      const rows = yield* sql<{
        readonly text: string;
        readonly model_reroute_json: string | null;
      }>`
        SELECT text, model_reroute_json
        FROM projection_thread_messages
        WHERE message_id = 'msg-historical'
      `;
      assert.deepStrictEqual(rows, [
        {
          text: "response from before the migration",
          model_reroute_json: null,
        },
      ]);
    }),
  );
});

// A database migrated by a build whose registry contained 33 and 999 in the
// base sequence: all fork columns exist and both ids are recorded.
const legacy33And999Layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

legacy33And999Layer("ForkMigrations (legacy database that recorded 33 and 999)", (it) => {
  it.effect("moves fork ids out of the base ledger and stays idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN model_reroute_json TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN handoff_json TEXT`;
      yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN source TEXT`;
      yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN source_thread_id TEXT`;
      yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN source_message_id TEXT`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (33, 'ProjectionThreadMessageModelReroute'),
          (999, 'ProviderThreadHandoff')
      `;

      yield* runAll;
      assertForkSchema(yield* readState);

      // Re-running the full startup sequence must not fail or change state.
      yield* runAll;
      const state = yield* readState;
      assertForkSchema(state);
      assert.strictEqual(
        state.messageColumnNames.filter((name) => name === "model_reroute_json").length,
        1,
      );
    }),
  );
});
