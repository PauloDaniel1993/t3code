import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  defaultTaskGroupExpanded,
  groupTasksByParent,
  hasUnreadTaskResults as resolveHasUnreadTaskResults,
  runningTaskCount,
  topLevelThreads,
} from "@t3tools/client-runtime/state/thread-tasks";
import {
  formatNativeAgentElapsed,
  formatNativeAgentGroupLabel,
  formatNativeAgentStatusLine,
  formatNativeAgentUsage,
  formatTaskGroupChipLabel,
  groupNativeAgentsByTurn,
  nativeAgentGroupStartsExpanded,
  resolveNativeAgentBody,
  resolveNativeAgentPeekChips,
  resolveNativeAgentRetryLinks,
  type NativeAgentTurnGroup,
} from "@t3tools/client-runtime/state/native-agents";
import type { ThreadId, ThreadNativeAgent } from "@t3tools/contracts";

import {
  DEFAULT_TASK_AGENT_NAVIGATION_CONFIG,
  resolveAgentTranscriptAffordance,
  resolveSteeringAvailability,
  resolveTaskRowAffordances,
  type AgentTranscriptAffordance,
  type SteeringAvailability,
  type TaskRowAffordances,
} from "./taskAgentNavigation";

/** The native-agent payload is a live, bounded window rather than a history. */
export const NATIVE_AGENT_WINDOW = {
  kind: "bounded",
  label: "Latest turn plus anything still running",
  note: "This is a bounded live picture, not full agent history.",
} as const;

declare const positiveCountBrand: unique symbol;

/** A count that is known to be greater than zero. */
export type PositiveCount = number & { readonly [positiveCountBrand]: true };

declare const failureReasonBrand: unique symbol;

/** A failure attribution is always non-empty after projection. */
export type FailureReason = string & { readonly [failureReasonBrand]: true };

export interface TaskAgentReadState {
  /** Device-owned read state; this model does not persist or mutate it. */
  readonly lastVisitedAtByThreadId: ReadonlyMap<ThreadId, string>;
}

export interface TaskAgentModelInput {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** All elapsed labels are derived from this injected clock. */
  readonly nowMs: number;
  readonly readState: TaskAgentReadState;
}

export interface TaskAgentThreadSummary {
  readonly id: EnvironmentThreadShell["id"];
  readonly environmentId: EnvironmentThreadShell["environmentId"];
  readonly projectId: EnvironmentThreadShell["projectId"];
  readonly title: string;
  readonly branch: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestUserMessageAt: string | null;
}

export type FailedAgentAttribution = Readonly<{
  readonly agentId: string;
  readonly description: string;
  readonly reason: FailureReason;
}>;

export type NativeAgentStatusProjection =
  | Readonly<{
      readonly kind: "running";
      readonly label: "Running";
      readonly tone: "active";
    }>
  | Readonly<{
      readonly kind: "finished";
      readonly label: "Finished";
      readonly tone: "success";
    }>
  | Readonly<{
      readonly kind: "failed";
      readonly label: "Failed";
      readonly tone: "danger";
      readonly failure: FailedAgentAttribution;
    }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly label: "Status unavailable";
      readonly tone: "neutral";
      readonly reason: "The agent reported an unrecognized outcome status.";
    }>;

export interface NativeAgentRetryLinkProjection {
  readonly direction: "retryOf" | "retriedBy";
  readonly targetTaskId: string;
  readonly target: Readonly<{ readonly taskId: string; readonly description: string }> | null;
  readonly label: string;
}

export interface NativeAgentProjection {
  readonly kind: "native-agent";
  readonly id: string;
  readonly turnId: ThreadNativeAgent["turnId"];
  readonly description: string;
  readonly subagentType: string | undefined;
  readonly prompt: string | undefined;
  readonly status: NativeAgentStatusProjection;
  readonly elapsed: string;
  readonly statusLine: string;
  readonly body: ReturnType<typeof resolveNativeAgentBody>;
  readonly usage: ReadonlyArray<string>;
  readonly peekChips: ReturnType<typeof resolveNativeAgentPeekChips>;
  readonly retryLinks: ReadonlyArray<NativeAgentRetryLinkProjection>;
  readonly steering: SteeringAvailability;
  readonly transcript: AgentTranscriptAffordance;
}

