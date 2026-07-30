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

/**
 * Activity kinds this module folds. Necessary but NOT sufficient — see
 * `startedActivityDescribesAgent`.
 */
const NATIVE_AGENT_ACTIVITY_KINDS = new Set(["task.started", "task.progress", "task.completed"]);

export function isNativeAgentActivityKind(kind: string): boolean {
  return NATIVE_AGENT_ACTIVITY_KINDS.has(kind);
}

/**
 * `task.*` is not a subagent channel. Providers report other per-turn work
 * through it too: Claude Code emits `taskType: "local_bash"` for every
 * backgrounded shell and `taskType: "plan"` for plan tasks. Folding those in
 * produced sidebar rows like "Restart the mockup static server", spinning
 * forever because a background server never exits.
 *
 * So membership needs positive evidence that a run is an agent. The canonical
 * evidence is the provider-independent `nativeAgent` marker, which every adapter
 * sets at its own boundary from whatever its provider actually reports — Claude
 * from the Task tool's `subagent_type`, Codex from a `collabAgentToolCall`
 * receiver thread. `subagentType` and `workflowName` are still accepted because
 * threads projected before the marker existed carry only those, and replaying
 * them must produce the same rows.
 *
 * This is an allowlist on purpose. A provider that spawns real subagents without
 * labelling them is missed, which is the safer failure: an absent row is a gap,
 * a mislabelled one is a lie about what the user is looking at.
 */
export function activityDescribesAgent(payload: Record<string, unknown>): boolean {
  return (
    payload.nativeAgent === true ||
    readString(payload.subagentType) !== undefined ||
    readString(payload.workflowName) !== undefined
  );
}

/**
 * @deprecated Use {@link activityDescribesAgent}. Kept as the original name
 * while callers migrate; the check is no longer specific to `task.started`.
 */
export const startedActivityDescribesAgent = activityDescribesAgent;

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

/**
 * Apply one activity to the running set, returning a new list.
 *
 * This is the single fold step behind both entry points: the projection
 * pipeline calls it once per incoming activity against the row it already has,
 * and `deriveNativeAgents` reduces a whole history through it. Keeping one
 * implementation means an incrementally-built projection and a full replay can
 * never disagree.
 *
 * Any of the three kinds can admit a new entry, but only while carrying evidence
 * that the run is an agent (see `activityDescribesAgent`) — admitting on an
 * unmarked `task.completed` would let every backgrounded shell back in through
 * its completion event. Accepting marked progress and completion events, rather
 * than `task.started` alone, is what makes the fold tolerate a lifecycle whose
 * events arrive out of order or whose start was missed entirely (a resumed
 * thread, a dropped event, an agent already running when T3 attached).
 */
export function applyNativeAgentActivity(
  agents: ReadonlyArray<ThreadNativeAgent>,
  activity: OrchestrationThreadActivity,
): ReadonlyArray<ThreadNativeAgent> {
  if (!isNativeAgentActivityKind(activity.kind)) return agents;
  const payload = asRecord(activity.payload);
  const taskId = readString(payload?.taskId);
  if (payload === null || taskId === undefined) return agents;

  const index = agents.findIndex((agent) => agent.taskId === taskId);
  const existing = index === -1 ? undefined : agents[index];
  if (existing === undefined && !activityDescribesAgent(payload)) {
    return agents;
  }

  const subagentType = readString(payload.subagentType) ?? existing?.subagentType;
  const startedDescription =
    activity.kind === "task.started" ? readString(payload.description) : undefined;
  // The label comes from `task.started`. `task.progress` carries rolling
  // progress text in the same `description` field, so it may only supply a
  // label for an agent first seen mid-flight — reading it on every update
  // would rename the row as the work moved along.
  const description =
    startedDescription ??
    existing?.description ??
    readString(payload.title) ??
    readString(payload.description) ??
    subagentType ??
    "In-session agent";

  const progressSummary =
    activity.kind === "task.progress"
      ? (readString(payload.summary) ??
        readString(payload.description) ??
        existing?.progressSummary)
      : existing?.progressSummary;

  const completed = activity.kind === "task.completed";
  const next: ThreadNativeAgent = {
    taskId,
    // First real turn wins. A row admitted by an event that arrived before its
    // turn was registered holds `null`, which a later event can still fill in.
    turnId: existing?.turnId ?? activity.turnId,
    // A settled agent stays settled: a duplicate or late-arriving start must not
    // put a finished row back into `running`.
    status: completed ? statusForCompletion(payload.status) : (existing?.status ?? "running"),
    description,
    startedAt:
      activity.kind === "task.started"
        ? activity.createdAt
        : (existing?.startedAt ?? activity.createdAt),
    // Monotonic, so an out-of-order event cannot drag the row backwards and
    // reshuffle the history ordering in `selectVisibleNativeAgents`.
    updatedAt:
      existing !== undefined && existing.updatedAt.localeCompare(activity.createdAt) > 0
        ? existing.updatedAt
        : activity.createdAt,
    ...(subagentType === undefined ? {} : { subagentType }),
    ...(() => {
      const prompt = readString(payload.prompt) ?? existing?.prompt;
      return prompt === undefined ? {} : { prompt };
    })(),
    ...(progressSummary === undefined ? {} : { progressSummary }),
    ...(() => {
      const resultSummary =
        (completed ? readString(payload.summary) : undefined) ?? existing?.resultSummary;
      return resultSummary === undefined ? {} : { resultSummary };
    })(),
    ...(() => {
      const errorMessage =
        (completed ? readString(payload.error) : undefined) ?? existing?.errorMessage;
      return errorMessage === undefined ? {} : { errorMessage };
    })(),
    ...(() => {
      const lastToolName = readString(payload.lastToolName) ?? existing?.lastToolName;
      return lastToolName === undefined ? {} : { lastToolName };
    })(),
    ...(() => {
      const usage = readUsage(payload.usage) ?? existing?.usage;
      return usage === undefined ? {} : { usage };
    })(),
    ...(() => {
      const retryOfTaskId =
        (activity.kind === "task.started" ? readString(payload.retryOfTaskId) : undefined) ??
        existing?.retryOfTaskId;
      return retryOfTaskId === undefined ? {} : { retryOfTaskId };
    })(),
    ...(existing?.retriedByTaskId === undefined
      ? {}
      : { retriedByTaskId: existing.retriedByTaskId }),
  };

  const updated = index === -1 ? [...agents, next] : agents.map((a, i) => (i === index ? next : a));

  // Point the original at its replacement, so a failed run and its retry can
  // reference each other from either side.
  const retryOf = next.retryOfTaskId;
  if (retryOf === undefined) return updated;
  return updated.map((agent) =>
    agent.taskId === retryOf ? { ...agent, retriedByTaskId: taskId } : agent,
  );
}

/**
 * Fold a thread's activities into one entry per in-session agent, in the order
 * they were first seen. Activities are expected in chronological order, which
 * is how both the read model and the projection store them.
 */
export function deriveNativeAgents(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<ThreadNativeAgent> {
  return activities.reduce<ReadonlyArray<ThreadNativeAgent>>(applyNativeAgentActivity, []);
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
