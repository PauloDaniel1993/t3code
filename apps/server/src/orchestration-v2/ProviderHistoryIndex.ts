interface HistoryIndexRow {
  readonly sourceThreadId: string;
  readonly sourceItemId: string;
  readonly item?:
    | {
        readonly type: string;
        readonly createdBy?: string | undefined;
        readonly inputIntent?: string | undefined;
      }
    | undefined;
}

const indexes = new WeakMap<
  ReadonlyArray<HistoryIndexRow>,
  { firstTurn: number; firstUserTurn: number; identities: ReadonlyMap<string, number> }
>();
/** Snapshot arrays are immutable. Build once; subsequent pages visit only their rows. */
export function providerHistoryIndex(items: ReadonlyArray<HistoryIndexRow>) {
  const cached = indexes.get(items);
  if (cached !== undefined) return cached;
  const identities = new Map<string, number>();
  let firstTurn = Number.POSITIVE_INFINITY;
  let firstUserTurn = Number.POSITIVE_INFINITY;
  for (let i = 0; i < items.length; i++) {
    const row = items[i]!;
    const key = JSON.stringify([row.sourceThreadId, row.sourceItemId]);
    if (!identities.has(key)) identities.set(key, i);
    if (
      firstUserTurn === Number.POSITIVE_INFINITY &&
      row.item?.type === "user_message" &&
      row.item.createdBy === "user" &&
      (row.item.inputIntent === "turn_start" || row.item.inputIntent === "queued_turn")
    )
      firstUserTurn = i;
    if (
      firstTurn === Number.POSITIVE_INFINITY &&
      row.item?.type === "user_message" &&
      (row.item.inputIntent === "turn_start" || row.item.inputIntent === "queued_turn")
    )
      firstTurn = i;
  }
  const index = { firstTurn, firstUserTurn, identities };
  indexes.set(items, index);
  return index;
}
