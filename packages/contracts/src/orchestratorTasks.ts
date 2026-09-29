import * as Schema from "effect/Schema";

import { NodeId, PositiveInt, ThreadId } from "./baseSchemas.ts";
import { OrchestratorMcpDelegateTaskResult } from "./orchestratorMcp.ts";

export const OrchestratorMcpTaskListInput = Schema.Struct({
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))).annotate({
    description: "Maximum tasks per page; defaults to 50. This does not limit task creation.",
  }),
  cursor: Schema.optional(NodeId).annotate({
    description: "Continue after the nextCursor returned by the previous task_list call.",
  }),
});
export type OrchestratorMcpTaskListInput = typeof OrchestratorMcpTaskListInput.Type;

export const OrchestratorMcpTaskListResult = Schema.Struct({
  parentThreadId: ThreadId,
  tasks: Schema.Array(
    Schema.Struct({
      ...OrchestratorMcpDelegateTaskResult.fields,
      title: Schema.NullOr(Schema.String),
    }),
  ),
  nextCursor: Schema.NullOr(NodeId),
});
export type OrchestratorMcpTaskListResult = typeof OrchestratorMcpTaskListResult.Type;
