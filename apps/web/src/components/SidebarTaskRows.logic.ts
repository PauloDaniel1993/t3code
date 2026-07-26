/**
 * Presentation logic for nested task rows and the mini thread window.
 *
 * Kept separate from the components so the rules — which icon, which status
 * line, when the group opens — are testable without rendering.
 */
import type {
  OrchestrationThreadShell,
  ThreadTaskMetadata,
  ThreadTaskStatus,
} from "@t3tools/contracts";

/** The subset of a sidebar thread shell the grouping rules need. */
export interface SidebarTaskGroupingThread {
  readonly id: string;
  readonly environmentId: string;
  readonly parentThreadId?: string | null | undefined;
}

/**
 * Whether a thread renders nested under a parent rather than at the top level.
 *
 * Where the environment does not advertise `threadTasks` there is no group to
 * nest into, so a parent link is ignored and the thread stays an ordinary
 * top-level row — hiding it would lose it from the sidebar entirely.
 */
export function nestsAsTask<T extends SidebarTaskGroupingThread>(
  thread: T,
  supportsThreadTasks: (thread: T) => boolean,
): boolean {
  return thread.parentThreadId != null && supportsThreadTasks(thread);
}

/**
 * Split the visible threads into the top-level list and each parent's task
 * group. A thread appears in exactly one of the two, never both.
 */
export function groupSidebarTaskThreads<T extends SidebarTaskGroupingThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly supportsThreadTasks: (thread: T) => boolean;
  /** Scoped key builder, so grouping matches the keys rows are addressed by. */
  readonly parentKey: (task: T) => string;
  readonly compareTasks?: (left: T, right: T) => number;
}): {
  readonly topLevel: ReadonlyArray<T>;
  readonly tasksByParent: ReadonlyMap<string, ReadonlyArray<T>>;
} {
  const topLevel: T[] = [];
  const tasksByParent = new Map<string, T[]>();
  for (const thread of input.threads) {
    if (!nestsAsTask(thread, input.supportsThreadTasks)) {
      topLevel.push(thread);
      continue;
    }
    const groupKey = input.parentKey(thread);
    const existing = tasksByParent.get(groupKey);
    if (existing === undefined) {
      tasksByParent.set(groupKey, [thread]);
    } else {
      existing.push(thread);
    }
  }
  if (input.compareTasks !== undefined) {
    for (const group of tasksByParent.values()) {
      group.sort(input.compareTasks);
    }
  }
  return { topLevel, tasksByParent };
}

/**
 * The task thread's own live state, which outranks the recorded task status.
 *
 * `ThreadTaskStatus` is deliberately coarse and freezes once a result has been
 * recorded. A task thread is still an ordinary thread, though: steering it, or
 * opening it and sending a prompt, starts a new turn. The row has to read as
 * working again when that happens, or the sidebar claims a thread is done while
 * it is visibly running.
 */
export interface TaskThreadActivity {
  readonly latestTurn: Pick<
    NonNullable<OrchestrationThreadShell["latestTurn"]>,
    "state" | "requestedAt" | "startedAt" | "completedAt"
  > | null;
  readonly session: Pick<NonNullable<OrchestrationThreadShell["session"]>, "activeTurnId"> | null;
}

export function taskThreadIsWorking(activity: TaskThreadActivity | undefined): boolean {
  if (activity === undefined) return false;
  if (activity.session?.activeTurnId != null) return true;
  return activity.latestTurn?.state === "running";
}

export type TaskRowIcon = "running" | "done" | "failed" | "cancelled";

export interface TaskRowPresentation {
  readonly icon: TaskRowIcon;
  /** The ↩ marker: this task returned results and woke the parent. */
  readonly returnedToParent: boolean;
  readonly iconLabel: string;
}

export function resolveTaskRowPresentation(
  task: ThreadTaskMetadata,
  activity?: TaskThreadActivity,
): TaskRowPresentation {
  const returnedToParent = task.delivery?.state === "delivered";
  const icon: TaskRowIcon =
    taskThreadIsWorking(activity) || task.status === "queued" || task.status === "running"
      ? "running"
      : task.status === "failed"
        ? "failed"
        : task.status === "cancelled"
          ? "cancelled"
          : "done";
  return {
    icon,
    returnedToParent,
    iconLabel:
      icon === "running"
        ? "Running"
        : icon === "failed"
          ? "Failed"
          : icon === "cancelled"
            ? "Cancelled"
            : "Done",
  };
}

