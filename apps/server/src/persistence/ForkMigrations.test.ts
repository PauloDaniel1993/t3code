import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_AttachmentCleanupQueue.ts";
import ForkMigration0002 from "./ForkMigrations/002_ProjectionThreadSessionRecovery.ts";
import ForkMigration0003 from "./ForkMigrations/003_DatabaseCompactionJournal.ts";
import { reconcileBaseMigrationLedger, runForkMigrations } from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
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
    {
      migration_id: 7,
      name: "ResetProjectionThreadNativeAgents",
    },
    {
      migration_id: 8,
      name: "BackfillProjectionThreadNativeAgents",
    },
  ]);
};

const assertBaseLedgerMatchesManifest = (state: Effect.Success<typeof readMigrationState>) => {
  // The manifest is only a trustworthy expectation if it is itself well-formed.
  // Comparing the ledger to a manifest that had gained a duplicate id or lost an
  // entry — the classic fork-sync merge-conflict shapes — would otherwise pass,
  // because both sides derive from `migrationEntries`. Anchoring the ids to a
  // contiguous 1..N run catches that without a literal that goes stale on every
  // new migration.
  const manifestIds = migrationManifest.map(([id]) => id);
  assert.deepStrictEqual(
    manifestIds,
    manifestIds.map((_, index) => index + 1),
  );

  assert.deepStrictEqual(
    state.baseLedger.map(({ migration_id, name }) => [migration_id, name] as const),
    migrationManifest,
  );
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

      assert.deepStrictEqual(executed.baseMigrations, migrationManifest);
      assert.deepStrictEqual(executed.forkMigrations, [
        [1, "AttachmentCleanupQueue"],
        [2, "ProjectionThreadSessionRecovery"],
        [3, "DatabaseCompactionJournal"],
        [4, "ProjectionThreadTasks"],
        [5, "ProjectionThreadMessageSource"],
        [6, "ProjectionThreadNativeAgents"],
        [7, "ResetProjectionThreadNativeAgents"],
        [8, "BackfillProjectionThreadNativeAgents"],
      ]);
      assertBaseLedgerMatchesManifest(state);
      assertForkMigrationApplied(state);
    }),
  );
});

// The projection folds in-session agents as their activities arrive and never
// re-reads stored ones, so agents that ran before the feature existed — or that
// migration 007 cleared — would stay invisible forever without a backfill.
const backfillLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

backfillLayer("ForkMigrations (in-session agent backfill)", (it) => {
  it.effect("rebuilds agents from stored activities, ignoring non-agent tasks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Migrate up to 007 first, so the schema exists and the column is clear.
      yield* reconcileBaseMigrationLedger();
      yield* runMigrations();
      yield* runForkMigrations({ toMigrationInclusive: 7 });

      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES ('thread-backfill', 'project-1', 'Backfill', '2026-07-30T09:00:00.000Z', '2026-07-30T09:00:00.000Z')
      `;

      const activity = (
        activityId: string,
        kind: string,
        payload: Record<string, unknown>,
        sequence: number,
      ) => sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
        )
        VALUES (
          ${activityId},
          'thread-backfill',
          'turn-1',
          'info',
          ${kind},
          ${kind},
          ${JSON.stringify(payload)},
          ${`2026-07-30T09:00:0${sequence}.000Z`},
          ${sequence}
        )
      `;

      yield* activity(
        "a1",
        "task.started",
        {
          taskId: "w1",
          subagentType: "Explore",
          description: "Map handlers",
        },
        1,
      );
      yield* activity(
        "a2",
        "task.completed",
        { taskId: "w1", status: "completed", summary: "3 gaps" },
        2,
      );
      // A backgrounded shell on the same channel must not come back as an agent.
      yield* activity(
        "a3",
        "task.started",
        {
          taskId: "bash-1",
          taskType: "local_bash",
          description: "Restart the mockup static server",
        },
        3,
      );

      yield* runForkMigrations();

      const rows = yield* sql<{ readonly nativeAgents: string | null }>`
        SELECT native_agents_json AS "nativeAgents"
        FROM projection_threads
        WHERE thread_id = 'thread-backfill'
      `;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const agents = JSON.parse(rows[0]?.nativeAgents ?? "[]") as ReadonlyArray<
        Record<string, unknown>
      >;
      assert.equal(agents.length, 1);
      assert.deepInclude(agents[0], {
        taskId: "w1",
        status: "finished",
        description: "Map handlers",
        subagentType: "Explore",
        resultSummary: "3 gaps",
      });
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
        [7, "ResetProjectionThreadNativeAgents"],
        [8, "BackfillProjectionThreadNativeAgents"],
      ]);
      assertBaseLedgerMatchesManifest(state);
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
        assertBaseLedgerMatchesManifest(state);
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
      assertBaseLedgerMatchesManifest(state);
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
      assertBaseLedgerMatchesManifest(state);
      assert.deepStrictEqual(
        state.baseLedger.filter(({ migration_id }) => migration_id === 33 || migration_id === 34),
        [
          { migration_id: 33, name: "ProjectionThreadsSettled" },
          { migration_id: 34, name: "ProjectionThreadsSnoozed" },
        ],
      );
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
      assertBaseLedgerMatchesManifest(secondStartupState);
      assertForkMigrationApplied(secondStartupState);
    }),
  );
});
