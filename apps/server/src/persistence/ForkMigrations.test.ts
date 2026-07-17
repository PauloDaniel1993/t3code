import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_AttachmentCleanupQueue.ts";
import { reconcileBaseMigrationLedger, runForkMigrations } from "./ForkMigrations.ts";
import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const runStartupMigrations = Effect.gen(function* () {
  yield* reconcileBaseMigrationLedger();
  const baseMigrations = yield* runMigrations();
  const forkMigrations = yield* runForkMigrations();
  return { baseMigrations, forkMigrations };
});

const readMigrationState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cleanupQueueTables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'attachment_cleanup_queue'
  `;
  const cleanupQueueIndexes = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_attachment_cleanup_queue_pending'
  `;
  const baseLedger = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`
    SELECT migration_id, name
    FROM effect_sql_migrations
    ORDER BY migration_id ASC
  `;
  const forkLedger = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`
    SELECT migration_id, name
    FROM fork_sql_migrations
    ORDER BY migration_id ASC
  `;
  return {
    cleanupQueueIndexes,
    cleanupQueueTables,
    baseLedger,
    forkLedger,
  };
});

const assertForkMigrationApplied = (state: Effect.Success<typeof readMigrationState>) => {
  assert.deepStrictEqual(state.cleanupQueueTables, [{ name: "attachment_cleanup_queue" }]);
  assert.deepStrictEqual(state.cleanupQueueIndexes, [
    { name: "idx_attachment_cleanup_queue_pending" },
  ]);
  assert.deepStrictEqual(state.forkLedger, [
    {
      migration_id: 1,
      name: "AttachmentCleanupQueue",
    },
  ]);
};

const assertBaseLedgerEndsAt32 = (state: Effect.Success<typeof readMigrationState>) => {
  assert.equal(state.baseLedger.length, 32);
  assert.deepStrictEqual(state.baseLedger.at(-1), {
    migration_id: 32,
    name: "AuthPairingProofKeyThumbprint",
  });
};

const seedLegacyAttachmentCleanupMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* runMigrations();
  yield* ForkMigration0001;
  yield* sql`
    INSERT INTO attachment_cleanup_queue (
      operation,
      thread_id,
      relative_path,
      created_at
    )
    VALUES (
      'delete-thread',
      'thread-from-legacy-migration',
      '',
      '2026-07-10T00:00:00.000Z'
    )
  `;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name)
    VALUES (33, 'AttachmentCleanupQueue')
  `;
});

const freshLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

freshLayer("ForkMigrations (fresh database)", (it) => {
  it.effect("runs base then fork migrations into separate ledgers", () =>
    Effect.gen(function* () {
      const executed = yield* runStartupMigrations;
      const state = yield* readMigrationState;

      assert.equal(executed.baseMigrations.length, 32);
      assert.deepStrictEqual(executed.baseMigrations.at(-1), [32, "AuthPairingProofKeyThumbprint"]);
      assert.deepStrictEqual(executed.forkMigrations, [[1, "AttachmentCleanupQueue"]]);
      assertBaseLedgerEndsAt32(state);
      assertForkMigrationApplied(state);
    }),
  );
});

const baseOnlyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

baseOnlyLayer("ForkMigrations (existing base-only database)", (it) => {
  it.effect("adds the fork ledger to a database that never ran the attachment branch", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      const queueBeforeStartup = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'attachment_cleanup_queue'
      `;
      assert.deepStrictEqual(queueBeforeStartup, []);

      const executed = yield* runStartupMigrations;
      const state = yield* readMigrationState;

      assert.deepStrictEqual(executed.baseMigrations, []);
      assert.deepStrictEqual(executed.forkMigrations, [[1, "AttachmentCleanupQueue"]]);
      assertBaseLedgerEndsAt32(state);
      assertForkMigrationApplied(state);
    }),
  );
});

const legacyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

legacyLayer("ForkMigrations (legacy base-ledger entry)", (it) => {
  it.effect(
    "moves base 33/AttachmentCleanupQueue into the fork ledger without replacing its table",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* seedLegacyAttachmentCleanupMigration;
        yield* runStartupMigrations;

        const state = yield* readMigrationState;
        assertBaseLedgerEndsAt32(state);
        assertForkMigrationApplied(state);

        const preservedRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM attachment_cleanup_queue
      `;
        assert.deepStrictEqual(preservedRows, [{ threadId: "thread-from-legacy-migration" }]);
      }),
  );
});

const futureBaseLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

futureBaseLayer("ForkMigrations (future upstream base migration)", (it) => {
  it.effect("leaves base migration 33 untouched when its name differs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (33, 'HypotheticalUpstreamMigration')
      `;

      yield* runStartupMigrations;

      const state = yield* readMigrationState;
      assertForkMigrationApplied(state);
      assert.equal(state.baseLedger.length, 33);
      assert.deepStrictEqual(state.baseLedger.at(-1), {
        migration_id: 33,
        name: "HypotheticalUpstreamMigration",
      });
    }),
  );
});

const restartLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

restartLayer("ForkMigrations (restart reconciliation)", (it) => {
  it.effect("keeps the reconciled ledgers and schema unchanged across restarts", () =>
    Effect.gen(function* () {
      yield* seedLegacyAttachmentCleanupMigration;
      yield* runStartupMigrations;
      const firstStartupState = yield* readMigrationState;

      yield* runStartupMigrations;
      const secondStartupState = yield* readMigrationState;

      assert.deepStrictEqual(secondStartupState, firstStartupState);
      assertBaseLedgerEndsAt32(secondStartupState);
      assertForkMigrationApplied(secondStartupState);
    }),
  );
});
