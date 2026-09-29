import { ModelSelection, ProjectIconOverride, ProjectScript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { recordForkImportWarning } from "./ForkImportDiagnostics.ts";

/** Sanitize only the copied V1 project baseline, preserving bad JSON for recovery. */
export const prepareForkLegacyProjects = Effect.fn("prepareForkLegacyProjects")(function* () {
  const sql = yield* SqlClient.SqlClient;
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
