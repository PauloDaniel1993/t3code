import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  OrchestrationV2ThreadWorkspaceFolder,
  OrchestrationV2ThreadWorktree,
} from "./orchestrationV2.ts";

/** A thread's frozen folder binding, with availability checked at inspection time. */
export const WorkspaceMcpBinding = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  workspaceFile: Schema.NullOr(TrimmedNonEmptyString).annotate({
    description:
      "The project's currently linked workspace file; the thread's frozen folder snapshot may differ.",
  }),
  folders: Schema.Array(
    Schema.Struct({
      ...OrchestrationV2ThreadWorkspaceFolder.fields,
      availability: Schema.Literals(["available", "unavailable"]),
      effectivePath: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
  worktrees: Schema.optional(Schema.Array(OrchestrationV2ThreadWorktree)),
});
export type WorkspaceMcpBinding = typeof WorkspaceMcpBinding.Type;
