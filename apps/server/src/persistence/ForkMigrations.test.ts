import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_AttachmentCleanupQueue.ts";
import ForkMigration0002 from "./ForkMigrations/002_ProjectionThreadSessionRecovery.ts";
import ForkMigration0003 from "./ForkMigrations/003_DatabaseCompactionJournal.ts";
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
  const recoveryColumns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_thread_sessions')
    WHERE name = 'recovery_json'
  `;
  const compactionJournalTables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'database_compaction_journal'
  `;
  const threadTaskColumns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_threads')
    WHERE name IN ('parent_thread_id', 'task_json', 'task_summary_json')
    ORDER BY name ASC
  `;
  const threadTaskIndexes = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_projection_threads_parent_thread_id'
  `;
  const messageSourceColumns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_thread_messages')
    WHERE name = 'source'
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
    compactionJournalTables,
    threadTaskColumns,
    threadTaskIndexes,
    messageSourceColumns,
    baseLedger,
    forkLedger,
    recoveryColumns,
  };
});

const assertForkMigrationApplied = (state: Effect.Success<typeof readMigrationState>) => {
  assert.deepStrictEqual(state.cleanupQueueTables, [{ name: "attachment_cleanup_queue" }]);
  assert.deepStrictEqual(state.cleanupQueueIndexes, [
    { name: "idx_attachment_cleanup_queue_pending" },
  ]);
  assert.deepStrictEqual(state.recoveryColumns, [{ name: "recovery_json" }]);
  assert.deepStrictEqual(state.compactionJournalTables, [{ name: "database_compaction_journal" }]);
  assert.deepStrictEqual(state.threadTaskColumns, [
    { name: "parent_thread_id" },
    { name: "task_json" },
    { name: "task_summary_json" },
  ]);
  assert.deepStrictEqual(state.threadTaskIndexes, [
    { name: "idx_projection_threads_parent_thread_id" },
  ]);
  assert.deepStrictEqual(state.messageSourceColumns, [{ name: "source" }]);
  assert.deepStrictEqual(state.forkLedger, [
    {
      migration_id: 1,
      name: "AttachmentCleanupQueue",
    },
    {
      migration_id: 2,
      name: "ProjectionThreadSessionRecovery",
    },
    {
      migration_id: 3,
      name: "DatabaseCompactionJournal",
    },
    {
      migration_id: 4,
      name: "ProjectionThreadTasks",
    },
    {
      migration_id: 5,
      name: "ProjectionThreadMessageSource",
    },
    {
      migration_id: 6,
      name: "ProjectionThreadNativeAgents",
    },
  ]);
};

const assertBaseLedgerEndsAt34 = (state: Effect.Success<typeof readMigrationState>) => {
  assert.equal(state.baseLedger.length, 34);
  assert.deepStrictEqual(state.baseLedger.at(-1), {
    migration_id: 34,
    name: "ProjectionThreadsSnoozed",
  });
};

const seedLegacyAttachmentCleanupMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* runMigrations({ toMigrationInclusive: 32 });
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

const seedLegacyRecoveryAndCompactionMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* runMigrations({ toMigrationInclusive: 32 });
  yield* runForkMigrations({ toMigrationInclusive: 1 });
  yield* ForkMigration0002;
  yield* ForkMigration0003;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name)
    VALUES
      (33, 'ProjectionThreadSessionRecovery'),
      (34, 'DatabaseCompactionJournal')
  `;
  yield* sql`
    INSERT INTO database_compaction_journal (
      journal_id,
      safety_watermark,
      phase,
      event_batch_cursor,
      projection_batch_cursor,
      eligible_event_count,
      processed_event_count,
      skipped_event_count,
      eligible_projection_count,
      processed_projection_count,
      skipped_projection_count,
      logical_bytes_reclaimed,
      started_at,
      updated_at
    )
    VALUES (
      'legacy-journal',
      10,
      'running',
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      '2026-07-23T00:00:00.000Z',
      '2026-07-23T00:00:01.000Z'
    )
  `;
});

const freshLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

freshLayer("ForkMigrations (fresh database)", (it) => {
  it.effect("runs base then fork migrations into separate ledgers", () =>
    Effect.gen(function* () {
      const executed = yield* runStartupMigrations;
      const state = yield* readMigrationState;

      assert.equal(executed.baseMigrations.length, 34);
      assert.deepStrictEqual(executed.baseMigrations.at(-1), [34, "ProjectionThreadsSnoozed"]);
      assert.deepStrictEqual(executed.forkMigrations, [
        [1, "AttachmentCleanupQueue"],
        [2, "ProjectionThreadSessionRecovery"],
        [3, "DatabaseCompactionJournal"],
        [4, "ProjectionThreadTasks"],
        [5, "ProjectionThreadMessageSource"],
        [6, "ProjectionThreadNativeAgents"],
      ]);
      assertBaseLedgerEndsAt34(state);
      assertForkMigrationApplied(state);
    }),
  );
});

const baseOnlyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

baseOnlyLayer("ForkMigrations (existing base-only database)", (it) => {
  it.effect("adds the fork ledger to a database that never ran fork migrations", () =>
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
      assert.deepStrictEqual(executed.forkMigrations, [
        [1, "AttachmentCleanupQueue"],
        [2, "ProjectionThreadSessionRecovery"],
        [3, "DatabaseCompactionJournal"],
        [4, "ProjectionThreadTasks"],
        [5, "ProjectionThreadMessageSource"],
        [6, "ProjectionThreadNativeAgents"],
      ]);
      assertBaseLedgerEndsAt34(state);
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
        assertBaseLedgerEndsAt34(state);
        assertForkMigrationApplied(state);

        const preservedRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM attachment_cleanup_queue
      `;
        assert.deepStrictEqual(preservedRows, [{ threadId: "thread-from-legacy-migration" }]);
      }),
  );
});

const legacyRecoveryLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

legacyRecoveryLayer("ForkMigrations (legacy recovery and compaction rows)", (it) => {
  it.effect("moves legacy base rows into the fork ledger without replacing their schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* seedLegacyRecoveryAndCompactionMigrations;
      yield* runStartupMigrations;

      const state = yield* readMigrationState;
      assertBaseLedgerEndsAt34(state);
      assertForkMigrationApplied(state);
      const journals = yield* sql<{ readonly phase: string }>`
        SELECT phase
        FROM database_compaction_journal
        WHERE journal_id = 'legacy-journal'
      `;
      assert.deepStrictEqual(journals, [{ phase: "running" }]);
    }),
  );
});

const upstreamBaseLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

upstreamBaseLayer("ForkMigrations (upstream base migrations)", (it) => {
  it.effect("leaves upstream base migrations 33 and 34 untouched", () =>
    Effect.gen(function* () {
      yield* runStartupMigrations;

      const state = yield* readMigrationState;
      assertForkMigrationApplied(state);
      assertBaseLedgerEndsAt34(state);
      assert.deepStrictEqual(state.baseLedger.slice(-2), [
        { migration_id: 33, name: "ProjectionThreadsSettled" },
        { migration_id: 34, name: "ProjectionThreadsSnoozed" },
      ]);
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
      assertBaseLedgerEndsAt34(secondStartupState);
      assertForkMigrationApplied(secondStartupState);
    }),
  );
});
