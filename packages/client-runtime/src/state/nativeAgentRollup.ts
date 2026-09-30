/**
 * Shared native-agent selection for a thread's card, mobile history and sidebar.
 * Import deriveNativeAgentRollup from @t3tools/client-runtime/state/native-agent-rollup
 * and pass that thread's projection (or its runs and subagents arrays). Use groups
 * for turn labels, counters and disclosure defaults, or agents for a flat roster.
 * Both contain the same records: provider_native only, excluding known rolled-back
 * runs, all pending/running/waiting work, and the newest 12 idle or terminal agents
 * together. Missing runs in partial history are retained; null run IDs stay separate.
 * Groups run oldest to newest by latest update (key breaks ties); rows within each
 * group run by start time, falling back to update time, then ID. The flat roster
 * follows that group/row order. Callers should not reapply selection or history caps.
 * hiddenSettledCount includes omitted idle/resumable agents. It is a display window,
 * not deletion: older records remain in the transcript. Idle is never a success.
 */
import type { OrchestrationV2Subagent, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isActiveSubagentStatus } from "./subagentRuntime.ts";

/** One shared display window for idle/resumable and terminal agents. */
export const NATIVE_AGENT_SETTLED_WINDOW = 12;

export function nativeAgentOutcomeSummary(
  agents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status">>,
) {
  let runningCount = 0;
  let finishedCount = 0;
  let failedCount = 0;
  let stoppedCount = 0;
  let idleCount = 0;
  for (const agent of agents) {
    if (isActiveSubagentStatus(agent.status)) runningCount += 1;
    else if (agent.status === "completed") finishedCount += 1;
    else if (agent.status === "failed") failedCount += 1;
    else if (agent.status === "idle") idleCount += 1;
    else stoppedCount += 1;
  }
  const parts = [
    [runningCount, "running"],
    [finishedCount, "finished"],
    [failedCount, "failed"],
    [stoppedCount, "stopped"],
    [idleCount, "idle · resumable"],
  ] as const;
  return {
    runningCount,
    finishedCount,
    failedCount,
    stoppedCount,
    idleCount,
    label: parts
      .filter(([count]) => count > 0)
      .map(([count, label]) => `${count} ${label}`)
      .join(" · "),
  };
}

export interface NativeAgentRollupGroup {
  readonly key: string;
  readonly runId: OrchestrationV2Subagent["runId"];
  readonly agents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly summary: ReturnType<typeof nativeAgentOutcomeSummary>;
  readonly label: string;
  readonly expandedByDefault: boolean;
}

function startedAt(agent: OrchestrationV2Subagent): number {
  return DateTime.toEpochMillis(agent.startedAt ?? agent.updatedAt);
}

/** Provider-owned agents only: delegated T3 tasks keep V2's own roster. */
export function deriveNativeAgentRollup(projection: {
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["runs"][number], "id" | "status">
  >;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
}) {
  const rolledBackRuns = new Set(
    projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  const native = projection.subagents.filter(
    (agent) =>
      agent.origin === "provider_native" &&
      (agent.runId === null || !rolledBackRuns.has(agent.runId)),
  );
  const settled = native
    .filter((agent) => !isActiveSubagentStatus(agent.status))
    .sort(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
  const retained = [
    ...native.filter((agent) => isActiveSubagentStatus(agent.status)),
    ...settled.slice(0, NATIVE_AGENT_SETTLED_WINDOW),
  ];
  const byRun = new Map<string, OrchestrationV2Subagent[]>();
  for (const agent of retained) {
    // A missing run must not merge unrelated provider work into one turn.
    const key = agent.runId ?? `untracked:${agent.id}`;
    const group = byRun.get(key);
    if (group) group.push(agent);
    else byRun.set(key, [agent]);
  }
  const groups = [...byRun.entries()]
    .map(([key, agents]) => ({
      key,
      runId: agents[0]!.runId,
      agents: agents.sort(
        (left, right) => startedAt(left) - startedAt(right) || left.id.localeCompare(right.id),
      ),
      summary: nativeAgentOutcomeSummary(agents),
      latestAt: agents.reduce(
        (latest, agent) => Math.max(latest, DateTime.toEpochMillis(agent.updatedAt)),
        -Infinity,
      ),
    }))
    .sort((left, right) => left.latestAt - right.latestAt || left.key.localeCompare(right.key));
  return {
    agents: groups.flatMap((group) => group.agents),
    groups: groups.map((group, index): NativeAgentRollupGroup => {
      const latest = index === groups.length - 1;
      const count = group.agents.length;
      return {
        key: group.key,
        runId: group.runId,
        agents: group.agents,
        summary: group.summary,
        label: `${group.runId === null ? "Unattributed turn" : latest ? "Latest turn" : "Earlier turn"} · ${count} ${count === 1 ? "agent" : "agents"}`,
        expandedByDefault: latest || group.summary.runningCount > 0,
      };
    }),
    hiddenSettledCount: Math.max(0, settled.length - NATIVE_AGENT_SETTLED_WINDOW),
    agentCount: retained.length,
  };
}

export type NativeAgentRollup = ReturnType<typeof deriveNativeAgentRollup>;