/**
 * How long the task has been working, and — once it settles — how long it took.
 *
 * A settled task's label is frozen: it measures start to finish, not time since
 * finishing. A number that keeps climbing after the work stopped reads as a
 * still-running task.
 */
export function formatTaskElapsedLabel(input: {
  readonly task: ThreadTaskMetadata;
  readonly activity?: TaskThreadActivity;
  readonly nowMs: number;
}): string {
  // A settled task that started a fresh turn is timed from that turn, not from
  // the original run — the label is about the work happening now.
  const working = taskThreadIsWorking(input.activity);
  const running = working || input.task.status === "queued" || input.task.status === "running";
  const turnStartedAt = working
    ? (input.activity?.latestTurn?.startedAt ?? input.activity?.latestTurn?.requestedAt ?? null)
    : null;
  const startedAtMs = Date.parse(turnStartedAt ?? input.task.startedAt ?? input.task.requestedAt);
  if (!Number.isFinite(startedAtMs)) return "";
  const endedAtMs = running
    ? input.nowMs
    : Date.parse(input.task.finishedAt ?? input.task.startedAt ?? input.task.requestedAt);
  if (!Number.isFinite(endedAtMs)) return "";
  const elapsedMs = Math.max(0, endedAtMs - startedAtMs);
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** `Working · 3m` while it runs, `Done in 8m` once it has stopped. */
export function formatTaskStatusLine(input: {
  readonly task: ThreadTaskMetadata;
  readonly activity?: TaskThreadActivity;
  readonly nowMs: number;
}): string {
  const elapsed = formatTaskElapsedLabel(input);
  if (taskThreadIsWorking(input.activity)) {
    return elapsed === "" ? "Working" : `Working · ${elapsed}`;
  }
  switch (input.task.status) {
    case "queued":
      return elapsed === "" ? "Queued" : `Queued · ${elapsed}`;
    case "running":
      return elapsed === "" ? "Working" : `Working · ${elapsed}`;
    case "failed":
      return elapsed === "" ? "Failed" : `Failed after ${elapsed}`;
    case "cancelled":
      return elapsed === "" ? "Cancelled" : `Cancelled after ${elapsed}`;
    case "finished":
      return elapsed === "" ? "Done" : `Done in ${elapsed}`;
  }
}

/** Chips shown in the mini thread window, in mockup order. */
export function resolveTaskChips(input: {
  readonly task: ThreadTaskMetadata;
  readonly modelLabel: string | null;
}): ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly tone: "creator" | "neutral" | "returned";
}> {
  const chips: Array<{ id: string; label: string; tone: "creator" | "neutral" | "returned" }> = [
    {
      id: "creator",
      label: input.task.createdBy === "agent" ? "✦ agent" : "you",
      tone: "creator",
    },
    { id: "context", label: describeContextChip(input.task), tone: "neutral" },
  ];
  if (input.modelLabel !== null) {
    chips.push({ id: "model", label: input.modelLabel, tone: "neutral" });
  }
  if (input.task.delivery?.state === "delivered") {
    chips.push({ id: "returned", label: "↩ returned · woke parent", tone: "returned" });
  }
  return chips;
}

function describeContextChip(task: ThreadTaskMetadata): string {
  const context = task.context;
  const suffix = task.contextTruncated ? " (trimmed)" : "";
  switch (context.kind) {
    case "full-thread":
      return `full thread context${suffix}`;
    case "selected-messages":
      return `${context.messageIds.length} selected ${
        context.messageIds.length === 1 ? "message" : "messages"
      }${suffix}`;
    case "none":
      return "no context";
  }
}

/**
 * What the mini window's footer offers. A task waiting on a human cannot be
 * steered inline — approval and input controls live in the full thread.
 */
export function resolveMiniWindowMode(input: {
  readonly status: ThreadTaskStatus;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}): "steer" | "blocked" {
  if (input.hasPendingApprovals || input.hasPendingUserInput) return "blocked";
  return "steer";
}

export function taskIsCancellable(
  status: ThreadTaskStatus,
  activity?: TaskThreadActivity,
): boolean {
  return taskThreadIsWorking(activity) || status === "queued" || status === "running";
}

export function taskIsRedeliverable(task: ThreadTaskMetadata): boolean {
  return task.result !== null;
}
