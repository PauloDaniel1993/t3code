import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { reconcileBaseMigrationLedger, runForkMigrations } from "./ForkMigrations.ts";
import ProjectionProjectsWorkspaceFile from "./ForkMigrations/012_ProjectionProjectsWorkspaceFile.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const Database = NodeSqliteClient.layer({ filename: ":memory:" });
const migrate = Effect.gen(function* () {
  yield* reconcileBaseMigrationLedger();
  yield* runMigrations();
  yield* runForkMigrations();
});

it.effect("keeps the upstream unsettled-at migration after linked pull requests", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* runMigrations({ toMigrationInclusive: 42 });
    yield* runMigrations({ toMigrationInclusive: 43 });

    const columns = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM pragma_table_info('projection_threads')
      WHERE name IN ('linked_pull_request_json', 'unsettled_at')
      ORDER BY name ASC
    `;
    assert.deepStrictEqual(columns, [
      { name: "linked_pull_request_json" },
      { name: "unsettled_at" },
    ]);
  }).pipe(Effect.provide(Database)),
);

it.effect("keeps upstream and fork histories separate on fresh startup and restart", () =>
  Effect.gen(function* () {
    yield* migrate;
    const sql = yield* SqlClient.SqlClient;
    const base = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const fork = yield* sql`SELECT * FROM fork_sql_migrations ORDER BY migration_id`;
    assert.lengthOf(base, migrationManifest.length);
    assert.lengthOf(fork, 15);
    assert.deepEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 78 ORDER BY migration_id`,
      migrationManifest
        .filter(([id]) => id >= 78)
        .map(([migration_id, name]) => ({ migration_id, name })),
    );
    assert.deepEqual(
      yield* sql`SELECT name FROM pragma_table_info('flow_runs') WHERE name = 'version'`,
      [{ name: "version" }],
    );
    assert.lengthOf(
      yield* sql`SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN ('flow_steps_thread', 'flow_runs_recovery', 'flow_runs_schedule')`,
      3,
    );
    assert.deepEqual(
      yield* sql`SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'flow_thread_deleted'`,
      [],
    );
    yield* migrate;
    assert.deepEqual(yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`, base);
    assert.deepEqual(yield* sql`SELECT * FROM fork_sql_migrations ORDER BY migration_id`, fork);
  }).pipe(Effect.provide(Database)),
);

it.effect("preserves saved workspace, task and flow data when upgrading the previous fork", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const timestamp = "2026-11-13T00:00:00.000Z";
    const workspaceFile = "/fixture/project.code-workspace";
    const folders = JSON.stringify([{ path: "/fixture" }]);
    const task = JSON.stringify({ status: "completed" });
    const nativeAgents = JSON.stringify([{ id: "native-a" }]);
    yield* runMigrations({ toMigrationInclusive: 88 });
    yield* runForkMigrations({ toMigrationInclusive: 14 });
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at,
        workspace_file, workspace_folders_json
      ) VALUES ('p', 'Project', '/fixture', '[]', ${timestamp}, ${timestamp}, ${workspaceFile}, ${folders})
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, parent_thread_id, task_json, native_agents_json
      ) VALUES (
        't', 'p', 'Task', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        ${timestamp}, ${timestamp}, 'parent', ${task}, ${nativeAgents}
      )
    `;
    yield* sql`
      INSERT INTO flow_runs (
        id, version, project_id, flow_id, run_number, flow_title, flow_run_thread_id,
        definition_snapshot, inputs, workspace, status, created_at, summary_json
      ) VALUES ('r', 1, 'p', 'flow', 1, 'Flow', 't', '{}', '{}', '{}', 'running', ${timestamp}, '{}')
    `;
    yield* sql`
      INSERT INTO flow_step_runs (
        id, flow_run_id, step_path, attempt, status, output, created_at, state_json
      ) VALUES ('s', 'r', 'prompt', 1, 'completed', 'step output', ${timestamp}, '{}')
    `;

    yield* migrate;
    yield* migrate;

    assert.deepEqual(
      yield* sql`SELECT workspace_file, workspace_folders_json, tracked_folders_json FROM projection_projects`,
      [
        {
          workspace_file: workspaceFile,
          workspace_folders_json: folders,
          tracked_folders_json: "[]",
        },
      ],
    );
    assert.deepEqual(
      yield* sql`SELECT parent_thread_id, task_json, native_agents_json FROM projection_threads`,
      [{ parent_thread_id: "parent", task_json: task, native_agents_json: nativeAgents }],
    );
    assert.deepEqual(
      yield* sql`SELECT run.id, run.version, step.output FROM flow_runs run JOIN flow_step_runs step ON step.flow_run_id = run.id`,
      [{ id: "r", version: 1, output: "step output" }],
    );
    assert.deepEqual(yield* sql`SELECT run_id FROM workflow_runs`, []);
    assert.lengthOf(
      yield* sql`SELECT migration_id FROM effect_sql_migrations`,
      migrationManifest.length,
    );
    assert.lengthOf(yield* sql`SELECT migration_id FROM fork_sql_migrations`, 15);
  }).pipe(Effect.provide(Database)),
);

