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
  sidebarNativeAgents,
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
  it("falls back to top-level when disabled or unsupported", () => {
    const rows = [thread("parent"), child("child")];
    const result = createSidebarTaskGrouper()({
      threads: rows,
      scopedProjectKeys: null,
      supportsTasks: () => false,
    });
    expect(result.topLevel).toEqual(rows);
    expect(result.tasksByParent.size).toBe(0);
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
      threads: [thread("parent"), local, remote, crossProject, orphan],
      scopedProjectKeys: null,
      supportsTasks: () => true,
    });
    expect(all.topLevel.map((row) => row.id)).toEqual(["parent"]);
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
    const first = group({ threads: rows, scopedProjectKeys: null, supportsTasks: () => true });
    expect(first.tasksByParent.get("local:parent")).toHaveLength(45);
    expect(first.tasksByParent.get("local:parent")?.[0]?.id).toBe("task-44");
    const second = group({
      threads: [...rows, thread("unrelated")],
      scopedProjectKeys: null,
      supportsTasks: () => true,
    });
    expect(second.tasksByParent.get("local:parent")).toBe(first.tasksByParent.get("local:parent"));
    const removed = group({
      threads: rows.map((row, index) =>
        index === 0
          ? { ...row, archivedAt: epoch }
          : index === 1
            ? { ...row, deletedAt: epoch }
            : row,
      ),
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
  it("limits native history to the latest spawning run and live work, independently of durable tasks", () => {
    const old = agent({ origin: "provider_native", runId: RunId.make("old") });
    const latest = agent({
      origin: "provider_native",
      id: NodeId.make("latest"),
      runId: RunId.make("new"),
      startedAt: at("2026-09-29T01:00:00Z"),
    });
    const active = agent({
      origin: "provider_native",
      id: NodeId.make("active"),
      runId: RunId.make("old"),
      status: "running",
    });
    const idle = agent({
      origin: "provider_native",
      id: NodeId.make("idle"),
      runId: RunId.make("old"),
      status: "idle",
    });
    expect(sidebarNativeAgents([old, idle, latest, active, agent()]).map((row) => row.id)).toEqual([
      "active",
      "latest",
    ]);
    expect(
      sidebarNativeAgents([
        { ...old, runId: null },
        { ...latest, runId: null },
        { ...active, runId: null },
      ]).map((row) => row.id),
    ).toEqual(["active", "latest"]);
  });
});
