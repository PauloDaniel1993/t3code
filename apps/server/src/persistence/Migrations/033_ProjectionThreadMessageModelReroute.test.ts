import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("033_ProjectionThreadMessageModelReroute", (it) => {
  it.effect("adds the column without touching existing message rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
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

      yield* runMigrations({ toMigrationInclusive: 33 });

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id = 33
      `;
      assert.deepStrictEqual(migrations, [
        {
          migration_id: 33,
          name: "ProjectionThreadMessageModelReroute",
        },
      ]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      assert.ok(columns.some((column) => column.name === "model_reroute_json"));

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