export type FinishedCounter = Readonly<{
  readonly kind: "finished";
  readonly count: PositiveCount;
  readonly label: string;
  readonly tone: "success";
}>;

export type FailedCounter = Readonly<{
  readonly kind: "failed";
  readonly count: PositiveCount;
  readonly label: string;
  readonly tone: "danger";
  /** The individual reasons remain reachable from a count-only rollup. */
  readonly failures: readonly [FailedAgentAttribution, ...FailedAgentAttribution[]];
}>;

/**
 * Outcome counters deliberately have no zero-valued success/failure fields.
 * In particular, the success-only branch cannot carry a failure flag or a
 * failure count, and the failure-only branch cannot imply partial success.
 */
export type NativeAgentOutcomeRollup =
  | Readonly<{
      readonly kind: "not-started";
      readonly label: "Queued";
      readonly totalCount: 0;
      readonly runningCount: 0;
      readonly counters: readonly [];
    }>
  | Readonly<{
      readonly kind: "outcome-unavailable";
      readonly label: "Outcome unavailable";
      readonly reason: "No recognized agent outcome was reported.";
      readonly counters: readonly [];
    }>
  | Readonly<{
      readonly kind: "running";
      readonly label: "Running";
      readonly totalCount: PositiveCount;
      readonly runningCount: PositiveCount;
      readonly counters: readonly [];
    }>
  | Readonly<{
      readonly kind: "success-only";
      readonly label: "Running" | "Finished";
      readonly totalCount: PositiveCount;
      readonly runningCount: number;
      readonly finishedCount: PositiveCount;
      readonly counter: FinishedCounter;
      readonly counters: readonly [FinishedCounter];
    }>
  | Readonly<{
      readonly kind: "failure-only";
      readonly label: "Running" | "Failed";
      readonly totalCount: PositiveCount;
      readonly runningCount: number;
      readonly failedCount: PositiveCount;
      readonly counter: FailedCounter;
      readonly counters: readonly [FailedCounter];
    }>
  | Readonly<{
      readonly kind: "mixed";
      readonly label: "Running" | "Finished with failures";
      readonly totalCount: PositiveCount;
      readonly runningCount: number;
      readonly finishedCount: PositiveCount;
      readonly failedCount: PositiveCount;
      readonly counters: readonly [FinishedCounter, FailedCounter];
    }>;

export interface NativeAgentTurnProjection {
  readonly kind: "native-agent-turn";
  readonly key: string;
  readonly turnId: NativeAgentTurnGroup["turnId"];
  readonly label: string;
  readonly expandedByDefault: boolean;
  readonly outcome: NativeAgentOutcomeRollup;
  readonly agents: ReadonlyArray<NativeAgentProjection>;
}

export type TaskStatusProjection =
  | Readonly<{
      readonly kind: "queued";
      readonly status: "queued";
      readonly label: "Queued";
      readonly tone: "neutral";
    }>
  | Readonly<{
      readonly kind: "running";
      readonly status: "running";
      readonly label: "Working";
      readonly tone: "active";
    }>
  | Readonly<{
      readonly kind: "finished";
      readonly status: "finished";
      readonly label: "Done";
      readonly tone: "success";
    }>
  | Readonly<{
      readonly kind: "failed";
      readonly status: "failed";
      readonly label: "Failed";
      readonly tone: "danger";
      readonly reason: FailureReason;
    }>
  | Readonly<{
      readonly kind: "cancelled";
      readonly status: "cancelled";
      readonly label: "Cancelled";
      readonly tone: "cancelled";
      readonly reason: string;
    }>
  | Readonly<{
      readonly kind: "metadata-unavailable";
      readonly status: null;
      readonly label: "Task status unavailable";
      readonly tone: "neutral";
      readonly reason: string;
    }>;

