import { ModelSelection, ProjectIconOverride, ProjectScript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { recordForkImportWarning } from "./ForkImportDiagnostics.ts";

/**
 * Sanitize only the copied V1 project baseline, preserving bad JSON for recovery.
 * Upstream's migration 055 turns each project row into an immutable baseline
 * event, so this runs just before upstream's migrations. It only acts on a V1
 * database already at migration 54: earlier migrations still rewrite these
 * columns (canonical model selections, the icon column), and after 055 the
 * baseline exists.
 */
export const prepareForkLegacyProjects = Effect.fn("prepareForkLegacyProjects")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (ledger.length === 0) return;
  const ready = yield* sql`
    SELECT 1 FROM effect_sql_migrations
    WHERE migration_id = 54 AND name = 'ProjectionThreadsAutoSettleDisabledAt'
      AND NOT EXISTS (SELECT 1 FROM effect_sql_migrations WHERE name = 'OrchestrationV2')
  `;
  if (ready.length === 0) return;
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
  ] as const;
  const rows = yield* sql<{
    project_id: string;
    scripts_json: string;
    default_model_selection_json: string | null;
    project_icon_json: string | null;
  }>`SELECT project_id, scripts_json, default_model_selection_json, project_icon_json FROM projection_projects`;
  for (const row of rows) {
    for (const [field, decode, fallback] of fields) {
      const raw = row[field];
      if (raw === null || decode(raw)._tag === "Some") continue;
      yield* recordForkImportWarning(
        row.project_id,
        field,
        "Invalid project JSON; imported with safe defaults.",
        raw,
      );
      yield* sql`UPDATE projection_projects SET ${sql(field)} = ${fallback} WHERE project_id = ${row.project_id}`;
    }
  }
});
