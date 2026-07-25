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

export const TaskCreateToolInput = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_TASK_TITLE_MAX_CHARS)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_TASK_TOOL_PROMPT_MAX_CHARS)),
  /**
   * Which slice of this thread the task starts from. `selected-messages`
   * requires `messageIds`.
   */
  context: ThreadTaskContextKind,
  messageIds: Schema.optional(
    Schema.Array(MessageId).check(Schema.isMaxLength(THREAD_TASK_MAX_SELECTED_MESSAGES)),
  ),
  /** Defaults to this thread's own model when omitted. */
  model: Schema.optional(ThreadTaskToolModelSelection),
});
export type TaskCreateToolInput = typeof TaskCreateToolInput.Type;

export const TaskListToolInput = Schema.Struct({});
export type TaskListToolInput = typeof TaskListToolInput.Type;

export const TaskCancelToolInput = Schema.Struct({
  threadId: ThreadId,
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
