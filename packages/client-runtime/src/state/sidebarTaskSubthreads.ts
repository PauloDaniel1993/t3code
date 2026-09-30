import { isProviderNativeSubagentThread, type OrchestrationV2Subagent } from "@t3tools/contracts";
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
    !isProviderNativeSubagentThread({
      lineage: thread.lineage,
      creationSource: thread.source.creationSource,
    })
  );
}

/** Filter first, then join within one environment. Reuse unchanged child arrays on shell updates. */
export function createSidebarTaskGrouper() {
  let previous = new Map<string, ReadonlyArray<Thread>>();
  let previousNative = new Map<string, ReadonlyArray<Thread>>();
  let previousTopLevel: ReadonlyArray<Thread> = [];
  return (input: {
    threads: ReadonlyArray<Thread>;
    scopedProjectKeys: ReadonlySet<string> | null;
    supportsTasks: (thread: Thread) => boolean;
    enabled?: boolean;
  }) => {
    const topLevel: Thread[] = [];
    const grouped = new Map<string, Thread[]>();
    const nativeParentKeys = new Set<string>();
    const nativeGrouped = new Map<string, Thread[]>();
    let parents: Map<Thread["environmentId"], Map<Thread["id"], Thread>> | undefined;
    const findParent = (thread: Thread, parentId: Thread["id"]) => {
      if (parents === undefined) {
        parents = new Map();
        for (const candidate of input.threads) {
          if (candidate.archivedAt !== null || candidate.deletedAt !== null) continue;
          let environment = parents.get(candidate.environmentId);
          if (environment === undefined)
            parents.set(candidate.environmentId, (environment = new Map()));
          environment.set(candidate.id, candidate);
        }
      }
      return parents.get(thread.environmentId)?.get(parentId);
    };
    for (const thread of input.threads) {
      if (
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        (input.scopedProjectKeys !== null &&
          !input.scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`))
      )
        continue;
      const parentId = thread.lineage.parentThreadId;
      if (thread.lineage.relationshipToParent !== "subagent" && parentId === null) {
        topLevel.push(thread);
        continue;
      }
      // Match upstream's list when the local grouping preference is off.
      if (input.enabled === false && isSidebarTaskThread(thread)) continue;
      if (
        isProviderNativeSubagentThread({
          lineage: thread.lineage,
          creationSource: thread.source.creationSource,
        })
      ) {
        if (parentId !== null) {
          const key = scopedThreadKey({ environmentId: thread.environmentId, threadId: parentId });
          nativeParentKeys.add(key);
          const group = nativeGrouped.get(key);
          if (group === undefined) nativeGrouped.set(key, [thread]);
          else group.push(thread);
        }
        continue;
      }
      if (isSidebarTaskThread(thread) && input.supportsTasks(thread) && parentId !== null) {
        let parent = findParent(thread, parentId);
        // V2 can delegate below a task. Flatten that lineage to the nearest
        // displayed ancestor rather than creating a third level or losing work.
        const seen = new Set([thread.id]);
        while (parent !== undefined && isSidebarTaskThread(parent) && input.supportsTasks(parent)) {
          if (seen.has(parent.id)) {
            parent = undefined;
            break;
          }
          seen.add(parent.id);
          const ancestorId = parent.lineage.parentThreadId;
          parent = ancestorId === null ? undefined : findParent(thread, ancestorId);
        }
        // Older servers may retain children after parent removal. Only their
        // surviving work belongs at top level, within the project filter.
        if (parent === undefined) {
          if (sidebarTaskIsLive(thread) || thread.latestRun?.status === "queued")
            topLevel.push(thread);
          continue;
        }
        const key = scopedThreadKey({ environmentId: thread.environmentId, threadId: parent.id });
        const group = grouped.get(key);
        if (group === undefined) grouped.set(key, [thread]);
        else group.push(thread);
      } else topLevel.push(thread);
    }
    const tasksByParent = new Map<string, ReadonlyArray<Thread>>();
    for (const [key, tasks] of grouped) {
      tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const old = previous.get(key);
      for (let index = 0; index < tasks.length; index++) {
        const retained = old?.[index];
        if (retained !== undefined && sidebarTaskDisplayEqual(retained, tasks[index]!))
          tasks[index] = retained;
      }
      tasksByParent.set(key, old !== undefined && arrayElementsEqual(old, tasks) ? old : tasks);
    }
    previous = tasksByParent;
    const nativeThreadsByParent = new Map<string, ReadonlyArray<Thread>>();
    for (const [key, rows] of nativeGrouped) {
      const old = previousNative.get(key);
      nativeThreadsByParent.set(
        key,
        old !== undefined &&
          old.length === rows.length &&
          old.every((row, index) => sidebarTaskDisplayEqual(row, rows[index]!))
          ? old
          : rows,
      );
    }
    previousNative = nativeThreadsByParent;
    if (!arrayElementsEqual(previousTopLevel, topLevel)) previousTopLevel = topLevel;
    return { topLevel: previousTopLevel, tasksByParent, nativeParentKeys, nativeThreadsByParent };
  };
}

/** Retain shells while everything the compact row draws is unchanged. Peek reads the live shell. */
function sidebarTaskDisplayEqual(left: Thread, right: Thread) {
  return (
    left.environmentId === right.environmentId &&
    left.id === right.id &&
    left.title === right.title &&
    left.createdAt === right.createdAt &&
    left.runtime?.activeRunId === right.runtime?.activeRunId &&
    left.runtime?.status === right.runtime?.status &&
    left.latestRun?.status === right.latestRun?.status &&
    left.latestRun?.runId === right.latestRun?.runId &&
    left.latestRun?.requestedAt === right.latestRun?.requestedAt &&
    left.latestRun?.startedAt === right.latestRun?.startedAt &&
    left.latestRun?.completedAt === right.latestRun?.completedAt
  );
}

function currentSidebarTaskRecord(thread: Thread, task?: OrchestrationV2Subagent) {
  return task !== undefined &&
    !sidebarTaskIsLive(thread) &&
    thread.latestRun?.completedAt != null &&
    Date.parse(thread.latestRun.completedAt) >= DateTime.toEpochMillis(task.updatedAt)
    ? undefined
    : task;
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
  const status = currentSidebarTaskRecord(thread, task)?.status ?? thread.latestRun?.status;
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
  task = currentSidebarTaskRecord(thread, task);
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

/** Acknowledgement/disposal cannot undo a delivery that actually happened. */
export function sidebarTaskWasReturned(task: OrchestrationV2Subagent | undefined): boolean {
  return (
    task?.completionDelivery?.state === "delivered" ||
    task?.completionDelivery?.deliveredAt !== undefined
  );
}
