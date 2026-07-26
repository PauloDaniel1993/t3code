/**
 * Thread task domain helpers.
 *
 * A task is a full thread owned by a parent thread. This module holds the pure
 * decisions that the decider and the task lifecycle reactor share: eligibility,
 * caps, context materialization, result bounding, and the deterministic wake-up
 * wrapper injected into the parent.
 *
 * Everything here is deliberately pure — no Effect, no services — so replay and
 * tests exercise the same functions the runtime does.
 */
import {
  THREAD_TASK_CONTEXT_MAX_CHARS,
  THREAD_TASK_MAX_RUNNING,
  THREAD_TASK_MAX_TOTAL,
  THREAD_TASK_RESULT_SUMMARY_MAX_CHARS,
  type ChatAttachment,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ThreadTaskContextSpec,
  type ThreadTaskMetadata,
  type ThreadTaskOutcome,
  type ThreadId,
} from "@t3tools/contracts";

/** A thread is a task when it carries a parent link. */
export function isTaskThread(thread: {
  readonly parentThreadId?: ThreadId | null | undefined;
}): boolean {
  return thread.parentThreadId != null;
}

export interface ParentTaskCounts {
  /** Non-deleted tasks owned by the parent. */
  readonly total: number;
  /** Tasks in `queued` or `running`. */
  readonly running: number;
  /** Every task ever created under the parent, including deleted ones. */
  readonly lifetime: number;
}

export function countParentTasks(
  threads: ReadonlyArray<
    Pick<OrchestrationThread, "parentThreadId" | "task" | "deletedAt"> & { readonly id: ThreadId }
  >,
  parentThreadId: ThreadId,
): ParentTaskCounts {
  let total = 0;
  let running = 0;
  let lifetime = 0;
  for (const thread of threads) {
    if (thread.parentThreadId !== parentThreadId) continue;
    lifetime += 1;
    if (thread.deletedAt !== null) continue;
    total += 1;
    const status = thread.task?.status;
    if (status === "queued" || status === "running") {
      running += 1;
    }
  }
  return { total, running, lifetime };
}

export type ThreadTaskCreateRejection =
  | { readonly reason: "parent-missing"; readonly detail: string }
  | { readonly reason: "parent-ineligible"; readonly detail: string }
  | { readonly reason: "nesting-depth"; readonly detail: string }
  | { readonly reason: "concurrency-cap"; readonly detail: string }
  | { readonly reason: "lifetime-cap"; readonly detail: string }
  | { readonly reason: "invalid-context"; readonly detail: string };

/**
 * Eligibility for creating a task under `parent`. Provider readiness is checked
 * separately, where the provider registry is available.
 */
export function checkTaskCreateEligibility(input: {
  readonly parent:
    | (Pick<OrchestrationThread, "parentThreadId" | "deletedAt" | "archivedAt" | "messages"> & {
        readonly id: ThreadId;
      })
    | undefined;
  readonly parentThreadId: ThreadId;
  readonly counts: ParentTaskCounts;
  readonly context: ThreadTaskContextSpec;
}): ThreadTaskCreateRejection | null {
  const { parent, parentThreadId, counts, context } = input;
  if (parent === undefined) {
    return {
      reason: "parent-missing",
      detail: `Parent thread '${parentThreadId}' does not exist.`,
    };
  }
  if (parent.deletedAt !== null) {
    return {
      reason: "parent-ineligible",
      detail: `Parent thread '${parentThreadId}' is deleted.`,
    };
  }
  if (parent.archivedAt !== null) {
    return {
      reason: "parent-ineligible",
      detail: `Parent thread '${parentThreadId}' is archived and cannot own new tasks.`,
    };
  }
  if (parent.parentThreadId != null) {
    return {
      reason: "nesting-depth",
      detail: `Thread '${parentThreadId}' is itself a task. Tasks are limited to one level of nesting.`,
    };
  }
  if (counts.running >= THREAD_TASK_MAX_RUNNING) {
    return {
      reason: "concurrency-cap",
      detail: `Thread '${parentThreadId}' already has ${counts.running} tasks in flight (limit ${THREAD_TASK_MAX_RUNNING}). Wait for one to finish or cancel it.`,
    };
  }
  if (counts.lifetime >= THREAD_TASK_MAX_TOTAL) {
    return {
      reason: "lifetime-cap",
      detail: `Thread '${parentThreadId}' has created ${counts.lifetime} tasks (limit ${THREAD_TASK_MAX_TOTAL}).`,
    };
  }
  if (context.kind === "selected-messages") {
    const available = new Set(parent.messages.map((message) => message.id));
    const missing = context.messageIds.filter((id) => !available.has(id));
    if (missing.length > 0) {
      return {
        reason: "invalid-context",
        detail: `Messages not found in thread '${parentThreadId}': ${missing.join(", ")}.`,
      };
    }
  }
  return null;
}

