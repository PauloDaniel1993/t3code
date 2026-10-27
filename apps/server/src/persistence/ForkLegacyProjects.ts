import {
  ModelSelection,
  ProjectIconOverride,
  ProjectScript,
  ThreadEnvMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { recordForkImportWarning } from "./ForkImportDiagnostics.ts";
import { runMigrations } from "./Migrations.ts";

// Preserve damaged V1 project values for recovery, then sanitize before migration 55 freezes its baseline.
// Migrate to 54 first because earlier migrations rewrite these columns; V2 baselines remain untouched.
export const prepareForkLegacyProjects = Effect.fn("prepareForkLegacyProjects")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (ledger.length === 0) return;
  const v2 = yield* sql`SELECT 1 FROM effect_sql_migrations WHERE name = 'OrchestrationV2'`;
  if (v2.length > 0) return;
  yield* runMigrations({ toMigrationInclusive: 54 });
  const fields = [
    [
      "scripts_json",
      Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(ProjectScript))),
      "[]",
    ],
    [
      "default_model_selection_json",
      Schema.decodeUnknownOption(Schema.fromJsonString(ModelSelection)),
      null,
    ],
    [
      "project_icon_json",
      Schema.decodeUnknownOption(Schema.fromJsonString(ProjectIconOverride)),
      null,
    ],
    ["default_thread_env_mode", Schema.decodeUnknownOption(ThreadEnvMode), null],
  ] as const;
  const rows = yield* sql<{
    project_id: string;
    scripts_json: string;
    default_model_selection_json: string | null;
    project_icon_json: string | null;
    default_thread_env_mode: string | null;
  }>`SELECT project_id, scripts_json, default_model_selection_json, project_icon_json,
      default_thread_env_mode FROM projection_projects`;
  for (const row of rows) {
    for (const [field, decode, fallback] of fields) {
      const raw = row[field];
      if (raw === null || decode(raw)._tag === "Some") continue;
      yield* recordForkImportWarning(
        row.project_id,
        field,
        "Invalid project value; imported with safe defaults.",
        raw,
      );
      yield* sql`UPDATE projection_projects SET ${sql(field)} = ${fallback} WHERE project_id = ${row.project_id}`;
    }
  }
});
