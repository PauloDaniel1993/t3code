import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestratorMcpTaskCancelInput, TASK_TITLE_MAX_LENGTH } from "./orchestratorMcp.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ForkTaskStatus = Schema.Literals([
  "queued",
  "running",
  "finished",
  "failed",
  "cancelled",
]);
export type ForkTaskStatus = typeof ForkTaskStatus.Type;

// Keep the fork's task-tool inputs, independently of V2's native delegation API.
export const ForkTaskCreateInput = Schema.Struct({
  title: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(TASK_TITLE_MAX_LENGTH)),
  prompt: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100_000)),
  context: Schema.Literals(["full-thread", "selected-messages", "none"]).annotate({
    description: "Only 'none' is supported on V2; conversation slices return an explicit error.",
  }),
  messageIds: Schema.optional(Schema.Array(MessageId).check(Schema.isMaxLength(100))),
  model: Schema.optional(
    Schema.Struct({ instanceId: ProviderInstanceId, model: TrimmedNonEmptyString }),
  ),
  reasoning: Schema.optional(Schema.String.check(Schema.isNonEmpty())).annotate({
    description: "A reasoning level advertised by task_models for the selected model.",
  }),
  clientRequestId: OrchestratorMcpTaskCancelInput.fields.clientRequestId,
});
export type ForkTaskCreateInput = typeof ForkTaskCreateInput.Type;

export const ForkTaskModelsInput = Schema.Struct({
  instanceId: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
});
export type ForkTaskModelsInput = typeof ForkTaskModelsInput.Type;

export const ForkTaskModelsResult = Schema.Struct({
  current: Schema.Struct({
    instanceId: ProviderInstanceId,
    model: Schema.String,
    reasoning: Schema.NullOr(Schema.String),
  }),
  instances: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      provider: Schema.String,
      displayName: Schema.String,
      ready: Schema.Boolean,
      models: Schema.Array(
        Schema.Struct({
          model: Schema.String,
          name: Schema.String,
          isDefault: Schema.Boolean,
          reasoningLevels: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              label: Schema.String,
              isDefault: Schema.Boolean,
              promptInjected: Schema.Boolean,
            }),
          ),
        }),
      ),
    }),
  ),
});
export type ForkTaskModelsResult = typeof ForkTaskModelsResult.Type;

// One object-root schema keeps V2's taskId calls working beside fork threadId calls.
export const ForkTaskCancelInput = Schema.Struct({
  ...OrchestratorMcpTaskCancelInput.fields,
  taskId: Schema.optional(NodeId),
  threadId: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
}).check(Schema.makeFilter((input) => input.taskId !== undefined || input.threadId !== undefined));
export type ForkTaskCancelInput = typeof ForkTaskCancelInput.Type;

export const ForkTaskResult = Schema.Struct({
  outcome: Schema.Literals(["succeeded", "failed", "cancelled"]),
  summary: Schema.String,
  summaryTruncated: Schema.Boolean,
  summaryChars: NonNegativeInt,
  completedAt: IsoDateTime,
});

export const ForkTaskSummary = Schema.Struct({
  threadId: ThreadId,
  taskId: NodeId,
  title: Schema.String,
  status: ForkTaskStatus,
  createdBy: Schema.Literals(["agent", "user"]),
  context: Schema.Struct({ kind: Schema.Literal("none") }),
  createdAt: IsoDateTime,
  result: Schema.NullOr(ForkTaskResult),
});
export type ForkTaskSummary = typeof ForkTaskSummary.Type;

export const OrchestratorMcpTaskListInput = Schema.Struct({
  status: Schema.optional(ForkTaskStatus),
  limit: Schema.optional(PositiveInt).annotate({
    description:
      "Maximum matching tasks to return; omitted means as many as the response budget allows.",
  }),
  cursor: Schema.optional(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8_000)),
  ).annotate({
    description: "Opaque nextCursor from task_list; continue until null.",
  }),
});
export type OrchestratorMcpTaskListInput = typeof OrchestratorMcpTaskListInput.Type;

export const OrchestratorMcpTaskListResult = Schema.Struct({
  parentThreadId: ThreadId,
  tasks: Schema.Array(
    Schema.Struct({
      ...ForkTaskSummary.fields,
      status: Schema.Union([ForkTaskStatus, Schema.Literal("unreadable")]),
      workState: Schema.optional(
        Schema.Literals(["working", "waiting_for_children", "result_available"]),
      ),
      hasPendingChildRuns: Schema.optional(Schema.Boolean),
      latestTerminalRunId: Schema.optional(RunId),
      latestTerminalResult: Schema.optional(
        Schema.Struct({
          outcome: ForkTaskResult.fields.outcome,
          summary: ForkTaskResult.fields.summary,
          summaryTruncated: ForkTaskResult.fields.summaryTruncated,
          summaryChars: ForkTaskResult.fields.summaryChars,
        }),
      ),
      error: Schema.optional(Schema.String),
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
export type OrchestratorMcpTaskListResult = typeof OrchestratorMcpTaskListResult.Type;
