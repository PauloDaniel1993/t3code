import type { OrchestrationV2Subagent, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Partial snapshots omit history; only an authoritative full snapshot can remove it. */
export function retainKnownSubagents(
  previous: ReadonlyArray<OrchestrationV2Subagent>,
  incoming: ReadonlyArray<OrchestrationV2Subagent>,
) {
  const records = new Map(previous.map((agent) => [agent.id, agent]));
  for (const agent of incoming) {
    const old = records.get(agent.id);
    if (
      old !== undefined &&
      DateTime.toEpochMillis(agent.updatedAt) < DateTime.toEpochMillis(old.updatedAt)
    )
      continue;
    const deliveredAt =
      agent.completionDelivery?.deliveredAt ?? old?.completionDelivery?.deliveredAt;
    records.set(
      agent.id,
      deliveredAt !== undefined &&
        agent.completionDelivery !== undefined &&
        agent.completionDelivery.deliveredAt === undefined
        ? { ...agent, completionDelivery: { ...agent.completionDelivery, deliveredAt } }
        : agent,
    );
  }
  const next = [...records.values()];
  return next.length === previous.length && next.every((agent, index) => agent === previous[index])
    ? previous
    : next;
}

/** Keep known rollback markers alongside retained agents in a partial snapshot. */
export function retainKnownRuns(
  previous: OrchestrationV2ThreadProjection["runs"],
  incoming: OrchestrationV2ThreadProjection["runs"],
) {
  const records = new Map(previous.map((run) => [run.id, run]));
  for (const run of incoming) records.set(run.id, run);
  const next = [...records.values()];
  return next.length === previous.length && next.every((run, index) => run === previous[index])
    ? previous
    : next;
}
