import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { EnvironmentThreadShell } from "./models.ts";
import { arrayElementsEqual } from "./entities.ts";
import { scopedThreadKey } from "../environment/scoped.ts";

type Thread = EnvironmentThreadShell;
export type SidebarTaskState =
  | "queued"
  | "running"
  | "finished"
  | "failed"
  | "cancelled"
  | "unavailable";

/** Fork lineage and provider-owned child transcripts are not delegated task threads. */
export function isSidebarTaskThread(thread: Pick<Thread, "lineage" | "source">): boolean {
  return (
    thread.lineage.parentThreadId !== null &&
    thread.lineage.relationshipToParent !== "fork" &&
    thread.source.creationSource !== "provider"
  );
}

/** Filter first, then join within one environment. Reuse unchanged child arrays on shell updates. */
export function createSidebarTaskGrouper() {
  let previous = new Map<string, ReadonlyArray<Thread>>();
  return (input: {
    threads: ReadonlyArray<Thread>;
    scopedProjectKeys: ReadonlySet<string> | null;
    supportsTasks: (thread: Thread) => boolean;
  }) => {
    const topLevel: Thread[] = [];
    const grouped = new Map<string, Thread[]>();
    const nativeParentKeys = new Set<string>();
    for (const thread of input.threads) {
      if (
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        (input.scopedProjectKeys !== null &&
          !input.scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`))
      )
        continue;
      const parentId = thread.lineage.parentThreadId;
      if (
        thread.lineage.relationshipToParent === "subagent" &&
        thread.source.creationSource === "provider"
      ) {
        if (parentId !== null)
          nativeParentKeys.add(
            scopedThreadKey({ environmentId: thread.environmentId, threadId: parentId }),
          );
        continue;
      }
      if (isSidebarTaskThread(thread) && input.supportsTasks(thread) && parentId !== null) {
        const key = scopedThreadKey({ environmentId: thread.environmentId, threadId: parentId });
        const group = grouped.get(key);
        if (group === undefined) grouped.set(key, [thread]);
        else group.push(thread);
      } else topLevel.push(thread);
    }
    const tasksByParent = new Map<string, ReadonlyArray<Thread>>();
    for (const [key, tasks] of grouped) {
      tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const old = previous.get(key);
      tasksByParent.set(key, old !== undefined && arrayElementsEqual(old, tasks) ? old : tasks);
    }
    previous = tasksByParent;
    return { topLevel, tasksByParent, nativeParentKeys };
  };
}

export function sidebarTaskIsLive(thread: Thread): boolean {
  const status = thread.runtime?.status ?? thread.latestRun?.status;
  return (
    thread.runtime?.activeRunId != null ||
    status === "preparing" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  );
}

export function resolveSidebarTaskState(
  thread: Thread,
  task?: OrchestrationV2Subagent,
): SidebarTaskState {
  if (sidebarTaskIsLive(thread)) return "running";
  const status = task?.status ?? thread.latestRun?.status;
  switch (status) {
    case "queued":
    case "pending":
      return "queued";
    case "preparing":
    case "starting":
    case "running":
    case "waiting":
      return "running";
    case "completed":
      return "finished";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return "cancelled";
    default:
      return "unavailable";
  }
}

export function sidebarTaskStatusWord(state: SidebarTaskState): string {
  return state === "queued" || state === "running"
    ? "Running"
    : state === "finished"
      ? "Done"
      : state === "failed"
        ? "Failed"
        : state === "cancelled"
          ? "Cancelled"
          : "Task status unavailable";
}

export function formatSidebarTaskElapsed(
  thread: Thread,
  task: OrchestrationV2Subagent | undefined,
  nowMs: number,
): string {
  const revived = sidebarTaskIsLive(thread);
  const state = resolveSidebarTaskState(thread, task);
  const start = revived
    ? (thread.latestRun?.startedAt ?? thread.latestRun?.requestedAt)
    : task?.startedAt == null
      ? (thread.latestRun?.startedAt ?? thread.latestRun?.requestedAt ?? thread.createdAt)
      : DateTime.formatIso(task.startedAt);
  const end =
    state === "running" || state === "queued"
      ? nowMs
      : task?.completedAt == null
        ? Date.parse(thread.latestRun?.completedAt ?? "")
        : DateTime.toEpochMillis(task.completedAt);
  const startMs = Date.parse(start ?? "");
  if (!Number.isFinite(startMs) || !Number.isFinite(end) || state === "unavailable") return "";
  return formatSidebarTaskDuration(end - startMs);
}

export function formatSidebarTaskDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs)) return "";
  const seconds = Math.floor(Math.max(0, durationMs) / 1000);
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h`
        : `${Math.floor(seconds / 86400)}d`;
}

export function formatSidebarTaskStatus(
  thread: Thread,
  task: OrchestrationV2Subagent | undefined,
  nowMs: number,
): string {
  const state = resolveSidebarTaskState(thread, task);
  const elapsed = formatSidebarTaskElapsed(thread, task, nowMs);
  const label =
    state === "queued" ? "Queued" : state === "running" ? "Working" : sidebarTaskStatusWord(state);
  return elapsed === ""
    ? label
    : `${label}${state === "finished" ? " in " : state === "failed" || state === "cancelled" ? " after " : " · "}${elapsed}`;
}

export function sidebarTaskCountLabel(tasks: number, agents: number): string {
  return [
    tasks > 0 ? `${tasks} ${tasks === 1 ? "task" : "tasks"}` : "",
    agents > 0 ? `${agents} ${agents === 1 ? "agent" : "agents"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Old records without a delivery watermark cannot establish an unread delivery. */
export function sidebarHasUnreadTaskResults(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  visitedAt: string | undefined,
): boolean {
  const visited = Date.parse(visitedAt ?? "");
  return subagents.some((task) => {
    const delivered = Date.parse(
      task.origin === "app_owned" ? (task.completionDelivery?.deliveredAt ?? "") : "",
    );
    return Number.isFinite(delivered) && (!Number.isFinite(visited) || delivered > visited);
  });
}

/** Native work stays separate, limited to the latest spawning run plus still-live work. */
export function sidebarNativeAgents(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
): ReadonlyArray<OrchestrationV2Subagent> {
  const native = subagents.filter((agent) => agent.origin === "provider_native");
  const latest = native.reduce<OrchestrationV2Subagent | undefined>(
    (previousAgent, agent) =>
      previousAgent === undefined ||
      DateTime.toEpochMillis(agent.startedAt ?? agent.updatedAt) >
        DateTime.toEpochMillis(previousAgent.startedAt ?? previousAgent.updatedAt)
        ? agent
        : previousAgent,
    undefined,
  );
  return native
    .filter(
      (agent) =>
        (latest?.runId == null ? agent.id === latest?.id : agent.runId === latest.runId) ||
        agent.status === "running" ||
        agent.status === "pending" ||
        agent.status === "waiting",
    )
    .sort(
      (left, right) =>
        DateTime.toEpochMillis(left.startedAt ?? left.updatedAt) -
        DateTime.toEpochMillis(right.startedAt ?? right.updatedAt),
    );
}
