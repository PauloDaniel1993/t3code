import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

import { retainProviderHistoryGraph } from "./ProviderHistoryRetention.ts";
import { providerHistoryIndex } from "./ProviderHistoryIndex.ts";

/**
 * Prefer complete user turns, but split oversized turns with the same resumable
 * cursor used for histories without turn starts.
 */
export const THREAD_HISTORY_PAGE_POLICY = {
  maxUserTurns: 10,
  maxItems: 75,
  maxEncodedBytes: 1_048_576,
} as const;

export const OLDER_THREAD_USER_TURN_LIMIT = 20;

export function isConversationHistoryItem(item: Pick<OrchestrationV2TurnItem, "type">): boolean {
  return !["command_execution", "reasoning", "file_change", "dynamic_tool"].includes(item.type);
}
export const THREAD_HISTORY_MAX_RAW_TURNS = 150;
export const THREAD_HISTORY_MAX_ITEMS_WITHIN_TURNS = 200;

/** Extra rows let the projection query retain an inclusive cursor and prove another page exists. */
export const THREAD_HISTORY_SNAPSHOT_ROW_LIMIT = THREAD_HISTORY_MAX_ITEMS_WITHIN_TURNS + 2;

const THREAD_HISTORY_CURSOR_MAX_LENGTH = 4_096;

export type ThreadHistoryPagePolicy = {
  readonly maxUserTurns?: number | undefined;
  readonly maxItems: number;
  readonly maxEncodedBytes: number;
};

export type ThreadHistoryCursorPayload = {
  readonly v: 1;
  readonly seq: number;
  readonly st: string;
  readonly si: string;
  readonly p: number;
};

type HistoryRow = Pick<
  OrchestrationV2ProjectedTurnItem,
  "position" | "visibility" | "sourceThreadId" | "sourceItemId"
> & {
  readonly item: Pick<OrchestrationV2TurnItem, "type"> & {
    readonly id?: string;
    readonly messageId?: string;
    readonly inputIntent?: string;
    readonly createdBy?: string;
    readonly runId?: string | null;
  };
};
export type SelectTimelinePageResult<Row extends HistoryRow = OrchestrationV2ProjectedTurnItem> = {
  readonly items: ReadonlyArray<Row>;
  readonly nextCursor: string | null;
  readonly hasMoreHistory: boolean;
};

export type BoundedProjectionResult = {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  readonly latestLocalTurnOrdinal: number | null;
  readonly payloadBudgetExceeded: boolean;
};

export class InvalidThreadHistoryCursorError extends Error {
  readonly _tag = "InvalidThreadHistoryCursorError";
  constructor(message = "Invalid thread history cursor.") {
    super(message);
    this.name = "InvalidThreadHistoryCursorError";
  }
}

