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
    ThreadTaskToolModelSelection.annotate({
      description:
        "Model for the task's own session. Defaults to this thread's model when omitted.",
    }),
  ).annotate({
    description: "Model for the task's own session. Defaults to this thread's model when omitted.",
  }),
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
