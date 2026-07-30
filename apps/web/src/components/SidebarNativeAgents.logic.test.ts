import type { ThreadNativeAgent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatNativeAgentGroupLabel,
  formatNativeAgentStatusLine,
  formatNativeAgentUsage,
  groupNativeAgentsByTurn,
  nativeAgentGroupStartsExpanded,
  resolveNativeAgentBody,
} from "./SidebarNativeAgents.logic";

const NOW = Date.parse("2026-07-29T10:10:00.000Z");

// `turnId` is a branded `TurnId` on the contract; the fixtures use plain
// strings because the grouping only ever compares them for equality.
function agent(
  overrides: Omit<Partial<ThreadNativeAgent>, "turnId"> & {
    taskId: string;
    turnId?: string | null;
  },
): ThreadNativeAgent {
  return {
    turnId: null,
    status: "running",
    description: overrides.taskId,
    startedAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    ...overrides,
  } as ThreadNativeAgent;
}

describe("groupNativeAgentsByTurn", () => {
  it("groups by turn, oldest group first, counting each status", () => {
    const groups = groupNativeAgentsByTurn([
      agent({
        taskId: "b1",
        turnId: "turn-b",
        status: "running",
        updatedAt: "2026-07-29T10:05:00.000Z",
      }),
      agent({
        taskId: "a1",
        turnId: "turn-a",
        status: "finished",
        updatedAt: "2026-07-29T10:01:00.000Z",
      }),
      agent({
        taskId: "a2",
        turnId: "turn-a",
        status: "failed",
        updatedAt: "2026-07-29T10:02:00.000Z",
      }),
    ]);

    expect(groups.map((group) => group.turnId)).toEqual(["turn-a", "turn-b"]);
    expect(groups[0]).toMatchObject({
      finishedCount: 1,
      failedCount: 1,
      runningCount: 0,
      isLatest: false,
    });
    expect(groups[1]).toMatchObject({ runningCount: 1, isLatest: true });
  });

  it("keeps agents without a turn in separate groups", () => {
    // Two unattributed runs are not evidence they shared a turn; merging them
    // would invent a grouping the data never reported.
    const groups = groupNativeAgentsByTurn([agent({ taskId: "x" }), agent({ taskId: "y" })]);
    expect(groups).toHaveLength(2);
  });

  it("orders agents inside a group by start time", () => {
    const groups = groupNativeAgentsByTurn([
      agent({ taskId: "second", turnId: "t", startedAt: "2026-07-29T10:00:30.000Z" }),
      agent({ taskId: "first", turnId: "t", startedAt: "2026-07-29T10:00:00.000Z" }),
    ]);
    expect(groups[0]?.agents.map((a) => a.taskId)).toEqual(["first", "second"]);
  });

  it("returns nothing for a thread that never spawned one", () => {
    expect(groupNativeAgentsByTurn([])).toEqual([]);
  });
});

describe("formatNativeAgentGroupLabel", () => {
  it("labels the newest group relatively rather than with a turn ordinal", () => {
    const [older, latest] = groupNativeAgentsByTurn([
      agent({ taskId: "a", turnId: "turn-a", updatedAt: "2026-07-29T10:05:00.000Z" }),
      agent({ taskId: "b1", turnId: "turn-b", updatedAt: "2026-07-29T10:08:00.000Z" }),
      agent({ taskId: "b2", turnId: "turn-b", updatedAt: "2026-07-29T10:08:00.000Z" }),
    ]);

    expect(formatNativeAgentGroupLabel({ group: latest!, nowMs: NOW })).toBe(
      "Latest turn · 2 agents",
    );
    expect(formatNativeAgentGroupLabel({ group: older!, nowMs: NOW })).toBe("5m ago · 1 agent");
  });
});

describe("nativeAgentGroupStartsExpanded", () => {
  it("opens any group with live work, however old", () => {
    const [stale] = groupNativeAgentsByTurn([
      agent({
        taskId: "old",
        turnId: "turn-old",
        status: "running",
        updatedAt: "2026-07-20T10:00:00.000Z",
      }),
      agent({
        taskId: "new",
        turnId: "turn-new",
        status: "finished",
        updatedAt: "2026-07-29T10:09:00.000Z",
      }),
    ]);
    expect(stale?.isLatest).toBe(false);
    expect(nativeAgentGroupStartsExpanded(stale!)).toBe(true);
  });

  it("leaves an old, fully settled group collapsed", () => {
    const [older] = groupNativeAgentsByTurn([
      agent({
        taskId: "a",
        turnId: "turn-a",
        status: "finished",
        updatedAt: "2026-07-29T10:00:00.000Z",
      }),
      agent({
        taskId: "b",
        turnId: "turn-b",
        status: "finished",
        updatedAt: "2026-07-29T10:09:00.000Z",
      }),
    ]);
    expect(nativeAgentGroupStartsExpanded(older!)).toBe(false);
  });
});

describe("formatNativeAgentStatusLine", () => {
  it("reads differently per status", () => {
    expect(
      formatNativeAgentStatusLine({ agent: agent({ taskId: "w", status: "running" }), nowMs: NOW }),
    ).toBe("Running · 10m");
    expect(
      formatNativeAgentStatusLine({
        agent: agent({ taskId: "w", status: "failed", updatedAt: "2026-07-29T10:00:34.000Z" }),
        nowMs: NOW,
      }),
    ).toBe("Failed · after 34s");
    expect(
      formatNativeAgentStatusLine({
        agent: agent({ taskId: "w", status: "finished", updatedAt: "2026-07-29T10:02:00.000Z" }),
        nowMs: NOW,
      }),
    ).toBe("Finished · ran 2m");
  });
});

describe("formatNativeAgentUsage", () => {
  it("omits counters the provider never reported", () => {
    expect(formatNativeAgentUsage(undefined)).toEqual([]);
    expect(formatNativeAgentUsage({})).toEqual([]);
    expect(formatNativeAgentUsage({ toolUses: 1 })).toEqual(["1 tool"]);
    expect(formatNativeAgentUsage({ totalTokens: 21_700, toolUses: 9 })).toEqual([
      "21.7k tok",
      "9 tools",
    ]);
    expect(formatNativeAgentUsage({ totalTokens: 900 })).toEqual(["900 tok"]);
  });
});

describe("resolveNativeAgentBody", () => {
  it("says so when a running agent has reported nothing yet", () => {
    expect(resolveNativeAgentBody(agent({ taskId: "w" }))).toEqual({
      tone: "pending",
      text: "No progress reported yet.",
    });
  });

  it("prefers the error, then the result, then rolling progress", () => {
    expect(
      resolveNativeAgentBody(
        agent({ taskId: "w", status: "failed", errorMessage: "Budget exceeded" }),
      ),
    ).toMatchObject({ tone: "error", text: "Budget exceeded" });
    expect(
      resolveNativeAgentBody(agent({ taskId: "w", status: "finished", resultSummary: "3 gaps" })),
    ).toMatchObject({ tone: "result", text: "3 gaps" });
    expect(
      resolveNativeAgentBody(agent({ taskId: "w", status: "running", progressSummary: "7 of 12" })),
    ).toMatchObject({ tone: "progress", text: "7 of 12" });
  });

  it("degrades visibly when a terminal state carries no text", () => {
    expect(resolveNativeAgentBody(agent({ taskId: "w", status: "finished" })).text).toBe(
      "Finished without reporting a summary.",
    );
  });
});
