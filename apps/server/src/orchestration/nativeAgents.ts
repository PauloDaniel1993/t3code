/**
 * In-session agent derivation.
 *
 * A provider's own subagents (Claude Code's Task tool and friends) reach T3
 * Code only as `task.started` / `task.progress` / `task.completed` activities on
 * the thread that spawned them. This module folds those activities back into one
 * row per agent so the sidebar can show them next to real thread tasks.
 *
 * Everything here is deliberately pure — no Effect, no services — so replay, the
 * projection pipeline, and tests all exercise the same function.
 *
 * Two things it deliberately does not do: invent data the activities never
 * carried (a missing counter stays missing rather than becoming zero), and keep
 * history forever. A long-lived thread accumulates hundreds of these, while the
 * sidebar only ever wants the live picture — see `selectVisibleNativeAgents`.
 */
import type {
  OrchestrationThreadActivity,
  ThreadNativeAgent,
  ThreadNativeAgentStatus,
  ThreadNativeAgentUsage,
  TurnId,
} from "@t3tools/contracts";

/** Activity kinds this module folds. Anything else is ignored by `deriveNativeAgents`. */
const NATIVE_AGENT_ACTIVITY_KINDS = new Set(["task.started", "task.progress", "task.completed"]);

export function isNativeAgentActivityKind(kind: string): boolean {
  return NATIVE_AGENT_ACTIVITY_KINDS.has(kind);
}

/**
 * How many finished agents to retain once their turn is over. Running agents are
 * never dropped — a row vanishing while its work continues is worse than a long
 * list — so this only bounds completed history.
 */
