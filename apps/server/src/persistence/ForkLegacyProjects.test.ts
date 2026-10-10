import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import { reconcileBaseMigrationLedger, runForkMigrations } from "./ForkMigrations.ts";
import { ProjectStoreV2, layer as projectLayer } from "../orchestration-v2/ProjectStore.ts";

// The production order in Layers/Sqlite.ts: the fork's preparation, upstream's
// migrations, then the fork's own, which ProjectStore's columns depend on.
const migrate = reconcileBaseMigrationLedger().pipe(
  Effect.andThen(runMigrations()),
  Effect.andThen(runForkMigrations()),
);

it.effect.each(['{"not":"an-array"}', "{broken", '[{"wrong":"script"}]'])(
  "imports invalid project JSON %s with defaults and retained evidence",
  (value) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, default_model_selection_json, project_icon_json, default_thread_env_mode, created_at, updated_at)
      VALUES ('bad-project', 'Project', '/fixture', ${value}, '[]', 'false', 'nowhere', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* migrate;
      const projects = yield* ProjectStoreV2;
      const shells = yield* projects.listShells();
      assert.deepEqual(shells[0]?.scripts, []);
      assert.isNull(shells[0]?.defaultModelSelection);
      assert.isNull(shells[0]?.projectIcon);
      assert.isNull(shells[0]?.defaultThreadEnvMode);
      assert.deepEqual(
        yield* sql`SELECT original_value FROM fork_v1_import_warnings WHERE field = 'scripts_json'`,
        [{ original_value: value }],
      );
      assert.deepEqual(
        yield* sql`SELECT json_extract(payload_json, '$.scripts') AS scripts FROM orchestration_events WHERE event_id = 'migration:39:project:bad-project:baseline'`,
        [{ scripts: "[]" }],
      );
      yield* migrate;
      assert.lengthOf(yield* sql`SELECT * FROM fork_v1_import_warnings`, 4);
    }).pipe(
      Effect.provide(
        projectLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
      ),
    ),
);

// The verification's stable baseline is a V1 history at migration 35.
it.effect("repairs a malformed project in a V1 history at migration 35", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 35 });
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, default_model_selection_json, created_at, updated_at)
      VALUES ('old-project', 'Project', '/fixture', '{"not":"an-array"}', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
    yield* migrate;
    assert.equal(
      (yield* sql<{ id: number }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`)[0]
        ?.id,
      56,
    );
    const shells = yield* (yield* ProjectStoreV2).listShells();
    assert.deepEqual(shells[0]?.scripts, []);
    assert.deepEqual(
      yield* sql`SELECT json_extract(payload_json, '$.scripts') AS scripts FROM orchestration_events WHERE event_id = 'migration:39:project:old-project:baseline'`,
      [{ scripts: "[]" }],
    );
    assert.deepEqual(
      yield* sql`SELECT field, original_value FROM fork_v1_import_warnings WHERE entity_id = 'old-project'`,
      [{ field: "scripts_json", original_value: '{"not":"an-array"}' }],
    );
  }).pipe(
    Effect.provide(
      projectLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
    ),
  ),
);
