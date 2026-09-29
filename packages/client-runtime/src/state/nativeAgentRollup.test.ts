import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { deriveNativeAgentRollup, nativeAgentOutcomeSummary } from "./nativeAgentRollup.ts";

const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1_000);
function agent(
  id: string,
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("parent"),
    runId: RunId.make("turn-1"),
    parentNodeId: NodeId.make("parent-node"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    title: id,
    prompt: "Inspect the module",
    model: "gpt-6.1-sol",
    status: "running",
    result: null,
    startedAt: at(1),
    completedAt: null,
    updatedAt: at(2),
    ...overrides,
  };
}

describe("nativeAgentOutcomeSummary", () => {
  it("keeps V2's idle, waiting, failed and stopped outcomes distinct", () => {
    const statuses: ReadonlyArray<OrchestrationV2Subagent["status"]> = [
      "pending",
      "running",
      "waiting",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "idle",
    ];
    expect(nativeAgentOutcomeSummary(statuses.map((status) => ({ status })))).toEqual({
      runningCount: 3,
      finishedCount: 1,
      failedCount: 1,
      stoppedCount: 2,
      idleCount: 1,
      label: "3 running · 1 finished · 1 failed · 2 stopped · 1 idle · resumable",
    });
  });

  it("omits outcomes that were not reported", () => {
    expect(nativeAgentOutcomeSummary([{ status: "failed" }]).label).toBe("1 failed");
    expect(nativeAgentOutcomeSummary([]).label).toBe("");
  });
});

