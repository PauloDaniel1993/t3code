/**
 * Provider-callable thread task tools.
 *
 * Schemas for the `tasks` MCP toolkit: what a parent thread's agent sends to
 * delegate work, and what it gets back. The calling thread is always taken from
 * the MCP invocation scope, never from a tool argument, so an agent cannot
 * create or cancel tasks on someone else's thread.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  THREAD_TASK_MAX_SELECTED_MESSAGES,
  ThreadTaskContextSpec,
  ThreadTaskCreatedBy,
  ThreadTaskOutcome,
  ThreadTaskStatus,
} from "./orchestration.ts";

export const THREAD_TASK_TITLE_MAX_CHARS = 120;
export const THREAD_TASK_TOOL_PROMPT_MAX_CHARS = 100_000;

export const ThreadTaskContextKind = Schema.Literals(["full-thread", "selected-messages", "none"]);
export type ThreadTaskContextKind = typeof ThreadTaskContextKind.Type;

export const ThreadTaskToolModelSelection = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export type ThreadTaskToolModelSelection = typeof ThreadTaskToolModelSelection.Type;

/**
 * Tool parameters are plain strings, not `TrimmedNonEmptyString`.
 *
 * `TrimmedString` is a `decodeTo` transformation, and a tool's published JSON
 * schema is generated from the *encoded* side — so every check and description
 * layered on top of it is dropped, leaving the model a bare `{type: "string"}`
 * with no bound and no explanation. Checks on a plain string survive, and the
 * dispatched `thread.task.create` command re-validates with the trimmed schema
 * anyway.
 */
const ToolText = (input: { readonly maxChars: number; readonly description: string }) =>
  Schema.String.check(Schema.isNonEmpty({ description: input.description })).check(
    Schema.isMaxLength(input.maxChars),
  );

const REASONING_TOOL_DESCRIPTION =
  "Reasoning level for the task's session, e.g. 'low', 'high', 'xhigh', 'max'. Applies to the model in `model`, or to this thread's model when `model` is omitted. Levels differ per provider and per model and some models have none — call task_models for the exact list. An unsupported value is rejected and names the valid ones.";

const MODEL_TOOL_DESCRIPTION =
  "Model for the task's own session, as an instanceId and model slug from task_models. Defaults to this thread's model when omitted. Both fields must come from the same instance — a slug from another provider is rejected.";

export const TaskCreateToolInput = Schema.Struct({
  title: ToolText({
    maxChars: THREAD_TASK_TITLE_MAX_CHARS,
    description:
      "Short label for the task, shown in the sidebar. Name the work, not the outcome — e.g. 'Audit provider handlers'.",
  }),
  prompt: ToolText({
    maxChars: THREAD_TASK_TOOL_PROMPT_MAX_CHARS,
    description:
      "The complete, self-contained brief the task runs on. It executes in its own thread, so state everything it needs and what it should report back.",
  }),
  context: ThreadTaskContextKind.annotate({
    description:
      "Which slice of this thread the task starts from: 'full-thread' for the whole conversation, 'selected-messages' for only the ids in messageIds, 'none' for the prompt alone.",
  }),
  messageIds: Schema.optional(
    Schema.Array(MessageId).check(
      Schema.isMaxLength(THREAD_TASK_MAX_SELECTED_MESSAGES, {
        description: `Message ids to carry over, required and non-empty when context is 'selected-messages' and ignored otherwise. At most ${THREAD_TASK_MAX_SELECTED_MESSAGES}.`,
      }),
    ),
  ).annotate({
    description: `Message ids to carry over, required and non-empty when context is 'selected-messages' and ignored otherwise. At most ${THREAD_TASK_MAX_SELECTED_MESSAGES}.`,
  }),
  model: Schema.optional(
    ThreadTaskToolModelSelection.annotate({ description: MODEL_TOOL_DESCRIPTION }),
  ).annotate({ description: MODEL_TOOL_DESCRIPTION }),
  reasoning: Schema.optional(
    // Plain string, not an enum: the levels a model offers come from the live
    // provider snapshot and differ per driver and per model, so there is no
    // fixed set to publish. The handler matches the value against the target
    // model's own levels and names the valid ones when it does not fit.
    Schema.String.check(
      Schema.isNonEmpty({
        description: REASONING_TOOL_DESCRIPTION,
      }),
    ),
  ).annotate({ description: REASONING_TOOL_DESCRIPTION }),
});
export type TaskCreateToolInput = typeof TaskCreateToolInput.Type;

/**
 * The filter exists partly to keep the published schema a real object: an
 * empty `Schema.Struct({})` degenerates to `{"anyOf":[{"type":"object"},
 * {"type":"array"}]}`, which providers that demand a top-level object schema
 * reject.
 */
export const TaskListToolInput = Schema.Struct({
  status: Schema.optional(
    ThreadTaskStatus.annotate({
      description: "Return only tasks in this state. Omit to list every task this thread owns.",
    }),
  ).annotate({
    description: "Return only tasks in this state. Omit to list every task this thread owns.",
  }),
});
export type TaskListToolInput = typeof TaskListToolInput.Type;