export interface TaskProjection {
  readonly kind: "task";
  readonly key: string;
  readonly thread: TaskAgentThreadSummary;
  readonly status: TaskStatusProjection;
  readonly hasUnreadTaskResults: boolean;
  readonly returnedToParent: boolean;
  readonly nativeAgentTurns: ReadonlyArray<NativeAgentTurnProjection>;
  readonly steering: SteeringAvailability;
  readonly navigation: TaskRowAffordances;
}

export interface ThreadRollupProjection {
  readonly kind: "rollup";
  readonly taskCount: number;
  readonly nativeAgentCount: number;
  readonly runningTaskCount: number;
  readonly chipLabel: string;
  readonly expandedByDefault: boolean;
  readonly tasks: ReadonlyArray<TaskProjection>;
  /** Parent-owned agents are still nested under their provider turn. */
  readonly nativeAgentTurns: ReadonlyArray<NativeAgentTurnProjection>;
}

export type ThreadProjection =
  | Readonly<{
      readonly kind: "plain-thread";
      readonly key: string;
      readonly thread: TaskAgentThreadSummary;
      readonly hasUnreadTaskResults: false;
    }>
  | Readonly<{
      readonly kind: "rollup-thread";
      readonly key: string;
      readonly thread: TaskAgentThreadSummary;
      readonly hasUnreadTaskResults: boolean;
      readonly rollup: ThreadRollupProjection;
    }>;

export interface TaskAgentModel {
  readonly kind: "task-agent-surface";
  readonly nativeAgentWindow: typeof NATIVE_AGENT_WINDOW;
  readonly threads: ReadonlyArray<ThreadProjection>;
}

