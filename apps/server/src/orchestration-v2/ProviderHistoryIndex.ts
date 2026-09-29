import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";

const indexes = new WeakMap<
  ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  { firstTurn: number; identities: ReadonlyMap<string, number> }
>();
/** Snapshot arrays are immutable. Build once; subsequent pages visit only their rows. */
export function providerHistoryIndex(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
  const cached = indexes.get(items);
  if (cached !== undefined) return cached;
  const identities = new Map<string, number>();
  let firstTurn = Number.POSITIVE_INFINITY;
  for (let i = 0; i < items.length; i++) {
    const row = items[i]!;
    const key = JSON.stringify([row.sourceThreadId, row.sourceItemId]);
    if (!identities.has(key)) identities.set(key, i);
    if (
      firstTurn === Number.POSITIVE_INFINITY &&
      row.item.type === "user_message" &&
      (row.item.inputIntent === "turn_start" || row.item.inputIntent === "queued_turn")
    )
      firstTurn = i;
  }
  const index = { firstTurn, identities };
  indexes.set(items, index);
  return index;
}
