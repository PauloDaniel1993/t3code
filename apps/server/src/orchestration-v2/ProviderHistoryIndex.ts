interface HistoryIndexRow {
  readonly sourceThreadId: string;
  readonly sourceItemId: string;
  readonly item?:
    | {
        readonly type: string;
        readonly createdBy?: string | undefined;
        readonly inputIntent?: string | undefined;
        readonly runId?: string | null | undefined;
      }
    | undefined;
}

const indexes = new WeakMap<
  ReadonlyArray<HistoryIndexRow>,
  {
    firstTurn: number;
    firstUserTurn: number;
    turnStarts: ReadonlyArray<boolean>;
    identities: ReadonlyMap<string, number>;
  }
>();
/** Snapshot arrays are immutable. Build once; subsequent pages visit only their rows. */
export function providerHistoryIndex(items: ReadonlyArray<HistoryIndexRow>) {
  const cached = indexes.get(items);
  if (cached !== undefined) return cached;
  const identities = new Map<string, number>();
  const turnStarts: boolean[] = [];
  const startedRuns = new Set<string>();
  let firstTurn = Number.POSITIVE_INFINITY;
  let firstUserTurn = Number.POSITIVE_INFINITY;
  for (let i = 0; i < items.length; i++) {
    const row = items[i]!;
    const item = row.item;
    const input = item?.type === "user_message" || item?.type === "notification";
    const firstInput = input && item.runId != null && !startedRuns.has(item.runId);
    if (input && item.runId != null) startedRuns.add(item.runId);
    const startsTurn =
      item?.type === "notification"
        ? firstInput
        : item?.type === "user_message" &&
          (item.inputIntent === "turn_start" || item.inputIntent === "queued_turn");
    turnStarts.push(startsTurn);
    const key = JSON.stringify([row.sourceThreadId, row.sourceItemId]);
    if (!identities.has(key)) identities.set(key, i);
    if (
      firstUserTurn === Number.POSITIVE_INFINITY &&
      row.item?.type === "user_message" &&
      row.item.createdBy === "user" &&
      (row.item.inputIntent === "turn_start" || row.item.inputIntent === "queued_turn")
    )
      firstUserTurn = i;
    if (firstTurn === Number.POSITIVE_INFINITY && startsTurn) firstTurn = i;
  }
  const index = { firstTurn, firstUserTurn, turnStarts, identities };
  indexes.set(items, index);
  return index;
}
