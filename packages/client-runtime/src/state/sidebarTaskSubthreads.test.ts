import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { presentThreadShell, type EnvironmentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  createSidebarTaskGrouper,
  formatSidebarTaskElapsed,
  formatSidebarTaskStatus,
  isSidebarTaskThread,
  resolveSidebarTaskState,
  sidebarTaskWasReturned,
  sidebarTaskCountLabel,
  sidebarHasUnreadTaskResults,
} from "./sidebarTaskSubthreads.ts";

const at = (time: string) => DateTime.makeUnsafe(time);
const epoch = "2026-09-29T00:00:00.000Z";
function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    ...presentThreadShell(EnvironmentId.make("local"), {
      ...v2ThreadShell,
      id: ThreadId.make(id),
      createdAt: at(epoch),
      latestRunId: null,
      activeRunId: null,
      status: "idle",
    }),
    ...overrides,
  };
}
function child(id: string, overrides: Partial<EnvironmentThreadShell> = {}) {
  return thread(id, {
    lineage: {
      parentThreadId: ThreadId.make("parent"),
      relationshipToParent: "subagent",
      rootThreadId: ThreadId.make("parent"),
    },
    ...overrides,
  });
}
function agent(overrides: Partial<OrchestrationV2Subagent> = {}): OrchestrationV2Subagent {
  return {
    id: NodeId.make("agent"),
    threadId: ThreadId.make("parent"),
    runId: RunId.make("run"),
    parentNodeId: NodeId.make("root"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: ThreadId.make("child"),
    nativeTaskRef: null,
    prompt: "work",
    title: "Work",
    model: null,
    status: "completed",
    result: "Done",
    startedAt: at(epoch),
    completedAt: at("2026-09-29T00:08:00Z"),
    updatedAt: at("2026-09-29T00:08:00Z"),
    ...overrides,
  };
}

describe("sidebar delegated task grouping", () => {
  it("flattens deeper tasks under the nearest displayed ancestor without a third level", () => {
    const parent = thread("parent");
    const first = child("first");
    const nested = child("nested", {
      lineage: { ...first.lineage, parentThreadId: first.id },
    });
    const deepest = child("deepest", {
      lineage: { ...first.lineage, parentThreadId: nested.id },
    });
    const result = createSidebarTaskGrouper()({
      threads: [deepest, nested, first, parent],
      scopedProjectKeys: null,
      supportsTasks: () => true,
    });
    expect(result.topLevel).toEqual([parent]);
    expect(result.tasksByParent.size).toBe(1);
    expect(result.tasksByParent.get("local:parent")).toEqual([deepest, nested, first]);
  });
  it("terminates malformed cycles and does not attach nested tasks across environments or a filtered ancestor", () => {
    const first = child("first", {
      lineage: { ...child("first").lineage, parentThreadId: ThreadId.make("second") },
    });
    const second = child("second", { lineage: { ...first.lineage, parentThreadId: first.id } });
    const nested = child("nested", { lineage: { ...first.lineage, parentThreadId: first.id } });
    const group = createSidebarTaskGrouper();
    expect(
      group({
        threads: [first, second, nested],
        scopedProjectKeys: null,
        supportsTasks: () => true,
      }).tasksByParent.size,
    ).toBe(0);
    const hidden = thread("parent", { projectId: ProjectId.make("hidden") });
    const local = child("first");
    const remote = child("remote", { environmentId: EnvironmentId.make("remote") });
    const filtered = group({
      threads: [hidden, local, nested, remote],
      scopedProjectKeys: new Set([`local:${local.projectId}`]),
      supportsTasks: () => true,
    });
    expect(filtered.topLevel).toEqual([]);
    expect(filtered.tasksByParent.get("local:first")).toBeUndefined();
  });
  it("uses lineage even without task metadata and preserves forks as ordinary threads", () => {
    const fork = child("fork", {
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "fork",
        rootThreadId: ThreadId.make("parent"),
      },
    });
    expect(isSidebarTaskThread(child("child"))).toBe(true);
    expect(isSidebarTaskThread(fork)).toBe(false);
    expect(isSidebarTaskThread(thread("parent"))).toBe(false);
  });
  it("falls back to top-level when the environment does not support task groups", () => {
    const rows = [thread("parent"), child("child")];
    const result = createSidebarTaskGrouper()({
      threads: rows,
      scopedProjectKeys: null,
      supportsTasks: () => false,
    });
    expect(result.topLevel).toEqual(rows);
    expect(result.tasksByParent.size).toBe(0);
  });
  it("hides tasks when disabled, including surviving orphans, but keeps ordinary forks", () => {
    const parent = thread("parent");
    const fork = child("fork", {
      lineage: { ...child("fork").lineage, relationshipToParent: "fork" },
    });
    const orphan = child("orphan", {
      lineage: { ...child("orphan").lineage, parentThreadId: ThreadId.make("deleted") },
    });
    const rows = [parent, child("task"), orphan, fork];
    const group = createSidebarTaskGrouper();
    const disabled = group({
      threads: rows,
      scopedProjectKeys: null,
      supportsTasks: () => true,
      enabled: false,
    });
    expect(disabled.topLevel).toEqual([parent, fork]);
    expect(disabled.tasksByParent.size).toBe(0);
    const restored = group({
      threads: rows,
      scopedProjectKeys: null,
      supportsTasks: () => true,
      enabled: true,
    });
    expect(restored.tasksByParent.get("local:parent")?.map((task) => task.id)).toEqual(["task"]);
    expect(restored.topLevel).toEqual([parent, fork]);
  });
  it("scopes joins by environment, filters projects before joining, and leaves orphans hidden", () => {
    const local = child("child");
    const remote = child("remote-child", { environmentId: EnvironmentId.make("remote") });
    const crossProject = child("cross", { projectId: ProjectId.make("other") });
    const orphan = child("orphan", {
      lineage: {
        parentThreadId: ThreadId.make("hidden"),
        relationshipToParent: "subagent",
        rootThreadId: ThreadId.make("hidden"),
      },
    });
    const group = createSidebarTaskGrouper();
    const all = group({
      threads: [
        thread("parent"),
        thread("parent", { environmentId: EnvironmentId.make("remote") }),
        thread("hidden"),
        local,
        remote,
        crossProject,
        orphan,
      ],
      scopedProjectKeys: null,
      supportsTasks: () => true,
    });
    expect(all.topLevel.map((row) => row.id)).toEqual(["parent", "parent", "hidden"]);
    expect(all.tasksByParent.get("local:parent")?.map((row) => row.id)).toEqual(["child", "cross"]);
    expect(all.tasksByParent.get("remote:parent")?.map((row) => row.id)).toEqual(["remote-child"]);
    expect(all.tasksByParent.get("local:hidden")?.map((row) => row.id)).toEqual(["orphan"]);
    const scoped = group({
      threads: [thread("parent"), local, remote, crossProject],
      scopedProjectKeys: new Set([`local:${local.projectId}`]),
      supportsTasks: () => true,
    });
    expect(scoped.tasksByParent.get("local:parent")).toEqual([local]);
  });
  it("orders every visible task newest first with no cap and keeps unchanged arrays stable", () => {
    const rows = Array.from({ length: 45 }, (_, index) =>
      child(`task-${index}`, { createdAt: `2026-09-29T00:00:${String(index).padStart(2, "0")}Z` }),
    );
    const group = createSidebarTaskGrouper();
    const first = group({
      threads: [thread("parent"), ...rows],
      scopedProjectKeys: null,
      supportsTasks: () => true,
    });
    expect(first.tasksByParent.get("local:parent")).toHaveLength(45);
    expect(first.tasksByParent.get("local:parent")?.[0]?.id).toBe("task-44");
    const second = group({
      threads: [thread("parent"), ...rows, thread("unrelated")],
      scopedProjectKeys: null,
      supportsTasks: () => true,
    });
    expect(second.tasksByParent.get("local:parent")).toBe(first.tasksByParent.get("local:parent"));
    const removed = group({
      threads: [
        thread("parent"),
        ...rows.map((row, index) =>
          index === 0
            ? { ...row, archivedAt: epoch }
            : index === 1
              ? { ...row, deletedAt: epoch }
              : row,
        ),
      ],
      scopedProjectKeys: null,
      supportsTasks: () => true,
    });
    expect(removed.tasksByParent.get("local:parent")).toHaveLength(43);
  });
  it("does not double-count provider-owned child transcripts as tasks", () => {
    const native = child("native");
    const row = { ...native, source: { ...native.source, creationSource: "provider" as const } };
    const grouped = createSidebarTaskGrouper()({
      threads: [row],
      scopedProjectKeys: null,
      supportsTasks: () => true,
    });
    expect(grouped.tasksByParent.size).toBe(0);
    expect(grouped.topLevel).toEqual([]);
    expect(grouped.nativeParentKeys.has("local:parent")).toBe(true);
  });
});

