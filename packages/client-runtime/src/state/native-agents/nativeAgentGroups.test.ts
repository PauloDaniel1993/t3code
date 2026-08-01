import type { ThreadNativeAgent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatTaskGroupChipLabel,
  resolveNativeAgentPeekChips,
  resolveNativeAgentRetryLinks,
} from "./nativeAgentGroups.ts";

// `turnId` is a branded `TurnId` on the contract; the fixtures use plain
// strings because none of these rules compare it.
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

describe("formatTaskGroupChipLabel", () => {
  it("names each kind in the group rather than summing them", () => {
    expect(formatTaskGroupChipLabel({ taskCount: 2, nativeAgentCount: 4 })).toBe(
      "2 tasks · 4 agents",
    );
    expect(formatTaskGroupChipLabel({ taskCount: 0, nativeAgentCount: 3 })).toBe("3 agents");
    expect(formatTaskGroupChipLabel({ taskCount: 2, nativeAgentCount: 0 })).toBe("2 tasks");
  });

  it("singularizes each side independently", () => {
    expect(formatTaskGroupChipLabel({ taskCount: 1, nativeAgentCount: 1 })).toBe(
      "1 task · 1 agent",
    );
  });

  it("renders nothing for a thread with no grouped work", () => {
    expect(formatTaskGroupChipLabel({ taskCount: 0, nativeAgentCount: 0 })).toBe("");
  });
});

describe("resolveNativeAgentPeekChips", () => {
  it("leads with the kind chip — the one thing that must be read first", () => {
    const chips = resolveNativeAgentPeekChips(agent({ taskId: "w" }));
    expect(chips[0]).toEqual({ id: "kind", label: "in-session agent", tone: "kind" });
  });

  it("includes the subagent type only when the provider reported one", () => {
    expect(
      resolveNativeAgentPeekChips(agent({ taskId: "w", subagentType: "Explore" })).map(
        (chip) => chip.label,
      ),
    ).toEqual(["in-session agent", "Explore"]);
    expect(resolveNativeAgentPeekChips(agent({ taskId: "w" })).map((chip) => chip.label)).toEqual([
      "in-session agent",
    ]);
  });

  it("appends only the usage counters that exist, never zeros", () => {
    expect(
      resolveNativeAgentPeekChips(
        agent({
          taskId: "w",
          subagentType: "general-purpose",
          usage: { totalTokens: 21_700, toolUses: 9 },
        }),
      ).map((chip) => chip.label),
    ).toEqual(["in-session agent", "general-purpose", "21.7k tok", "9 tools"]);
    expect(
      resolveNativeAgentPeekChips(agent({ taskId: "w", usage: {} })).map((chip) => chip.label),
    ).toEqual(["in-session agent"]);
  });
});

describe("resolveNativeAgentRetryLinks", () => {
  it("is empty for a run with no linkage", () => {
    expect(resolveNativeAgentRetryLinks(agent({ taskId: "w" }), [])).toEqual([]);
  });

  it("points a retry at the earlier run when it is still in the set", () => {
    const earlier = agent({ taskId: "w3", status: "failed", description: "Locate fs gates" });
    const retry = agent({ taskId: "w4", retryOfTaskId: "w3" });
    const links = resolveNativeAgentRetryLinks(retry, [earlier, retry]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      direction: "retryOf",
      targetTaskId: "w3",
      label: "Retry of Locate fs gates",
    });
    expect(links[0]?.target?.taskId).toBe("w3");
  });

  it("points a failed run at its replacement", () => {
    const retry = agent({ taskId: "w4", description: "Locate fs gates" });
    const failed = agent({ taskId: "w3", status: "failed", retriedByTaskId: "w4" });
    const links = resolveNativeAgentRetryLinks(failed, [failed, retry]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      direction: "retriedBy",
      targetTaskId: "w4",
      label: "Retried by Locate fs gates",
    });
  });

  it("stays honest but inert when the other run has dropped out of the set", () => {
    // `nativeAgents` is bounded; the other side of a linkage may be gone, and
    // then there is nothing the peek could swap to.
    const links = resolveNativeAgentRetryLinks(agent({ taskId: "w4", retryOfTaskId: "w3" }), []);
    expect(links).toEqual([
      { direction: "retryOf", targetTaskId: "w3", target: null, label: "Retry of an earlier run" },
    ]);
    const backLinks = resolveNativeAgentRetryLinks(
      agent({ taskId: "w3", retriedByTaskId: "w4" }),
      [],
    );
    expect(backLinks).toEqual([
      { direction: "retriedBy", targetTaskId: "w4", target: null, label: "Retried by a later run" },
    ]);
  });

  it("reports both directions when a retry was itself retried", () => {
    const middle = agent({ taskId: "w2", retryOfTaskId: "w1", retriedByTaskId: "w3" });
    const links = resolveNativeAgentRetryLinks(middle, [
      agent({ taskId: "w1" }),
      middle,
      agent({ taskId: "w3" }),
    ]);
    expect(links.map((link) => link.direction)).toEqual(["retryOf", "retriedBy"]);
  });
});
