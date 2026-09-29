import type { OrchestrationV2Subagent, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isActiveSubagentStatus, isTerminalSubagentStatus } from "./subagentRuntime.ts";

/** A display window only; the V2 records and the transcript remain intact. */
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
    .filter((agent) => isTerminalSubagentStatus(agent.status))
    .sort(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
  // Idle is resumable in V2. Like active work, it must not disappear behind
  // the fork's terminal-history cap or be counted as a successful result.
  const retained = [
    ...native.filter((agent) => !isTerminalSubagentStatus(agent.status)),
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
