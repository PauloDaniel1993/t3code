/**
 * Parses the `task.created` / `task.finished` activity payloads the server
 * appends to a *parent* thread into the shape its timeline rows render from.
 *
 * The parent does not own the task thread's aggregate, so these activity rows
 * are how task lifecycle reaches the parent transcript. Payloads are `unknown`
 * on the wire, and older rows may predate fields, so every field is validated
 * rather than asserted.
 */
import type { OrchestrationThreadActivity, ThreadTaskOutcome } from "@t3tools/contracts";

export const THREAD_TASK_ACTIVITY_KINDS = ["task.created", "task.finished"] as const;
export type ThreadTaskActivityKind = (typeof THREAD_TASK_ACTIVITY_KINDS)[number];

export interface ThreadTaskCreatedActivity {
  readonly kind: "task.created";
  readonly taskThreadId: string;
  readonly title: string;
  readonly createdBy: "agent" | "user";
  readonly contextLabel: string | null;
}

export interface ThreadTaskFinishedActivity {
  readonly kind: "task.finished";
  readonly taskThreadId: string;
  readonly title: string;
  readonly outcome: ThreadTaskOutcome;
  /** The task's returned text, already bounded server-side. */
  readonly summary: string;
  readonly summaryTruncated: boolean;
  readonly delivered: boolean;
  /** Why the parent was not woken, when it wasn't. */
  readonly skipReason: string | null;
}

export type ThreadTaskActivity = ThreadTaskCreatedActivity | ThreadTaskFinishedActivity;

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function isThreadTaskActivityKind(kind: string): kind is ThreadTaskActivityKind {
  return kind === "task.created" || kind === "task.finished";
}

export function parseThreadTaskActivity(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): ThreadTaskActivity | null {
  if (!isThreadTaskActivityKind(activity.kind)) return null;
  if (typeof activity.payload !== "object" || activity.payload === null) return null;
  const payload = activity.payload as Record<string, unknown>;

  const taskThreadId = readString(payload, "taskThreadId");
  const title = readString(payload, "title");
  if (taskThreadId === null || title === null) return null;

  if (activity.kind === "task.created") {
    const createdBy = payload.createdBy === "agent" ? "agent" : "user";
    return {
      kind: "task.created",
      taskThreadId,
      title,
      createdBy,
      contextLabel: readString(payload, "contextLabel"),
    };
  }

  const outcome =
    payload.outcome === "failed"
      ? "failed"
      : payload.outcome === "cancelled"
        ? "cancelled"
        : "succeeded";
  return {
    kind: "task.finished",
    taskThreadId,
    title,
    outcome,
    summary: readString(payload, "summary") ?? "",
    summaryTruncated: payload.summaryTruncated === true,
    delivered: payload.deliveryState === "delivered",
    skipReason: readString(payload, "deliverySkipReason"),
  };
}

/**
 * The wake-up row's sentence. A skipped delivery must not claim the thread
 * resumed — that would be a lie the user can act on.
 */
export function describeThreadTaskFinished(activity: ThreadTaskFinishedActivity): string {
  const outcomeText =
    activity.outcome === "failed"
      ? "failed"
      : activity.outcome === "cancelled"
        ? "was cancelled"
        : "finished";
  if (!activity.delivered) {
    const reason =
      activity.skipReason === null ? "" : ` (${humanizeSkipReason(activity.skipReason)})`;
    return `Task ${outcomeText} · results were not delivered${reason}.`;
  }
  return `Task ${outcomeText}. Main thread resumed.`;
}

function humanizeSkipReason(reason: string): string {
  switch (reason) {
    case "parent-missing":
      return "this thread could not be found";
    case "parent-deleted":
      return "this thread was deleted";
    case "parent-archived":
      return "this thread was archived";
    case "task-archived":
      return "the task was archived";
    case "task-deleted":
      return "the task was deleted";
    case "dispatch-failed":
      return "the wake-up could not be sent";
    default:
      return reason;
  }
}

/** `Agent created task` / `You created task`, matching the approved mockup. */
export function describeThreadTaskCreated(activity: ThreadTaskCreatedActivity): string {
  return activity.createdBy === "agent" ? "Agent created task" : "You created task";
}
