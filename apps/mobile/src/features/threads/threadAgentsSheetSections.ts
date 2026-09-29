import type { NativeAgentRollup } from "@t3tools/client-runtime/state/native-agent-rollup";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { ThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import type { OrchestrationV2Run } from "@t3tools/contracts";

/** Keep V2's complete turn roster beside the shared, bounded native history. */
export function deriveThreadAgentsSheetSections(input: {
  readonly turn: ThreadTurnSubagents | null;
  readonly turnRunStatus: OrchestrationV2Run["status"] | undefined;
  readonly rollup: NativeAgentRollup;
}) {
  const subagents = input.turnRunStatus === "rolled_back" ? [] : (input.turn?.subagents ?? []);
  // The turn roster contains every agent from its run, including unattributed
  // work. Exclude that run's groups, not just a subset of their rows.
  const nativeHistory = input.rollup.groups.filter(
    (group) => subagents.length === 0 || group.runId !== input.turn?.runId,
  );
  const retainedIds = new Set(input.rollup.agents.map((agent) => agent.id));
  const hiddenCurrentCount = subagents.filter(
    (agent) =>
      agent.origin === "provider_native" &&
      !isActiveSubagentStatus(agent.status) &&
      !retainedIds.has(agent.id),
  ).length;
  return {
    subagents,
    hasLiveAgent: subagents.some((agent) => isActiveSubagentStatus(agent.status)),
    currentNativeAgents: subagents.filter((agent) => agent.origin === "provider_native"),
    nativeHistory,
    hiddenHistoryCount:
      nativeHistory.length > 0
        ? Math.max(0, input.rollup.hiddenSettledCount - hiddenCurrentCount)
        : 0,
  };
}