describe("task status and run duration", () => {
  it("uses actual delivery time rather than later activity and keeps visits scoped to the parent", () => {
    const delivered = agent({
      completionDelivery: {
        state: "delivered",
        observedByRunId: null,
        deliveredAt: "2026-09-29T00:08:00Z",
      },
      updatedAt: at("2026-09-30T00:00:00Z"),
    });
    expect(sidebarHasUnreadTaskResults([delivered], undefined)).toBe(true);
    expect(sidebarHasUnreadTaskResults([delivered], "2026-09-29T00:07:00Z")).toBe(true);
    expect(sidebarHasUnreadTaskResults([delivered], "2026-09-29T00:08:00Z")).toBe(false);
    expect(
      sidebarHasUnreadTaskResults(
        [agent({ completionDelivery: { state: "delivered", observedByRunId: null } })],
        undefined,
      ),
    ).toBe(false);
    expect(
      sidebarHasUnreadTaskResults(
        [
          {
            ...delivered,
            completionDelivery: { ...delivered.completionDelivery!, state: "acknowledged" },
          },
        ],
        undefined,
      ),
    ).toBe(true);
  });
  it("shows unknown state rather than silently hiding a linked task", () => {
    expect(resolveSidebarTaskState(child("child"))).toBe("unavailable");
    expect(formatSidebarTaskElapsed(child("child"), undefined, Date.parse(epoch))).toBe("");
  });
  it("freezes finished duration and distinguishes failure and cancellation", () => {
    const shell = child("child");
    expect(formatSidebarTaskElapsed(shell, agent(), Date.parse("2026-09-30T00:00:00Z"))).toBe("8m");
    expect(formatSidebarTaskStatus(shell, agent({ status: "failed" }), Date.parse(epoch))).toBe(
      "Failed after 8m",
    );
    expect(formatSidebarTaskStatus(shell, agent({ status: "cancelled" }), Date.parse(epoch))).toBe(
      "Cancelled after 8m",
    );
  });
  it("uses fresh active run timing over a frozen terminal task", () => {
    const live = child("child", {
      latestRun: {
        runId: RunId.make("revived"),
        status: "running",
        requestedAt: "2026-09-29T01:00:00Z",
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
      runtime: {
        status: "running",
        activeRunId: RunId.make("revived"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: null,
        lastError: null,
        updatedAt: epoch,
      },
    });
    expect(resolveSidebarTaskState(live, agent({ status: "cancelled" }))).toBe("running");
    expect(formatSidebarTaskStatus(live, agent(), Date.parse("2026-09-29T01:01:59Z"))).toBe(
      "Working · 1m",
    );
  });
  it.each([
    [59, "59s"],
    [119, "1m"],
    [7199, "1h"],
    [172799, "1d"],
  ])("floors a run of %s seconds to %s", (seconds, expected) => {
    expect(
      formatSidebarTaskElapsed(
        child("child"),
        agent({ status: "running", completedAt: null }),
        Date.parse(epoch) + Number(seconds) * 1000,
      ),
    ).toBe(expected);
  });
  it("suppresses invalid timing and counts all task states with separate agent wording", () => {
    const shell = child("child", { createdAt: "invalid" });
    expect(
      formatSidebarTaskElapsed(
        shell,
        agent({ status: "running", startedAt: null }),
        Date.parse(epoch),
      ),
    ).toBe("");
    expect(sidebarTaskCountLabel(1, 1)).toBe("1 task · 1 agent");
    expect(sidebarTaskCountLabel(45, 3)).toBe("45 tasks · 3 agents");
  });
  it("keeps return evidence through acknowledgement and disposal without inventing a delivery", () => {
    const delivered = agent({ completionDelivery: { state: "delivered", observedByRunId: null } });
    expect(sidebarTaskWasReturned(delivered)).toBe(true);
    expect(
      sidebarTaskWasReturned(
        agent({ completionDelivery: { state: "acknowledged", observedByRunId: null } }),
      ),
    ).toBe(false);
    for (const state of ["acknowledged", "disposed"] as const)
      expect(
        sidebarTaskWasReturned(
          agent({ completionDelivery: { state, observedByRunId: null, deliveredAt: epoch } }),
        ),
      ).toBe(true);
  });
});

it("keeps surviving tasks reachable after parent archive or deletion, and nests again on restoration", () => {
  const parent = thread("parent");
  const task = child("child", {
    latestRun: {
      runId: RunId.make("running"),
      status: "running",
      requestedAt: epoch,
      startedAt: epoch,
      completedAt: null,
      assistantMessageId: null,
    },
  });
  const finished = child("finished");
  const group = createSidebarTaskGrouper();
  for (const missing of [
    [],
    [{ ...parent, archivedAt: epoch }],
    [{ ...parent, deletedAt: epoch }],
  ]) {
    expect(
      group({
        threads: [...missing, task, finished],
        scopedProjectKeys: null,
        supportsTasks: () => true,
      }).topLevel,
    ).toEqual([task]);
  }
  expect(
    group({
      threads: [parent, task],
      scopedProjectKeys: null,
      supportsTasks: () => true,
    }).tasksByParent.get("local:parent"),
  ).toEqual([task]);
});
it("preserves the top-level list identity when only one child shell changes", () => {
  const parent = thread("parent");
  const task = child("child");
  const group = createSidebarTaskGrouper();
  const first = group({
    threads: [parent, task],
    scopedProjectKeys: null,
    supportsTasks: () => true,
  });
  const next = group({
    threads: [parent, { ...task, title: "Updated" }],
    scopedProjectKeys: null,
    supportsTasks: () => true,
  });
  expect(next.topLevel).toBe(first.topLevel);
  expect(next.tasksByParent.get("local:parent")?.[0]?.title).toBe("Updated");
});

it("ignores streaming churn but updates every compact display input", () => {
  const parent = thread("parent");
  const task = child("child");
  const group = createSidebarTaskGrouper();
  const groupRows = (row: EnvironmentThreadShell) =>
    group({
      threads: [parent, row],
      scopedProjectKeys: null,
      supportsTasks: () => true,
    }).tasksByParent.get("local:parent");
  const first = groupRows(task);
  expect(groupRows({ ...task, updatedAt: "2026-09-29T00:10:00Z", itemCount: 120 })).toBe(first);
  expect(groupRows({ ...task, title: "Renamed" })).not.toBe(first);
  expect(
    groupRows({
      ...task,
      latestRun: {
        runId: RunId.make("new"),
        status: "running",
        requestedAt: epoch,
        startedAt: epoch,
        completedAt: null,
        assistantMessageId: null,
      },
    }),
  ).not.toBe(first);
});
it("a newer terminal shell overrides remembered running status and timing", () => {
  const task = child("child", {
    latestRun: {
      runId: RunId.make("latest"),
      status: "completed",
      requestedAt: epoch,
      startedAt: epoch,
      completedAt: "2026-09-29T00:09:00Z",
      assistantMessageId: null,
    },
  });
  const stale = agent({ status: "running", completedAt: null });
  expect(resolveSidebarTaskState(task, stale)).toBe("finished");
  expect(
    resolveSidebarTaskState(task, {
      ...stale,
      updatedAt: DateTime.makeUnsafe(task.latestRun!.completedAt!),
    }),
  ).toBe("finished");
  expect(formatSidebarTaskElapsed(task, stale, Date.parse("2026-09-29T00:10:00Z"))).toBe("9m");
});