function bytesOfJson(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Proves overflow without serializing: a string's UTF-16 length never exceeds
 * its UTF-8 JSON bytes, and local items are encoded once per array they sit in.
 */
function timelineTextExceedsBudget(
  projection: OrchestrationV2ThreadProjection,
  budget: number,
): boolean {
  let length = 0;
  const exceeds = (item: OrchestrationV2TurnItem): boolean => {
    if ("text" in item) {
      length += item.text.length;
    }
    return length > budget;
  };
  return (
    projection.visibleTurnItems.some((row) => exceeds(row.item)) ||
    projection.turnItems.some(exceeds)
  );
}

export function projectedRowEncodedBytes(row: HistoryRow): number {
  return bytesOfJson(row);
}

/**
 * Bounded-snapshot cost: local rows also land in `projection.turnItems`, so
 * charge the nested item a second time. Inherited rows only appear in the
 * visible list.
 */
export function projectedRowBoundedSnapshotEncodedBytes(
  row: OrchestrationV2ProjectedTurnItem,
  threadId: ThreadId | string,
): number {
  const rowBytes = projectedRowEncodedBytes(row);
  if (row.visibility === "local" || String(row.sourceThreadId) === String(threadId)) {
    return rowBytes + bytesOfJson(row.item);
  }
  return rowBytes;
}

function renumberPositions<Row extends HistoryRow>(items: ReadonlyArray<Row>): Row[] {
  return items.map((row, position) => (row.position === position ? row : { ...row, position }));
}

function encodeCursorPayload(payload: ThreadHistoryCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function encodeThreadHistoryCursor(input: {
  readonly snapshotSequence: number;
  readonly sourceThreadId: ThreadId | string;
  readonly sourceItemId: TurnItemId | string;
  readonly position: number;
}): string {
  return encodeCursorPayload({
    v: 1,
    seq: input.snapshotSequence,
    st: String(input.sourceThreadId),
    si: String(input.sourceItemId),
    p: input.position,
  });
}

export function decodeThreadHistoryCursor(cursor: string): ThreadHistoryCursorPayload {
  if (cursor.length === 0 || cursor.length > THREAD_HISTORY_CURSOR_MAX_LENGTH) {
    throw new InvalidThreadHistoryCursorError();
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new InvalidThreadHistoryCursorError();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("v" in parsed) ||
    (parsed as { v: unknown }).v !== 1 ||
    !("seq" in parsed) ||
    typeof (parsed as { seq: unknown }).seq !== "number" ||
    !Number.isInteger((parsed as { seq: number }).seq) ||
    (parsed as { seq: number }).seq < 0 ||
    !("st" in parsed) ||
    typeof (parsed as { st: unknown }).st !== "string" ||
    (parsed as { st: string }).st.length === 0 ||
    !("si" in parsed) ||
    typeof (parsed as { si: unknown }).si !== "string" ||
    (parsed as { si: string }).si.length === 0 ||
    !("p" in parsed) ||
    typeof (parsed as { p: unknown }).p !== "number" ||
    !Number.isInteger((parsed as { p: number }).p) ||
    (parsed as { p: number }).p < 0
  ) {
    throw new InvalidThreadHistoryCursorError();
  }
  return parsed as ThreadHistoryCursorPayload;
}

function isThreadHistoryTurnStart(item: HistoryRow["item"]): boolean {
  return (
    item.type === "user_message" &&
    (item.inputIntent === "turn_start" || item.inputIntent === "queued_turn")
  );
}

/**
 * A wake (PR watch, task completion) starts its run with a notification instead of a user message, so a
 * notification starts a turn when it is its run's first input. ProjectionStore's `run_starts` window query
 * applies the same rule.
 */
export function threadHistoryTurnStarts(
  items: ReadonlyArray<HistoryRow["item"]>,
): ReadonlyArray<boolean> {
  const startedRuns = new Set<string>();
  return items.map((item) => {
    if (item.type !== "user_message" && item.type !== "notification") return false;
    const firstInput = item.runId != null && !startedRuns.has(item.runId);
    if (item.runId != null) startedRuns.add(item.runId);
    return item.type === "notification" ? firstInput : isThreadHistoryTurnStart(item);
  });
}

export function isThreadHistoryUserTurn(item: HistoryRow["item"]): boolean {
  return (
    isThreadHistoryTurnStart(item) && item.type === "user_message" && item.createdBy === "user"
  );
}

/**
 * Walk a chronological timeline backward from the exclusive end, collecting rows
 * through user turns, subject to row/byte budgets even within a long turn.
 * Always admit at least one row so oversized items cannot deadlock paging.
 */
function selectOlderTimelinePage<Row extends HistoryRow>(input: {
  readonly items: ReadonlyArray<Row>;
  readonly exclusiveEndIndex: number;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly rowEncodedBytes?: ((row: Row) => number) | undefined;
}): SelectTimelinePageResult<Row> {
  const policy = input.policy ?? THREAD_HISTORY_PAGE_POLICY;
  const rowCost = input.rowEncodedBytes ?? projectedRowEncodedBytes;
  const end = Math.min(Math.max(input.exclusiveEndIndex, 0), input.items.length);
  if (end <= 0) {
    return { items: [], nextCursor: null, hasMoreHistory: false };
  }

  const selected: Row[] = [];
  let encodedBytes = 0;
  let userTurns = 0;
  let rawTurns = 0;
  const index = providerHistoryIndex(input.items);
  const turnStarts = index.turnStarts;
  const turnLimit = index.firstTurn < end ? policy.maxUserTurns : undefined;
  const maxItems =
    turnLimit === undefined
      ? policy.maxItems
      : Math.max(policy.maxItems, THREAD_HISTORY_MAX_ITEMS_WITHIN_TURNS);
  for (let index = end - 1; index >= 0; index -= 1) {
    const row = input.items[index]!;
    const rowBytes = rowCost(row);
    if (
      selected.length > 0 &&
      (selected.length >= maxItems ||
        encodedBytes + rowBytes > policy.maxEncodedBytes ||
        (turnLimit !== undefined &&
          (userTurns >= turnLimit || rawTurns >= THREAD_HISTORY_MAX_RAW_TURNS)))
    ) {
      break;
    }
    selected.push(row);
    encodedBytes += rowBytes;
    if (isThreadHistoryUserTurn(row.item)) userTurns += 1;
    if (turnStarts[index]) rawTurns += 1;
  }
  selected.reverse();
  // Keep complete recent turns whenever a boundary fits. An oversized single
  // turn still pages at the hard item/byte limit instead of defeating it.
  const selectedStart = end - selected.length;
  const firstCompleteTurn = selected.findIndex((_, offset) => turnStarts[selectedStart + offset]);
  if (turnLimit !== undefined && firstCompleteTurn > 0) selected.splice(0, firstCompleteTurn);

  const oldest = selected[0];
  const oldestIndex = end - selected.length;
  const hasMoreHistory = oldestIndex > 0;
  const nextCursor =
    hasMoreHistory && oldest
      ? encodeThreadHistoryCursor({
          snapshotSequence: input.snapshotSequence,
          sourceThreadId: oldest.sourceThreadId,
          sourceItemId: oldest.sourceItemId,
          position: oldest.position,
        })
      : null;

  return {
    items: renumberPositions(selected),
    nextCursor,
    hasMoreHistory,
  };
}

export function selectRecentTimelineWindow(input: {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly rowEncodedBytes?: ((row: OrchestrationV2ProjectedTurnItem) => number) | undefined;
}): SelectTimelinePageResult {
  return selectOlderTimelinePage({
    items: input.items,
    exclusiveEndIndex: input.items.length,
    snapshotSequence: input.snapshotSequence,
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...(input.rowEncodedBytes === undefined ? {} : { rowEncodedBytes: input.rowEncodedBytes }),
  });
}

function findCursorIndex(
  items: ReadonlyArray<Pick<HistoryRow, "sourceThreadId" | "sourceItemId">>,
  cursor: ThreadHistoryCursorPayload,
): number {
  const byIdentity = providerHistoryIndex(items).identities.get(
    JSON.stringify([cursor.st, cursor.si]),
  );
  if (byIdentity !== undefined) {
    return byIdentity;
  }
  return Math.min(cursor.p, items.length);
}

export function selectHistoryPageFromCursor<Row extends HistoryRow>(input: {
  readonly items: ReadonlyArray<Row>;
  readonly cursor: string;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly rowEncodedBytes?: ((row: Row) => number) | undefined;
  readonly throughEntryId?: string | undefined;
}): SelectTimelinePageResult<Row> {
  const decoded = decodeThreadHistoryCursor(input.cursor);
  const anchorIndex = findCursorIndex(input.items, decoded);
  let policy = input.policy ?? {
    ...THREAD_HISTORY_PAGE_POLICY,
    maxUserTurns: OLDER_THREAD_USER_TURN_LIMIT,
  };
  if (input.throughEntryId !== undefined) {
    const targetIndex = input.items.findIndex(
      (row) => (row.item.messageId ?? row.item.id) === input.throughEntryId,
    );
    if (targetIndex >= 0 && targetIndex < anchorIndex) {
      const turns = input.items
        .slice(targetIndex, anchorIndex)
        .filter((row) => isThreadHistoryUserTurn(row.item)).length;
      policy = {
        ...policy,
        maxUserTurns: Math.min(
          OLDER_THREAD_USER_TURN_LIMIT * 2,
          Math.max(
            OLDER_THREAD_USER_TURN_LIMIT,
            turns + (isThreadHistoryUserTurn(input.items[targetIndex]!.item) ? 0 : 1),
          ),
        ),
        maxItems: policy.maxItems * 2,
      };
    }
  }
  return selectOlderTimelinePage({
    items: input.items,
    exclusiveEndIndex: anchorIndex,
    snapshotSequence: input.snapshotSequence,
    ...(input.rowEncodedBytes === undefined ? {} : { rowEncodedBytes: input.rowEncodedBytes }),
    policy,
  });
}

function isLocalProjectedRow(
  projection: OrchestrationV2ThreadProjection,
  row: OrchestrationV2ProjectedTurnItem,
): boolean {
  return row.visibility === "local" || String(row.sourceThreadId) === String(projection.thread.id);
}

/**
 * Keep every small request item from the full projection even when it sits
 * outside the recent visible window, so a later history page that introduces
 * the matching result still has the request available for live attempt/run
 * reducers.
 */
function retainedInterruptRequestTurnItems(
  projection: OrchestrationV2ThreadProjection,
  visible: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2TurnItem[] {
  const visibleLocalIds = new Set<string>();
  for (const row of visible) {
    if (isLocalProjectedRow(projection, row)) {
      visibleLocalIds.add(String(row.sourceItemId));
    }
  }

  const retained: OrchestrationV2TurnItem[] = [];
  for (const item of projection.turnItems) {
    if (item.type !== "run_interrupt_request") {
      continue;
    }
    if (visibleLocalIds.has(String(item.id))) {
      continue;
    }
    retained.push(item);
  }
  return retained;
}

function localTurnItemsForVisibleWindow(
  projection: OrchestrationV2ThreadProjection,
  visible: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2TurnItem[] {
  const localIds = new Set<string>();
  for (const row of visible) {
    if (isLocalProjectedRow(projection, row)) {
      localIds.add(String(row.sourceItemId));
    }
  }
  if (localIds.size === 0) {
    return [];
  }
  return projection.turnItems.filter((item) => localIds.has(String(item.id)));
}

function messagesForBoundedProjection(
  projection: OrchestrationV2ThreadProjection,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ThreadProjection["messages"] {
  const retainedMessageIds = new Set<string>();
  for (const item of turnItems) {
    if ("messageId" in item) {
      retainedMessageIds.add(String(item.messageId));
    }
  }

  const latestRun = projection.runs.reduce<(typeof projection.runs)[number] | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  const retainedRunIds = new Set<string>();
  for (const run of projection.runs) {
    if (
      run.id === latestRun?.id ||
      run.status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting" ||
      run.status === "queued"
    ) {
      retainedRunIds.add(String(run.id));
      retainedMessageIds.add(String(run.userMessageId));
      const assistant = projection.messages.findLast(
        (message) => message.runId === run.id && message.role === "assistant",
      );
      if (assistant !== undefined) retainedMessageIds.add(String(assistant.id));
    }
  }

  return projection.messages.filter(
    (message) =>
      retainedMessageIds.has(String(message.id)) ||
      (message.role === "user" &&
        message.runId !== null &&
        retainedRunIds.has(String(message.runId))) ||
      message.delegatedCompletion !== undefined ||
      message.workflowScript === true,
  );
}

/**
 * Used as a cheap partial-timeline watermark so old missing turn-item updates
 * cannot append newest when the bounded window has no local rows.
 */
export function computeLatestLocalTurnOrdinal(
  turnItems: ReadonlyArray<{ readonly ordinal: number }>,
): number | null {
  let latest: number | null = null;
  for (const item of turnItems) {
    if (latest === null || item.ordinal > latest) {
      latest = item.ordinal;
    }
  }
  return latest;
}

export function boundedTimelineEncodedBytes(input: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): number {
  let total = 0;
  for (const row of input.visibleTurnItems) {
    total += projectedRowEncodedBytes(row);
  }
  for (const item of input.turnItems) {
    total += bytesOfJson(item);
  }
  return total;
}

export function buildBoundedThreadProjection(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
}): BoundedProjectionResult {
  const policy = input.policy ?? THREAD_HISTORY_PAGE_POLICY;
  const threadId = input.projection.thread.id;
  const runOrdinals = new Map(input.projection.runs.map((run) => [run.id, run.ordinal]));
  let latestTodoList: (typeof input.projection.plans)[number] | undefined;
  let latestTodoListOrdinal = -1;
  for (const plan of input.projection.plans) {
    const ordinal = plan.runId === null ? undefined : runOrdinals.get(plan.runId);
    if (
      plan.kind === "todo_list" &&
      plan.status !== "superseded" &&
      ordinal !== undefined &&
      ordinal >= latestTodoListOrdinal
    ) {
      latestTodoList = plan;
      latestTodoListOrdinal = ordinal;
    }
  }
  const controlProjection = {
    ...retainProviderHistoryGraph(
      input.projection,
      selectRecentTimelineWindow({
        items: input.projection.visibleTurnItems,
        snapshotSequence: input.snapshotSequence,
        policy,
      }).items,
    ),
    plans: input.projection.plans.filter(
      (plan) => plan.status === "active" || plan.id === latestTodoList?.id,
    ),
    contextHandoffs: input.projection.contextHandoffs.filter(
      (handoff) => handoff.status === "pending" || handoff.status === "ready",
    ),
  };
  const latestLocalTurnOrdinal = computeLatestLocalTurnOrdinal(input.projection.turnItems);

  const dependencyReserve = (() => {
    let reserve = 0;
    for (const item of controlProjection.turnItems) {
      if (item.type === "run_interrupt_request") {
        reserve += bytesOfJson(item);
      }
    }
    return reserve;
  })();
  const controlBytes = bytesOfJson({
    // fork: with task records on the window, reserve only page-independent graph state; reserving
    // ~200 imported tasks up front left room for one row. The final measurement charges the rest.
    ...(controlProjection.subagents.length === 0
      ? controlProjection
      : retainProviderHistoryGraph(controlProjection, [])),
    messages: messagesForBoundedProjection(controlProjection, []),
    turnItems: [],
    visibleTurnItems: [],
  });
  // Control state (checkpoint file lists, the latest task list) cannot be paged, so it may claim at most
  // half the budget; past that the window would shrink to the one row every page admits.
  const windowBudget = Math.max(
    policy.maxEncodedBytes / 2,
    policy.maxEncodedBytes - dependencyReserve - controlBytes - 1_024,
  );
  const windowPolicy: ThreadHistoryPagePolicy = {
    maxUserTurns: policy.maxUserTurns,
    maxItems: policy.maxItems,
    maxEncodedBytes: windowBudget,
  };

  const window = selectRecentTimelineWindow({
    items: controlProjection.visibleTurnItems,
    snapshotSequence: input.snapshotSequence,
    policy: windowPolicy,
    rowEncodedBytes: (row) => projectedRowBoundedSnapshotEncodedBytes(row, threadId),
  });
  const assemble = (visibleTurnItems: OrchestrationV2ProjectedTurnItem[]) => {
    const windowTurnItems = localTurnItemsForVisibleWindow(controlProjection, visibleTurnItems);
    const dependencyTurnItems = retainedInterruptRequestTurnItems(
      controlProjection,
      visibleTurnItems,
    );
    const turnItemById = new Map<string, OrchestrationV2TurnItem>();
    for (const item of windowTurnItems) {
      turnItemById.set(String(item.id), item);
    }
    for (const item of dependencyTurnItems) {
      turnItemById.set(String(item.id), item);
    }
    const turnItems = [...turnItemById.values()];

    const visiblePlanIds = new Set(
      turnItems.flatMap((item) =>
        item.type === "proposed_plan" || item.type === "todo_list" ? [String(item.planId)] : [],
      ),
    );
    const visibleHandoffIds = new Set(
      turnItems.flatMap((item) => (item.type === "handoff" ? [String(item.contextHandoffId)] : [])),
    );
    const plans = input.projection.plans
      .filter(
        (plan) =>
          plan.status === "active" ||
          plan.id === latestTodoList?.id ||
          visiblePlanIds.has(String(plan.id)),
      )
      .map((plan) =>
        plan.status === "active" || plan.id === latestTodoList?.id
          ? plan
          : plan.kind === "proposed_plan"
            ? { ...plan, markdown: "", detailInTurnItem: true as const }
            : { ...plan, explanation: undefined, detailInTurnItem: true as const },
      );
    const contextHandoffs = input.projection.contextHandoffs
      .filter(
        (handoff) =>
          handoff.status === "pending" ||
          handoff.status === "ready" ||
          visibleHandoffIds.has(String(handoff.id)),
      )
      .map((handoff) =>
        handoff.status === "pending" || handoff.status === "ready"
          ? handoff
          : { ...handoff, summaryText: "", detailInTurnItem: true as const },
      );

    return {
      ...retainProviderHistoryGraph(controlProjection, visibleTurnItems),
      plans,
      contextHandoffs,
      messages: messagesForBoundedProjection(controlProjection, turnItems),
      turnItems,
      visibleTurnItems,
    };
  };
  let visibleTurnItems = renumberPositions(window.items);
  let projection = assemble(visibleTurnItems);
  let historyCursor = window.nextCursor;
  let hasMoreHistory = window.hasMoreHistory;
  // Charge the actual complete response, including duplicated messages and
  // on-page graph/plan metadata. Required controls and a single oversized row
  // remain explicit exceptions; never cut an assistant message or request.
  if (
    controlBytes <= policy.maxEncodedBytes &&
    bytesOfJson(projection) > policy.maxEncodedBytes &&
    visibleTurnItems.length > 1
  ) {
    let low = 1;
    let high = visibleTurnItems.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = assemble(renumberPositions(window.items.slice(-middle)));
      if (bytesOfJson(candidate) <= policy.maxEncodedBytes) low = middle;
      else high = middle - 1;
    }
    const trimmedItems = window.items.slice(-low);
    const historyIndex = providerHistoryIndex(controlProjection.visibleTurnItems);
    const firstCompleteTurn =
      policy.maxUserTurns === undefined
        ? -1
        : trimmedItems.findIndex((row) => {
            const position = historyIndex.identities.get(
              JSON.stringify([row.sourceThreadId, row.sourceItemId]),
            );
            return position !== undefined && historyIndex.turnStarts[position];
          });
    visibleTurnItems = renumberPositions(
      firstCompleteTurn > 0 ? trimmedItems.slice(firstCompleteTurn) : trimmedItems,
    );
    projection = assemble(visibleTurnItems);
    const oldest = visibleTurnItems[0]!;
    const originalIndex = historyIndex.identities.get(
      JSON.stringify([oldest.sourceThreadId, oldest.sourceItemId]),
    )!;
    historyCursor = encodeThreadHistoryCursor({
      snapshotSequence: input.snapshotSequence,
      sourceThreadId: oldest.sourceThreadId,
      sourceItemId: oldest.sourceItemId,
      position: controlProjection.visibleTurnItems[originalIndex]!.position,
    });
    hasMoreHistory = true;
  }

  return {
    projection,
    historyCursor,
    hasMoreHistory,
    // Always from the full projection so inherited-only windows still carry a
    // watermark for partial live reducers.
    latestLocalTurnOrdinal,
    payloadBudgetExceeded:
      controlBytes > policy.maxEncodedBytes ||
      timelineTextExceedsBudget(projection, policy.maxEncodedBytes) ||
      bytesOfJson(projection) > policy.maxEncodedBytes,
  };
}