export const NATIVE_AGENT_HISTORY_LIMIT = 12;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function readUsage(value: unknown): ThreadNativeAgentUsage | undefined {
  const record = asRecord(value);
  if (record === null) return undefined;
  const totalTokens = readCount(record.totalTokens);
  const toolUses = readCount(record.toolUses);
  const durationMs = readCount(record.durationMs);
  if (totalTokens === undefined && toolUses === undefined && durationMs === undefined) {
    return undefined;
  }
  return {
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(toolUses === undefined ? {} : { toolUses }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

/** `task.completed` reports the provider's own vocabulary; map it onto ours. */
function statusForCompletion(value: unknown): ThreadNativeAgentStatus {
  return value === "failed" ? "failed" : "finished";
}

interface Draft {
  taskId: string;
  turnId: TurnId | null;
  status: ThreadNativeAgentStatus;
  description?: string;
  subagentType?: string;
  prompt?: string;
  startedAt: string;
  updatedAt: string;
  progressSummary?: string;
  resultSummary?: string;
  errorMessage?: string;
  lastToolName?: string;
  usage?: ThreadNativeAgentUsage;
  retryOfTaskId?: string;
  retriedByTaskId?: string;
}

/**
 * Fold a thread's activities into one entry per in-session agent, in the order
 * they started.
 *
 * Activities are expected in chronological order, which is how both the read
 * model and the projection store them. A `task.progress` or `task.completed`
 * with no preceding `task.started` still produces a row: providers sometimes
 * report a subagent only once it is already underway, and dropping it would
 * hide live work.
 */
export function deriveNativeAgents(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<ThreadNativeAgent> {
  const drafts = new Map<string, Draft>();

  for (const activity of activities) {
    if (!isNativeAgentActivityKind(activity.kind)) continue;
    const payload = asRecord(activity.payload);
    const taskId = readString(payload?.taskId);
    if (payload === null || taskId === undefined) continue;

    const existing = drafts.get(taskId);
    const draft: Draft = existing ?? {
      taskId,
      turnId: activity.turnId,
      status: "running",
      startedAt: activity.createdAt,
      updatedAt: activity.createdAt,
    };
    draft.updatedAt = activity.createdAt;
    if (draft.turnId === null && activity.turnId !== null) draft.turnId = activity.turnId;

    // The row's label comes from `task.started`. The other two kinds may only
    // fill it when it is still empty — a provider can report a subagent that is
    // already underway, but `task.progress` carries rolling progress text in the
    // same field, and reading that unconditionally would rename the row on every
    // update.
    if (activity.kind === "task.started") {
      const description = readString(payload.description);
      if (description !== undefined) draft.description = description;
    } else if (draft.description === undefined) {
      const fallback = readString(payload.title) ?? readString(payload.description);
      if (fallback !== undefined) draft.description = fallback;
    }
    const subagentType = readString(payload.subagentType);
    if (subagentType !== undefined) draft.subagentType = subagentType;
    const prompt = readString(payload.prompt);
    if (prompt !== undefined) draft.prompt = prompt;
    const usage = readUsage(payload.usage);
    if (usage !== undefined) draft.usage = usage;
    const lastToolName = readString(payload.lastToolName);
    if (lastToolName !== undefined) draft.lastToolName = lastToolName;

    if (activity.kind === "task.started") {
      draft.startedAt = activity.createdAt;
      const retryOfTaskId = readString(payload.retryOfTaskId);
      if (retryOfTaskId !== undefined) {
        draft.retryOfTaskId = retryOfTaskId;
        const original = drafts.get(retryOfTaskId);
        if (original !== undefined) original.retriedByTaskId = taskId;
      }
    } else if (activity.kind === "task.progress") {
      // A rolling summary, not a log: the newest replaces the previous one,
      // which is all the provider gives us.
      const summary = readString(payload.summary) ?? readString(payload.description);
      if (summary !== undefined) draft.progressSummary = summary;
    } else {
      draft.status = statusForCompletion(payload.status);
      const summary = readString(payload.summary);
      if (summary !== undefined) draft.resultSummary = summary;
      const error = readString(payload.error);
      if (error !== undefined) draft.errorMessage = error;
    }

    drafts.set(taskId, draft);
  }

  return [...drafts.values()].map((draft) => ({
    taskId: draft.taskId,
    turnId: draft.turnId,
    status: draft.status,
    // The provider does not always label a run; the subagent type is the next
    // most useful thing a row can say, and it is never blank.
    description: draft.description ?? draft.subagentType ?? "In-session agent",
    startedAt: draft.startedAt,
    updatedAt: draft.updatedAt,
    ...(draft.subagentType === undefined ? {} : { subagentType: draft.subagentType }),
    ...(draft.prompt === undefined ? {} : { prompt: draft.prompt }),
    ...(draft.progressSummary === undefined ? {} : { progressSummary: draft.progressSummary }),
    ...(draft.resultSummary === undefined ? {} : { resultSummary: draft.resultSummary }),
    ...(draft.errorMessage === undefined ? {} : { errorMessage: draft.errorMessage }),
    ...(draft.lastToolName === undefined ? {} : { lastToolName: draft.lastToolName }),
    ...(draft.usage === undefined ? {} : { usage: draft.usage }),
    ...(draft.retryOfTaskId === undefined ? {} : { retryOfTaskId: draft.retryOfTaskId }),
    ...(draft.retriedByTaskId === undefined ? {} : { retriedByTaskId: draft.retriedByTaskId }),
  }));
}

/**
 * The bounded set worth showing: everything still running, plus the most recent
 * finished runs.
 *
 * Running agents survive regardless of age because a row disappearing while its
 * work continues is the one failure mode users notice. Finished ones are kept
 * newest-first up to the limit, then re-sorted into start order so the list
 * reads chronologically.
 */
export function selectVisibleNativeAgents(
  agents: ReadonlyArray<ThreadNativeAgent>,
  limit: number = NATIVE_AGENT_HISTORY_LIMIT,
): ReadonlyArray<ThreadNativeAgent> {
  const running = agents.filter((agent) => agent.status === "running");
  const settled = agents
    .filter((agent) => agent.status !== "running")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.max(0, limit));
  return [...running, ...settled].sort((left, right) =>
    left.startedAt === right.startedAt
      ? left.taskId.localeCompare(right.taskId)
      : left.startedAt.localeCompare(right.startedAt),
  );
}
