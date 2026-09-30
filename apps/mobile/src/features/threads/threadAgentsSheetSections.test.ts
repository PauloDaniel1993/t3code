import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { deriveNativeAgentRollup } from "@t3tools/client-runtime/state/native-agent-rollup";
import {
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  resolveSubagentPillSegment,
  type ThreadTurnSubagents,
} from "@t3tools/client-runtime/state/thread-subagents";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveThreadAgentsSheetSections } from "./threadAgentsSheetSections";

const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1_000);
function agent(
  id: string,
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("parent"),
    runId: RunId.make("current"),
    parentNodeId: NodeId.make("parent-node"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("antigravity"),
    providerInstanceId: ProviderInstanceId.make("antigravity"),
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    title: id,
    prompt: "Inspect the module",
    model: null,
    status: "completed",
    result: "Done",
    startedAt: at(1),
    completedAt: at(2),
    updatedAt: at(2),
    ...overrides,
  };
}

function turn(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  turnActive = false,
): ThreadTurnSubagents {
  return {
    runId: subagents[0]?.runId ?? null,
    subagents,
    turnActive,
    liveCount: subagents.filter((entry) => isActiveSubagentStatus(entry.status)).length,
    settledCount: subagents.filter((entry) => isTerminalSubagentStatus(entry.status)).length,
  };
}

describe("thread agents sheet sections", () => {
  it("keeps the complete current roster in order without duplicating it in history", () => {
    const current = [agent("task", { origin: "app_owned", status: "waiting" }), agent("native")];
    const old = agent("old", { runId: RunId.make("earlier") });
    const sections = deriveThreadAgentsSheetSections({
      turn: turn(current, true),
      turnRunStatus: "running",
      rollup: deriveNativeAgentRollup({ runs: [], subagents: [...current, old] }),
    });
    expect(sections.subagents).toBe(current);
    expect(sections.currentNativeAgents).toEqual([current[1]]);
    expect(sections.hasLiveAgent).toBe(true);
    expect(sections.nativeHistory.flatMap((group) => group.agents)).toEqual([old]);
  });

  it("hides a rolled-back roster and its live state while keeping valid older history", () => {
    const current = [
      agent("removed", { status: "running" }),
      agent("task", { origin: "app_owned" }),
    ];
    const old = agent("old", { runId: RunId.make("earlier") });
    const sections = deriveThreadAgentsSheetSections({
      turn: turn(current),
      turnRunStatus: "rolled_back",
      rollup: deriveNativeAgentRollup({
        runs: [{ id: RunId.make("current"), status: "rolled_back" }],
        subagents: [...current, old],
      }),
    });
    expect(sections.subagents).toEqual([]);
    expect(sections.currentNativeAgents).toEqual([]);
    expect(sections.hasLiveAgent).toBe(false);
    expect(sections.nativeHistory.flatMap((group) => group.agents)).toEqual([old]);
  });

  it("does not duplicate unattributed agents and tolerates a missing run record", () => {
    const current = [agent("one", { runId: null }), agent("two", { runId: null })];
    const sections = deriveThreadAgentsSheetSections({
      turn: turn(current),
      turnRunStatus: undefined,
      rollup: deriveNativeAgentRollup({ runs: [], subagents: current }),
    });
    expect(sections.subagents).toBe(current);
    expect(sections.nativeHistory).toEqual([]);
  });

  it("shows history without a current roster and leaves imported threads empty", () => {
    const rollup = deriveNativeAgentRollup({ runs: [], subagents: [agent("history")] });
    expect(
      deriveThreadAgentsSheetSections({ turn: null, turnRunStatus: undefined, rollup })
        .nativeHistory,
    ).toEqual(rollup.groups);
    const empty = deriveThreadAgentsSheetSections({
      turn: null,
      turnRunStatus: undefined,
      rollup: deriveNativeAgentRollup({ runs: [], subagents: [] }),
    });
    expect(empty.subagents).toEqual([]);
    expect(empty.nativeHistory).toEqual([]);
    expect(empty.hiddenHistoryCount).toBe(0);
  });

  it("does not show an older-history notice when only the full current roster is displayed", () => {
    const current = Array.from({ length: 20 }, (_, index) =>
      agent(`current-${index}`, { status: "idle", updatedAt: at(index + 10) }),
    );
    const rollup = deriveNativeAgentRollup({ runs: [], subagents: current });
    expect(rollup.hiddenSettledCount).toBe(8);
    const sections = deriveThreadAgentsSheetSections({
      turn: turn(current),
      turnRunStatus: "completed",
      rollup,
    });
    expect(sections.subagents).toHaveLength(20);
    expect(sections.nativeHistory).toEqual([]);
    expect(sections.hiddenHistoryCount).toBe(0);
  });

  it("reports omitted older idle agents only beside the bounded history section", () => {
    const old = Array.from({ length: 20 }, (_, index) =>
      agent(`old-${index}`, {
        runId: RunId.make("earlier"),
        status: "idle",
        updatedAt: at(index + 10),
      }),
    );
    const current = [agent("current", { updatedAt: at(100) })];
    const sections = deriveThreadAgentsSheetSections({
      turn: turn(current),
      turnRunStatus: "completed",
      rollup: deriveNativeAgentRollup({ runs: [], subagents: [...old, ...current] }),
    });
    expect(new Set(sections.nativeHistory.flatMap((group) => group.agents))).toEqual(
      new Set(old.slice(9)),
    );
    expect(sections.hiddenHistoryCount).toBe(9);
  });

  it("does not count agents already visible in the complete current roster as hidden history", () => {
    const current = Array.from({ length: 13 }, (_, index) =>
      agent(`current-${index}`, { updatedAt: at(index + 10) }),
    );
    const old = agent("old", { runId: RunId.make("earlier"), updatedAt: at(100) });
    const sections = deriveThreadAgentsSheetSections({
      turn: turn(current),
      turnRunStatus: "completed",
      rollup: deriveNativeAgentRollup({ runs: [], subagents: [...current, old] }),
    });
    expect(sections.subagents).toHaveLength(13);
    expect(sections.nativeHistory.flatMap((group) => group.agents)).toEqual([old]);
    expect(sections.hiddenHistoryCount).toBe(0);
  });
});

describe("V2 mobile agents pill", () => {
  it("hides after settlement for completed and idle agents even when history remains", () => {
    for (const status of ["completed", "idle"] as const) {
      const current = [agent(status, { status })];
      expect(deriveNativeAgentRollup({ runs: [], subagents: current }).agentCount).toBe(1);
      expect(resolveSubagentPillSegment(turn(current))).toBeNull();
    }
  });

  it("keeps the active-turn and outstanding-work meanings of V2's pill", () => {
    expect(resolveSubagentPillSegment(turn([agent("done")], true))?.label).toBe("1 done");
    const current = [
      agent("pending", { status: "pending" }),
      agent("waiting", { status: "waiting" }),
      agent("done"),
    ];
    expect(resolveSubagentPillSegment(turn(current))?.label).toBe("2/3");
  });
});
