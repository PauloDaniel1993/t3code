/**
 * Presentation logic for nested task rows and the mini thread window.
 *
 * Kept separate from the components so the rules — which icon, which status
 * line, when the group opens — are testable without rendering.
 */
import type { ThreadTaskMetadata, ThreadTaskStatus } from "@t3tools/contracts";

export type TaskRowIcon = "running" | "done" | "failed" | "cancelled";

export interface TaskRowPresentation {
  readonly icon: TaskRowIcon;
  /** The ↩ marker: this task returned results and woke the parent. */
  readonly returnedToParent: boolean;
  readonly iconLabel: string;
}

export function resolveTaskRowPresentation(task: ThreadTaskMetadata): TaskRowPresentation {
  const returnedToParent = task.delivery?.state === "delivered";
  const icon: TaskRowIcon =
    task.status === "queued" || task.status === "running"
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
 * Elapsed label for a task row and the mini window status line: how long a
 * running task has been working, or how long ago a settled one finished.
 */
export function formatTaskElapsedLabel(input: {
  readonly task: ThreadTaskMetadata;
  readonly nowMs: number;
}): string {
  const anchor =
    input.task.status === "queued" || input.task.status === "running"
      ? (input.task.startedAt ?? input.task.requestedAt)
      : (input.task.finishedAt ?? input.task.requestedAt);
  const anchorMs = Date.parse(anchor);
  if (!Number.isFinite(anchorMs)) return "";
  const elapsedMs = Math.max(0, input.nowMs - anchorMs);
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** `Working · 3m` / `Done · 8m ago`, matching the approved mockup. */
export function formatTaskStatusLine(input: {
  readonly task: ThreadTaskMetadata;
  readonly nowMs: number;
}): string {
  const elapsed = formatTaskElapsedLabel(input);
  switch (input.task.status) {
    case "queued":
      return elapsed === "" ? "Queued" : `Queued · ${elapsed}`;
    case "running":
      return elapsed === "" ? "Working" : `Working · ${elapsed}`;
    case "failed":
      return elapsed === "" ? "Failed" : `Failed · ${elapsed} ago`;
    case "cancelled":
      return elapsed === "" ? "Cancelled" : `Cancelled · ${elapsed} ago`;
    case "finished":
      return elapsed === "" ? "Done" : `Done · ${elapsed} ago`;
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

export function taskIsCancellable(status: ThreadTaskStatus): boolean {
  return status === "queued" || status === "running";
}

export function taskIsRedeliverable(task: ThreadTaskMetadata): boolean {
  return task.result !== null;
}
