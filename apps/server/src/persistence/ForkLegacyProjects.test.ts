import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import { ProjectStoreV2, layer as projectLayer } from "../orchestration-v2/ProjectStore.ts";

for (const value of ['{"not":"an-array"}', "{broken", '[{"wrong":"script"}]']) {
  it.effect(`imports invalid project JSON ${value} with defaults and retained evidence`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, default_model_selection_json, project_icon_json, created_at, updated_at)
      VALUES ('bad-project', 'Project', '/fixture', ${value}, '[]', 'false', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* runMigrations();
      const projects = yield* ProjectStoreV2;
      const shells = yield* projects.listShells();
      assert.deepEqual(shells[0]?.scripts, []);
      assert.isNull(shells[0]?.defaultModelSelection);
      assert.isNull(shells[0]?.projectIcon);
      assert.deepEqual(
        yield* sql`SELECT original_value FROM fork_v1_import_warnings WHERE field = 'scripts_json'`,
        [{ original_value: value }],
      );
      assert.deepEqual(
        yield* sql`SELECT json_extract(payload_json, '$.scripts') AS scripts FROM orchestration_events WHERE event_id = 'migration:39:project:bad-project:baseline'`,
        [{ scripts: "[]" }],
      );
      yield* runMigrations();
      assert.lengthOf(yield* sql`SELECT * FROM fork_v1_import_warnings`, 3);
    }).pipe(
      Effect.provide(
        projectLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
      ),
    ),
  );
}
