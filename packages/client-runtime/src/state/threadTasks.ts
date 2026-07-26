/**
 * Thread task derivations shared by the sidebar and the mini thread window.
 *
 * Task rows are ordinary thread shells that happen to carry a parent link, so
 * everything here works off the shell list the sidebar already has.
 */
import type {
  OrchestrationMessageRole,
  OrchestrationMessageSource,
  ThreadId,
} from "@t3tools/contracts";

/** The subset of a thread shell these helpers need. */
export interface TaskLinkedThread {
  readonly id: ThreadId;
  readonly parentThreadId?: ThreadId | null | undefined;
  readonly task?:
    | {
        readonly status: "queued" | "running" | "finished" | "failed" | "cancelled";
        readonly delivery?: { readonly state: string } | null;
      }
    | null
    | undefined;
  readonly taskSummary?:
    | {
        readonly total: number;
        readonly running: number;
        readonly latestDeliveredAt: string | null;
      }
    | null
    | undefined;
}

export function isTaskThread(thread: TaskLinkedThread): boolean {
  return thread.parentThreadId != null;
}

/** Index of parent thread id → its task threads, in the order given. */
export function groupTasksByParent<T extends TaskLinkedThread>(
  threads: ReadonlyArray<T>,
): ReadonlyMap<ThreadId, ReadonlyArray<T>> {
  const byParent = new Map<ThreadId, T[]>();
  for (const thread of threads) {
    const parentThreadId = thread.parentThreadId;
    if (parentThreadId == null) continue;
    const existing = byParent.get(parentThreadId);
    if (existing === undefined) {
      byParent.set(parentThreadId, [thread]);
    } else {
      existing.push(thread);
    }
  }
  return byParent;
}

/** Threads that should appear at the top level: everything that is not a task. */
export function topLevelThreads<T extends TaskLinkedThread>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return threads.filter((thread) => !isTaskThread(thread));
}

export function runningTaskCount(tasks: ReadonlyArray<TaskLinkedThread>): number {
  return tasks.filter((task) => task.task?.status === "queued" || task.task?.status === "running")
    .length;
}

/**
 * True when a task returned results and resumed this thread since the user last
 * looked at it — the sidebar's blue dot. Never-visited counts as unread, the
 * same rule the existing completion indicator uses.
 */
export function hasUnreadTaskResults(input: {
  readonly taskSummary?: TaskLinkedThread["taskSummary"];
  readonly lastVisitedAt: string | undefined;
}): boolean {
  const deliveredAt = input.taskSummary?.latestDeliveredAt;
  if (deliveredAt == null) return false;
  if (input.lastVisitedAt === undefined) return true;
  const visited = Date.parse(input.lastVisitedAt);
  const delivered = Date.parse(deliveredAt);
  if (!Number.isFinite(visited) || !Number.isFinite(delivered)) return true;
  return visited < delivered;
}

/**
 * Default expansion for a parent's task group: open while there is something to
 * watch — work in flight, or results the user has not seen yet.
 */
export function defaultTaskGroupExpanded(input: {
  readonly tasks: ReadonlyArray<TaskLinkedThread>;
  readonly hasUnreadResults: boolean;
}): boolean {
  if (input.hasUnreadResults) return true;
  return runningTaskCount(input.tasks) > 0;
}

/**
 * Author of a projected message, deriving from role for rows persisted before
 * the `source` field existed.
 */
export function resolveOrchestrationMessageSource(message: {
  readonly role: OrchestrationMessageRole;
  readonly source?: OrchestrationMessageSource | undefined;
}): OrchestrationMessageSource {
  if (message.source !== undefined) return message.source;
  return message.role === "assistant" ? "provider" : message.role === "system" ? "system" : "user";
}

/** A wake-up message injected by a finished task, not something the user typed. */
export function isTaskResultMessage(message: {
  readonly role: OrchestrationMessageRole;
  readonly source?: OrchestrationMessageSource | undefined;
}): boolean {
  return resolveOrchestrationMessageSource(message) === "task-result";
}