function positiveCount(value: number, context: string): PositiveCount {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${context} must be a positive count`);
  }
  return value as PositiveCount;
}

function nonEmptyArray<T>(values: ReadonlyArray<T>, context: string): readonly [T, ...T[]] {
  const first = values[0];
  if (first === undefined) throw new Error(`${context} must not be empty`);
  return [first, ...values.slice(1)];
}

function failureReason(value: string | undefined, fallback: string): FailureReason {
  const trimmed = value?.trim();
  return (trimmed === undefined || trimmed.length === 0 ? fallback : trimmed) as FailureReason;
}

function threadSummary(thread: EnvironmentThreadShell): TaskAgentThreadSummary {
  return {
    id: thread.id,
    environmentId: thread.environmentId,
    projectId: thread.projectId,
    title: thread.title,
    branch: thread.branch,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    latestUserMessageAt: thread.latestUserMessageAt,
  };
}

function threadKey(thread: EnvironmentThreadShell): string {
  return `${thread.environmentId}:${thread.id}`;
}

function taskResultSummary(thread: EnvironmentThreadShell) {
  const delivery = thread.task?.delivery;
  if (delivery?.state === "delivered") {
    // ThreadTaskSummary is parent-projected. For the task's own unread marker,
    // use the exact delivered timestamp while still delegating the comparison
    // rule to hasUnreadTaskResults.
    return {
      total: 1,
      running: 0,
      latestDeliveredAt: delivery.updatedAt,
    };
  }
  return thread.taskSummary;
}

function latestDeliveredTaskTimestamp(tasks: ReadonlyArray<EnvironmentThreadShell>): string | null {
  let latest: string | null = null;
  for (const task of tasks) {
    if (task.task?.delivery?.state !== "delivered") continue;
    const deliveredAt = task.task.delivery.updatedAt;
    if (latest === null || deliveredAt > latest) latest = deliveredAt;
  }
  return latest;
}

function parentTaskSummary(
  parent: EnvironmentThreadShell,
  tasks: ReadonlyArray<EnvironmentThreadShell>,
) {
  if (parent.taskSummary != null) return parent.taskSummary;
  const latestDeliveredAt = latestDeliveredTaskTimestamp(tasks);
  if (latestDeliveredAt === null) return null;
  return {
    total: tasks.length,
    running: runningTaskCount(tasks),
    latestDeliveredAt,
  };
}

function taskStatus(thread: EnvironmentThreadShell): TaskStatusProjection {
  const metadata = thread.task;
  if (metadata == null) {
    return {
      kind: "metadata-unavailable",
      status: null,
      label: "Task status unavailable",
      tone: "neutral",
      reason: "This task's lifecycle metadata is unavailable.",
    };
  }

  switch (metadata.status) {
    case "queued":
      return { kind: "queued", status: "queued", label: "Queued", tone: "neutral" };
    case "running":
      return { kind: "running", status: "running", label: "Working", tone: "active" };
    case "finished":
      return { kind: "finished", status: "finished", label: "Done", tone: "success" };
    case "failed":
      return {
        kind: "failed",
        status: "failed",
        label: "Failed",
        tone: "danger",
        reason: failureReason(
          metadata.result?.summary,
          "The task failed without reporting a reason.",
        ),
      };
    case "cancelled":
      return {
        kind: "cancelled",
        status: "cancelled",
        label: "Cancelled",
        tone: "cancelled",
        reason: "The task was cancelled; it is no longer running.",
      };
  }
}

function taskSteering(
  thread: EnvironmentThreadShell,
  status: TaskStatusProjection,
): SteeringAvailability {
  if (status.status === null) {
    return { kind: "unavailable", reason: status.reason };
  }
  return resolveSteeringAvailability({
    kind: "task",
    task: { environmentId: thread.environmentId, taskId: thread.id },
    status: status.status,
  });
}

function projectNativeAgent(
  agent: ThreadNativeAgent,
  allAgents: ReadonlyArray<ThreadNativeAgent>,
  owner: EnvironmentThreadShell,
  nowMs: number,
): NativeAgentProjection {
  const attribution =
    agent.status === "failed"
      ? {
          agentId: agent.taskId,
          description: agent.description,
          reason: failureReason(agent.errorMessage, "The agent failed without reporting a reason."),
        }
      : null;

  let status: NativeAgentStatusProjection;
  if (agent.status === "failed") {
    if (attribution === null) throw new Error("A failed native agent has no attribution");
    status = {
      kind: "failed",
      label: "Failed",
      tone: "danger",
      failure: attribution,
    };
  } else if (agent.status === "finished") {
    status = { kind: "finished", label: "Finished", tone: "success" };
  } else if (agent.status === "running") {
    status = { kind: "running", label: "Running", tone: "active" };
  } else {
    status = {
      kind: "unavailable",
      label: "Status unavailable",
      tone: "neutral",
      reason: "The agent reported an unrecognized outcome status.",
    };
  }

  const body: ReturnType<typeof resolveNativeAgentBody> =
    attribution === null
      ? status.kind === "unavailable"
        ? { tone: "pending", text: "Outcome unavailable." }
        : resolveNativeAgentBody(agent)
      : { tone: "error", text: attribution.reason };
  const transcript = resolveAgentTranscriptAffordance({
    owningThread: { environmentId: owner.environmentId, threadId: owner.id },
    agent: { taskId: agent.taskId, turnId: agent.turnId },
  });

  return {
    kind: "native-agent",
    id: agent.taskId,
    turnId: agent.turnId,
    description: agent.description,
    subagentType: agent.subagentType,
    prompt: agent.prompt,
    status,
    elapsed: status.kind === "unavailable" ? "" : formatNativeAgentElapsed({ agent, nowMs }),
    statusLine:
      status.kind === "unavailable"
        ? "Outcome unavailable"
        : formatNativeAgentStatusLine({ agent, nowMs }),
    body,
    usage: formatNativeAgentUsage(agent.usage),
    peekChips: resolveNativeAgentPeekChips(agent),
    retryLinks: resolveNativeAgentRetryLinks(agent, allAgents).map((link) => ({
      direction: link.direction,
      targetTaskId: link.targetTaskId,
      target:
        link.target === null
          ? null
          : { taskId: link.target.taskId, description: link.target.description },
      label: link.label,
    })),
    steering: resolveSteeringAvailability({
      kind: "native-agent",
      agent: { taskId: agent.taskId, turnId: agent.turnId },
    }),
    transcript,
  };
}

function outcomeRollup(
  group: NativeAgentTurnGroup,
  agents: ReadonlyArray<NativeAgentProjection>,
): NativeAgentOutcomeRollup {
  if (group.agents.length === 0) {
    return {
      kind: "not-started",
      label: "Queued",
      totalCount: 0,
      runningCount: 0,
      counters: [],
    };
  }

  if (group.finishedCount === 0 && group.failedCount === 0) {
    if (group.runningCount === 0) {
      return {
        kind: "outcome-unavailable",
        label: "Outcome unavailable",
        reason: "No recognized agent outcome was reported.",
        counters: [],
      };
    }
    const totalCount = positiveCount(group.agents.length, "native agent total");
    return {
      kind: "running",
      label: "Running",
      totalCount,
      runningCount: positiveCount(group.runningCount, "running native agents"),
      counters: [],
    };
  }

  const totalCount = positiveCount(group.agents.length, "native agent total");

  const failures: FailedAgentAttribution[] = [];
  for (const agent of agents) {
    if (agent.status.kind === "failed") failures.push(agent.status.failure);
  }
  if (failures.length !== group.failedCount) {
    throw new Error("Shared native-agent failure count did not match projected failures");
  }

  const finished =
    group.finishedCount > 0
      ? ({
          kind: "finished",
          count: positiveCount(group.finishedCount, "finished native agents"),
          label: `✓ ${group.finishedCount}`,
          tone: "success",
        } satisfies FinishedCounter)
      : null;
  const failed =
    group.failedCount > 0
      ? ({
          kind: "failed",
          count: positiveCount(group.failedCount, "failed native agents"),
          label: `× ${group.failedCount}`,
          tone: "danger",
          failures: nonEmptyArray(failures, "failed native-agent attributions"),
        } satisfies FailedCounter)
      : null;
  const labelWhileRunning = group.runningCount > 0;

  if (finished !== null && failed === null) {
    return {
      kind: "success-only",
      label: labelWhileRunning ? "Running" : "Finished",
      totalCount,
      runningCount: group.runningCount,
      finishedCount: finished.count,
      counter: finished,
      counters: [finished],
    };
  }
  if (finished === null && failed !== null) {
    return {
      kind: "failure-only",
      label: labelWhileRunning ? "Running" : "Failed",
      totalCount,
      runningCount: group.runningCount,
      failedCount: failed.count,
      counter: failed,
      counters: [failed],
    };
  }
  if (finished !== null && failed !== null) {
    return {
      kind: "mixed",
      label: labelWhileRunning ? "Running" : "Finished with failures",
      totalCount,
      runningCount: group.runningCount,
      finishedCount: finished.count,
      failedCount: failed.count,
      counters: [finished, failed],
    };
  }

  throw new Error("Native-agent outcome projection produced no terminal counter");
}

function projectNativeAgentTurns(
  owner: EnvironmentThreadShell,
  agents: ReadonlyArray<ThreadNativeAgent>,
  ownerKey: string,
  nowMs: number,
): ReadonlyArray<NativeAgentTurnProjection> {
  return groupNativeAgentsByTurn(agents).map((group) => {
    const projectedAgents = group.agents.map((agent) =>
      projectNativeAgent(agent, agents, owner, nowMs),
    );
    return {
      kind: "native-agent-turn",
      key: `${ownerKey}:turn:${group.key}`,
      turnId: group.turnId,
      label: formatNativeAgentGroupLabel({ group, nowMs }),
      expandedByDefault: nativeAgentGroupStartsExpanded(group),
      outcome: outcomeRollup(group, projectedAgents),
      agents: projectedAgents,
    };
  });
}

function projectTask(
  task: EnvironmentThreadShell,
  readState: TaskAgentReadState,
  nowMs: number,
): TaskProjection {
  const status = taskStatus(task);
  const taskKey = threadKey(task);
  return {
    kind: "task",
    key: taskKey,
    thread: threadSummary(task),
    status,
    hasUnreadTaskResults: resolveHasUnreadTaskResults({
      taskSummary: taskResultSummary(task),
      lastVisitedAt: readState.lastVisitedAtByThreadId.get(task.id),
    }),
    returnedToParent: task.task?.delivery?.state === "delivered",
    nativeAgentTurns: projectNativeAgentTurns(task, task.nativeAgents ?? [], taskKey, nowMs),
    steering: taskSteering(task, status),
    navigation: resolveTaskRowAffordances(
      { environmentId: task.environmentId, taskId: task.id },
      DEFAULT_TASK_AGENT_NAVIGATION_CONFIG,
    ),
  };
}

function projectThread(
  thread: EnvironmentThreadShell,
  tasks: ReadonlyArray<EnvironmentThreadShell>,
  readState: TaskAgentReadState,
  nowMs: number,
): ThreadProjection {
  const nativeAgents = thread.nativeAgents ?? [];
  const key = threadKey(thread);
  const summary = threadSummary(thread);

  // This branch intentionally ignores a stale taskSummary. The actual child
  // list and native-agent list are the only things that can grant rollup UI.
  if (tasks.length === 0 && nativeAgents.length === 0) {
    return {
      kind: "plain-thread",
      key,
      thread: summary,
      hasUnreadTaskResults: false,
    };
  }

  const hasUnreadResults = resolveHasUnreadTaskResults({
    taskSummary: parentTaskSummary(thread, tasks),
    lastVisitedAt: readState.lastVisitedAtByThreadId.get(thread.id),
  });
  const taskProjections = tasks.map((task) => projectTask(task, readState, nowMs));
  const nativeAgentTurns = projectNativeAgentTurns(thread, nativeAgents, key, nowMs);
  const expandedByDefault =
    defaultTaskGroupExpanded({ tasks, hasUnreadResults }) ||
    nativeAgentTurns.some((turn) => turn.expandedByDefault);

  return {
    kind: "rollup-thread",
    key,
    thread: summary,
    hasUnreadTaskResults: hasUnreadResults,
    rollup: {
      kind: "rollup",
      taskCount: tasks.length,
      nativeAgentCount: nativeAgents.length,
      runningTaskCount: runningTaskCount(tasks),
      chipLabel: formatTaskGroupChipLabel({
        taskCount: tasks.length,
        nativeAgentCount: nativeAgents.length,
      }),
      expandedByDefault,
      tasks: taskProjections,
      nativeAgentTurns,
    },
  };
}

/** Build the mobile task/agent hierarchy without rendering or reading time. */
export function projectTaskAgentSurface(input: TaskAgentModelInput): TaskAgentModel {
  const tasksByParent = groupTasksByParent(input.threads);
  return {
    kind: "task-agent-surface",
    nativeAgentWindow: NATIVE_AGENT_WINDOW,
    threads: topLevelThreads(input.threads).map((thread) =>
      projectThread(thread, tasksByParent.get(thread.id) ?? [], input.readState, input.nowMs),
    ),
  };
}

/** Naming aliases for callers that describe this operation as model building. */
export const projectTaskAgentModel = projectTaskAgentSurface;
export const buildTaskAgentModel = projectTaskAgentSurface;
