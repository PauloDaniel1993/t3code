import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { reconcileBaseMigrationLedger, runForkMigrations } from "./ForkMigrations.ts";
import { runMigrations } from "./Migrations.ts";

const Database = NodeSqliteClient.layer({ filename: ":memory:" });
const migrate = Effect.gen(function* () {
  yield* reconcileBaseMigrationLedger();
  yield* runMigrations();
  yield* runForkMigrations();
});

it.effect("keeps upstream and fork histories separate on fresh startup and restart", () =>
  Effect.gen(function* () {
    yield* migrate;
    const sql = yield* SqlClient.SqlClient;
    const base = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const fork = yield* sql`SELECT * FROM fork_sql_migrations ORDER BY migration_id`;
    assert.lengthOf(base, 56);
    assert.lengthOf(fork, 8);
    yield* migrate;
    assert.deepEqual(yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`, base);
    assert.deepEqual(yield* sql`SELECT * FROM fork_sql_migrations ORDER BY migration_id`, fork);
  }).pipe(Effect.provide(Database)),
);

for (const laterMigration of [false, true]) {
  it.effect(
    `repairs old base-ledger collisions${laterMigration ? " below a later migration" : " at the tip"}`,
    () =>
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
}

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

for (const previewId of [53, 54]) {
  it.effect(
    `keeps the upstream preview-${previewId} ledger reconciliation before fork migrations`,
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 55 });
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${previewId} AND migration_id < 55`;
        yield* sql`UPDATE effect_sql_migrations SET migration_id = ${previewId} WHERE migration_id = 55`;
        yield* migrate;
        assert.deepEqual(
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53 ORDER BY migration_id`,
          [
            { migration_id: 53, name: "PullRequestFilesViewed" },
            { migration_id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
            { migration_id: 55, name: "OrchestrationV2" },
            { migration_id: 56, name: "RemoveRedundantProjectionIndexes" },
          ],
        );
      }).pipe(Effect.provide(Database)),
  );
}