export const TaskCancelToolInput = Schema.Struct({
  // Plain string for the same reason as `ToolText`: a branded id is built on
  // `TrimmedString`, whose transformation drops the description on the way to
  // the published schema. The handler brands it back.
  threadId: Schema.String.check(
    Schema.isNonEmpty({
      description:
        "Thread id of the task to cancel, as returned by task_create or task_list. Must be a task this thread owns.",
    }),
  ),
});
export type TaskCancelToolInput = typeof TaskCancelToolInput.Type;

const TASK_MODELS_INSTANCE_FILTER_DESCRIPTION =
  "Return only this provider instance's models. Omit to list every instance this machine has configured.";

export const TaskModelsToolInput = Schema.Struct({
  // Same reason as `TaskListToolInput`: the filter keeps the published schema a
  // real object, and it keeps the result small on machines with many providers.
  instanceId: Schema.optional(
    Schema.String.check(
      Schema.isNonEmpty({ description: TASK_MODELS_INSTANCE_FILTER_DESCRIPTION }),
    ),
  ).annotate({ description: TASK_MODELS_INSTANCE_FILTER_DESCRIPTION }),
});
export type TaskModelsToolInput = typeof TaskModelsToolInput.Type;

export const ThreadTaskReasoningLevel = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  /** The level the model runs at when `reasoning` is omitted. */
  isDefault: Schema.Boolean,
  /**
   * True when selecting this level works by prefixing the task's prompt rather
   * than by configuring the session — Claude's `ultrathink` is the live case.
   * It still runs the task; it just costs prompt text instead of a setting.
   */
  promptInjected: Schema.Boolean,
});
export type ThreadTaskReasoningLevel = typeof ThreadTaskReasoningLevel.Type;

export const ThreadTaskModelInfo = Schema.Struct({
  /** Pass this verbatim as `model.model` on task_create. */
  model: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  isDefault: Schema.Boolean,
  /** Empty when this model has no reasoning level; passing `reasoning` then fails. */
  reasoningLevels: Schema.Array(ThreadTaskReasoningLevel),
});
export type ThreadTaskModelInfo = typeof ThreadTaskModelInfo.Type;

export const ThreadTaskProviderInstanceInfo = Schema.Struct({
  /** Pass this verbatim as `model.instanceId` on task_create. */
  instanceId: ProviderInstanceId,
  provider: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  /**
   * False when the instance is configured but not currently usable (not
   * installed, signed out, disabled). A task started on one will fail.
   */
  ready: Schema.Boolean,
  models: Schema.Array(ThreadTaskModelInfo),
});
export type ThreadTaskProviderInstanceInfo = typeof ThreadTaskProviderInstanceInfo.Type;

export const ThreadTaskCurrentModel = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  /** The calling thread's reasoning level, or null when its model has none. */
  reasoning: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadTaskCurrentModel = typeof ThreadTaskCurrentModel.Type;

export const TaskModelsToolOutput = Schema.Struct({
  /** What a task inherits when `model` and `reasoning` are both omitted. */
  current: ThreadTaskCurrentModel,
  instances: Schema.Array(ThreadTaskProviderInstanceInfo),
});
export type TaskModelsToolOutput = typeof TaskModelsToolOutput.Type;

export const ThreadTaskToolResult = Schema.Struct({
  outcome: ThreadTaskOutcome,
  summary: Schema.String,
  summaryTruncated: Schema.Boolean,
  completedAt: IsoDateTime,
});

export const ThreadTaskToolSummary = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  status: ThreadTaskStatus,
  createdBy: ThreadTaskCreatedBy,
  context: ThreadTaskContextSpec,
  createdAt: IsoDateTime,
  /** Present once the task has finished; also delivered into this thread. */
  result: Schema.NullOr(ThreadTaskToolResult),
});
export type ThreadTaskToolSummary = typeof ThreadTaskToolSummary.Type;

export const TaskListToolOutput = Schema.Struct({
  tasks: Schema.Array(ThreadTaskToolSummary),
});
export type TaskListToolOutput = typeof TaskListToolOutput.Type;

export const ThreadTaskToolErrorReason = Schema.Literals([
  "capability-unavailable",
  "nesting-depth",
  "parent-ineligible",
  "concurrency-cap",
  "lifetime-cap",
  "invalid-context",
  "invalid-model",
  "task-not-found",
  "dispatch-failed",
]);
export type ThreadTaskToolErrorReason = typeof ThreadTaskToolErrorReason.Type;

/**
 * Structured failure so a delegating agent can adapt — wait for a slot, pick a
 * different model, drop the context — instead of blindly retrying.
 */
export class ThreadTaskToolError extends Schema.TaggedErrorClass<ThreadTaskToolError>()(
  "ThreadTaskToolError",
  {
    reason: ThreadTaskToolErrorReason,
    message: TrimmedNonEmptyString,
  },
) {}