/**
 * Messages eligible to become task context. Streaming assistant output is still
 * being written, and `task-result` messages are wake-ups from sibling tasks
 * rather than conversation — neither belongs in a task's starting context.
 */
function isContextEligible(message: OrchestrationMessage): boolean {
  if (message.streaming) return false;
  if (message.source === "task-result") return false;
  return message.text.trim().length > 0 || (message.attachments?.length ?? 0) > 0;
}

function describeAttachments(attachments: ReadonlyArray<ChatAttachment> | undefined): string {
  if (attachments === undefined || attachments.length === 0) return "";
  const parts = attachments.map(
    (attachment) => `${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
  );
  return `\n[attachments: ${parts.join("; ")}]`;
}

function renderContextMessage(message: OrchestrationMessage): string {
  const role =
    message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "system";
  return `<message role="${role}">\n${message.text}${describeAttachments(message.attachments)}\n</message>`;
}

export interface MaterializedTaskPrompt {
  readonly text: string;
  readonly contextTruncated: boolean;
}

/**
 * Render the task's first user message: a delimited context block (if any)
 * followed by the task prompt.
 *
 * The context is resolved once, here, so a task never sees parent messages
 * written after it started. When the block exceeds the budget, the oldest
 * messages drop first — recent turns are what a delegated task needs — and the
 * prompt itself is never trimmed.
 */
export function materializeTaskPrompt(input: {
  readonly parentMessages: ReadonlyArray<OrchestrationMessage>;
  readonly context: ThreadTaskContextSpec;
  readonly prompt: string;
  readonly parentTitle: string;
}): MaterializedTaskPrompt {
  const { context, prompt, parentTitle } = input;
  if (context.kind === "none") {
    return { text: prompt, contextTruncated: false };
  }

  const selected =
    context.kind === "full-thread"
      ? input.parentMessages.filter(isContextEligible)
      : (() => {
          const wanted = new Set<string>(context.messageIds);
          return input.parentMessages.filter(
            (message) => wanted.has(message.id) && isContextEligible(message),
          );
        })();

  if (selected.length === 0) {
    return { text: prompt, contextTruncated: false };
  }

  const rendered = selected.map(renderContextMessage);
  let truncated = false;
  let budget = THREAD_TASK_CONTEXT_MAX_CHARS;
  const kept: string[] = [];
  // Walk newest-first so trimming drops the oldest messages.
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const entry = rendered[index] ?? "";
    if (entry.length + 1 > budget) {
      truncated = true;
      break;
    }
    budget -= entry.length + 1;
    kept.unshift(entry);
  }

  if (kept.length === 0) {
    return { text: prompt, contextTruncated: true };
  }

  const header =
    context.kind === "full-thread"
      ? `Context from the parent thread "${parentTitle}"${truncated ? " (older messages omitted)" : ""}:`
      : `Selected context from the parent thread "${parentTitle}"${truncated ? " (some messages omitted)" : ""}:`;

  return {
    text: `${header}\n\n<parent-thread-context>\n${kept.join("\n")}\n</parent-thread-context>\n\n${prompt}`,
    contextTruncated: truncated,
  };
}

export interface BoundedTaskSummary {
  readonly summary: string;
  readonly summaryTruncated: boolean;
}

/**
 * Bound a task's final assistant text for delivery. The tail is kept rather
 * than the head: conclusions live at the end of an agent's answer, and the full
 * text is one click away in the task thread.
 */
export function boundTaskResultSummary(text: string): BoundedTaskSummary {
  const trimmed = text.trim();
  if (trimmed.length <= THREAD_TASK_RESULT_SUMMARY_MAX_CHARS) {
    return { summary: trimmed, summaryTruncated: false };
  }
  return {
    summary: trimmed.slice(trimmed.length - THREAD_TASK_RESULT_SUMMARY_MAX_CHARS),
    summaryTruncated: true,
  };
}

/**
 * The deterministic wrapper injected into the parent as a `task-result`
 * message. It names the task, restates what the task was asked to do (the
 * parent's agent may have created it many turns ago), and carries the result.
 */
export function buildTaskWakeMessageText(input: {
  readonly title: string;
  readonly prompt: string;
  readonly outcome: ThreadTaskOutcome;
  readonly summary: string;
  readonly summaryTruncated: boolean;
  readonly taskThreadId: ThreadId;
}): string {
  const outcomeLine =
    input.outcome === "succeeded"
      ? "finished"
      : input.outcome === "failed"
        ? "failed"
        : "was cancelled";
  const lines = [
    `A task you delegated ${outcomeLine}.`,
    "",
    `Task: ${input.title}`,
    `Task thread: ${input.taskThreadId}`,
    "",
    "What the task was asked to do:",
    input.prompt,
    "",
    input.outcome === "succeeded" ? "What it returned:" : "What happened:",
    input.summary.length > 0 ? input.summary : "(no output)",
  ];
  if (input.summaryTruncated) {
    lines.push("", "(truncated — open the task thread for the full output)");
  }
  lines.push("", "Continue the work in this thread using this result.");
  return lines.join("\n");
}

/** Short, human-facing label for the parent's timeline rows. */
export function describeTaskContext(context: ThreadTaskContextSpec): string {
  switch (context.kind) {
    case "full-thread":
      return "full thread context";
    case "selected-messages":
      return `${context.messageIds.length} selected ${context.messageIds.length === 1 ? "message" : "messages"}`;
    case "none":
      return "no context";
  }
}

/**
 * Whether a task thread has settled and its result should be recorded: it ran
 * at least one turn, nothing is running now, and nothing is waiting on a human.
 * A turn that ends awaiting approval or input is not finished work.
 */
export function taskThreadIsSettled(thread: {
  readonly latestTurn: OrchestrationThread["latestTurn"];
  readonly session: OrchestrationThread["session"];
  readonly hasOpenBlockingRequest: boolean;
}): boolean {
  const latestTurn = thread.latestTurn;
  if (latestTurn === null) return false;
  if (latestTurn.state === "running") return false;
  if (thread.hasOpenBlockingRequest) return false;
  if (thread.session?.activeTurnId != null) return false;
  return true;
}

/** Outcome implied by a settled task thread's terminal turn state. */
export function taskOutcomeForTurnState(
  state: NonNullable<OrchestrationThread["latestTurn"]>["state"],
): ThreadTaskOutcome {
  return state === "error" ? "failed" : state === "interrupted" ? "cancelled" : "succeeded";
}

/** A task is armed for delivery until a result has been recorded for it. */
export function taskIsArmed(task: ThreadTaskMetadata | null | undefined): boolean {
  if (task == null) return false;
  if (task.status === "cancelled") return false;
  return task.result === null;
}