it.effect.each([
  { laterMigration: false, label: "at the tip" },
  { laterMigration: true, label: "below a later migration" },
])("repairs old base-ledger collisions $label", ({ laterMigration }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 32 });
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (33, 'ProjectionThreadSessionRecovery'), (34, 'DatabaseCompactionJournal')`;
    if (laterMigration) {
      // Simulate a history where 35 ran despite the old fork occupying 33/34.
      yield* runMigrations({ toMigrationInclusive: 35 });
    }
    yield* migrate;
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
    for (const name of ["settled_at", "settled_override", "snoozed_at", "snoozed_until"]) {
      assert.isTrue(columns.some((column) => column.name === name));
    }
    assert.deepEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id IN (33, 34) ORDER BY migration_id`,
      [
        { migration_id: 33, name: "ProjectionThreadsSettled" },
        { migration_id: 34, name: "ProjectionThreadsSnoozed" },
      ],
    );
    yield* migrate;
  }).pipe(Effect.provide(Database)),
);

it.effect("refuses ledger holes rather than silently skipping a fork migration", () =>
  Effect.gen(function* () {
    yield* migrate;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM fork_sql_migrations WHERE migration_id = 5`;
    assert.equal((yield* Effect.exit(runForkMigrations()))._tag, "Failure");
  }).pipe(Effect.provide(Database)),
);

it.effect(
  "does not reset or rebuild the retired native-agent cache on a partial fork history",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* runForkMigrations({ toMigrationInclusive: 6 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('p', 'Project', '/fixture', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at, native_agents_json)
      VALUES ('t', 'p', 'Thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '[{"legacy":"evidence"}]')`;
      yield* runForkMigrations();
      assert.deepEqual(yield* sql`SELECT native_agents_json FROM projection_threads`, [
        { native_agents_json: '[{"legacy":"evidence"}]' },
      ]);
    }).pipe(Effect.provide(Database)),
);

it.effect("adds workspace-file columns that leave existing projects plain", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runForkMigrations({ toMigrationInclusive: 11 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('p', 'Project', '/fixture', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
    yield* runForkMigrations();
    yield* ProjectionProjectsWorkspaceFile;
    assert.deepEqual(
      yield* sql`SELECT workspace_file, workspace_folders_json FROM projection_projects`,
      [{ workspace_file: null, workspace_folders_json: null }],
    );
    assert.lengthOf(
      yield* sql`SELECT 1 FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_projection_projects_active_workspace_file'`,
      1,
    );
  }).pipe(Effect.provide(Database)),
);

it.effect.each([53, 54])(
  "keeps the upstream preview-%s ledger reconciliation before fork migrations",
  (previewId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${previewId} AND migration_id < 55`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = ${previewId} WHERE migration_id = 55`;
      yield* migrate;
      assert.deepEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id BETWEEN 53 AND 56 ORDER BY migration_id`,
        [
          { migration_id: 53, name: "PullRequestFilesViewed" },
          { migration_id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
          { migration_id: 55, name: "OrchestrationV2" },
          { migration_id: 56, name: "RemoveRedundantProjectionIndexes" },
        ],
      );
    }).pipe(Effect.provide(Database)),
);