describe("deriveNativeAgentRollup", () => {
  it("does not invent agents for imported threads or app-owned delegated tasks", () => {
    expect(deriveNativeAgentRollup({ runs: [], subagents: [] })).toEqual({
      groups: [],
      agents: [],
      hiddenSettledCount: 0,
      agentCount: 0,
    });
    expect(
      deriveNativeAgentRollup({ runs: [], subagents: [agent("task", { origin: "app_owned" })] })
        .agentCount,
    ).toBe(0);
  });

  it("retains all live work and only the newest 12 inactive agents", () => {
    const settled = Array.from({ length: 20 }, (_, index) =>
      agent(`settled-${index}`, {
        status: "completed",
        updatedAt: at(index + 10),
        completedAt: at(index + 10),
      }),
    );
    const live = Array.from({ length: 15 }, (_, index) => agent(`live-${index}`));
    const idle = agent("idle", { status: "idle", updatedAt: at(0) });
    const rollup = deriveNativeAgentRollup({ runs: [], subagents: [...settled, ...live, idle] });
    const retained = rollup.groups.flatMap((group) => group.agents);
    expect(rollup.agentCount).toBe(27);
    expect(rollup.hiddenSettledCount).toBe(9);
    expect(
      retained.filter((entry) => entry.status === "completed").map((entry) => entry.id),
    ).toEqual(
      settled
        .slice(8)
        .map((entry) => entry.id)
        .sort(),
    );
    expect(retained).not.toContain(idle);
    expect(retained.filter((entry) => entry.status === "running")).toHaveLength(15);
  });

  it("bounds idle history while preserving its resumable outcome", () => {
    const idle = Array.from({ length: 20 }, (_, index) =>
      agent(`idle-${index}`, { status: "idle", updatedAt: at(index + 10) }),
    );
    const rollup = deriveNativeAgentRollup({ runs: [], subagents: idle });
    expect(rollup.agentCount).toBe(12);
    expect(rollup.hiddenSettledCount).toBe(8);
    expect(new Set(rollup.agents)).toEqual(new Set(idle.slice(8)));
    expect(rollup.groups[0]?.summary.idleCount).toBe(12);
    expect(rollup.groups[0]?.summary.finishedCount).toBe(0);
  });

  it("shares one history cap across idle and terminal states without capping live states", () => {
    const history = Array.from({ length: 20 }, (_, index) =>
      agent(`history-${index}`, {
        status: index % 2 === 0 ? "idle" : "completed",
        updatedAt: at(index + 10),
      }),
    );
    const liveStatuses = ["pending", "running", "waiting"] as const;
    const live = liveStatuses.map((status) => agent(status, { status, updatedAt: at(0) }));
    const rollup = deriveNativeAgentRollup({ runs: [], subagents: [...history, ...live] });
    expect(new Set(rollup.agents)).toEqual(new Set([...history.slice(8), ...live]));
    expect(rollup.agentCount).toBe(15);
    expect(rollup.hiddenSettledCount).toBe(8);
  });

  it("exports the same ordered roster for flat sidebar and grouped card callers", () => {
    const rollup = deriveNativeAgentRollup({
      runs: [{ id: RunId.make("removed"), status: "rolled_back" }],
      subagents: [
        agent("b", { startedAt: at(3), updatedAt: at(20) }),
        agent("old", { runId: RunId.make("turn-0"), updatedAt: at(10) }),
        agent("a", { startedAt: at(3), updatedAt: at(15) }),
        agent("removed", { runId: RunId.make("removed"), status: "idle" }),
        agent("task", { origin: "app_owned" }),
      ],
    });
    expect(rollup.agents.map((entry) => entry.id)).toEqual(["old", "a", "b"]);
    expect(rollup.agents).toEqual(rollup.groups.flatMap((group) => group.agents));
    expect(rollup.agents).toHaveLength(rollup.agentCount);
    expect(rollup.hiddenSettledCount).toBe(0);
  });

  it("caps failed and stopped history too without discarding their reasons or links", () => {
    const stopped = Array.from({ length: 13 }, (_, index) =>
      agent(`stopped-${index}`, {
        status: index % 2 === 0 ? "cancelled" : "failed",
        updatedAt: at(index + 10),
        result: `Reason ${index}`,
        childThreadId: ThreadId.make(`child-${index}`),
      }),
    );
    const rollup = deriveNativeAgentRollup({ runs: [], subagents: stopped });
    expect(rollup.hiddenSettledCount).toBe(1);
    const latest = rollup.groups
      .flatMap((group) => group.agents)
      .find((entry) => entry.id === "stopped-12");
    expect(latest).toBe(stopped[12]);
    expect(latest?.result).toBe("Reason 12");
    expect(latest?.childThreadId).toBe("child-12");
  });

  it("groups by spawning run, ordering rows by start time and id", () => {
    const entries = [
      agent("b", { startedAt: at(3), updatedAt: at(20) }),
      agent("previous", { runId: RunId.make("turn-0"), status: "failed", updatedAt: at(10) }),
      agent("a", { startedAt: at(3), updatedAt: at(15) }),
      agent("first", { startedAt: at(1), updatedAt: at(15) }),
    ];
    const rollup = deriveNativeAgentRollup({ runs: [], subagents: entries });
    expect(rollup.groups.map((group) => group.label)).toEqual([
      "Earlier turn · 1 agent",
      "Latest turn · 3 agents",
    ]);
    expect(rollup.groups[0]?.expandedByDefault).toBe(false);
    expect(rollup.groups[1]?.agents.map((entry) => entry.id)).toEqual(["first", "a", "b"]);
    expect(rollup.groups[1]?.summary.runningCount).toBe(3);
  });

  it("opens older live groups and the latest settled group by default", () => {
    const rollup = deriveNativeAgentRollup({
      runs: [],
      subagents: [
        agent("old", { runId: RunId.make("turn-0") }),
        agent("new", { status: "completed", updatedAt: at(10) }),
      ],
    });
    expect(rollup.groups.map((group) => group.expandedByDefault)).toEqual([true, true]);
  });

  it("keeps agents with missing run attribution in separate groups", () => {
    const rollup = deriveNativeAgentRollup({
      runs: [],
      subagents: [agent("one", { runId: null }), agent("two", { runId: null })],
    });
    expect(rollup.groups.map((group) => group.key)).toEqual(["untracked:one", "untracked:two"]);
    expect(rollup.groups.every((group) => group.label === "Unattributed turn · 1 agent")).toBe(
      true,
    );
  });

  it("does not reintroduce rolled-back work but tolerates runs absent from partial history", () => {
    const rollup = deriveNativeAgentRollup({
      runs: [{ id: RunId.make("removed"), status: "rolled_back" }],
      subagents: [
        agent("removed-agent", { runId: RunId.make("removed") }),
        agent("partial-history"),
      ],
    });
    expect(rollup.groups.flatMap((group) => group.agents).map((entry) => entry.id)).toEqual([
      "partial-history",
    ]);
  });

  it("leaves projection arrays and records untouched across progress updates", () => {
    const entries = Object.freeze([Object.freeze(agent("z")), Object.freeze(agent("a"))]);
    const before = deriveNativeAgentRollup({ runs: [], subagents: entries });
    const after = deriveNativeAgentRollup({
      runs: [],
      subagents: entries.map((entry) =>
        entry.id === "a"
          ? {
              ...entry,
              status: "failed" as const,
              result: "Unable to read file",
              updatedAt: at(20),
            }
          : entry,
      ),
    });
    expect(entries.map((entry) => entry.id)).toEqual(["z", "a"]);
    expect(before.groups[0]?.summary.runningCount).toBe(2);
    expect(after.groups[0]?.summary.failedCount).toBe(1);
    expect(after.groups[0]?.agents[0]?.result).toBe("Unable to read file");
  });
});
