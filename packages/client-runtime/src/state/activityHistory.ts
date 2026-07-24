import type {
  OrchestrationActivityHistoryPageInfo,
  OrchestrationGetActivityHistoryResult,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";

export type ActivityHistoryLoadStatus = "idle" | "loading" | "error";

export interface ActivityHistoryState {
  readonly threadId: ThreadId;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly pageInfo: OrchestrationActivityHistoryPageInfo;
  readonly loadStatus: ActivityHistoryLoadStatus;
  readonly error: string | null;
  readonly loadedPageCount: number;
}

const NO_OLDER_ACTIVITY_HISTORY: OrchestrationActivityHistoryPageInfo = {
  hasMoreBefore: false,
  beforeCursor: null,
};

function compareBinaryText(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareThreadActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): -1 | 0 | 1 {
  const leftHasSequence = left.sequence !== undefined;
  const rightHasSequence = right.sequence !== undefined;
  if (leftHasSequence !== rightHasSequence) {
    return leftHasSequence ? 1 : -1;
  }
  if (
    left.sequence !== undefined &&
    right.sequence !== undefined &&
    left.sequence !== right.sequence
  ) {
    return left.sequence < right.sequence ? -1 : 1;
  }
  const createdAtOrder = compareBinaryText(left.createdAt, right.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }
  return compareBinaryText(left.id, right.id);
}

function mergeActivities(
  older: ReadonlyArray<OrchestrationThreadActivity>,
  newer: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const byId = new Map(older.map((activity) => [activity.id, activity]));
  for (const activity of newer) {
    byId.set(activity.id, activity);
  }
  return Array.from(byId.values()).toSorted(compareThreadActivities);
}

export function createActivityHistoryState(thread: OrchestrationThread): ActivityHistoryState {
  return {
    threadId: thread.id,
    activities: mergeActivities([], thread.activities),
    pageInfo: thread.activityHistory ?? NO_OLDER_ACTIVITY_HISTORY,
    loadStatus: "idle",
    error: null,
    loadedPageCount: 0,
  };
}

/**
 * Reconcile a live thread snapshot/tail into already-loaded history. Existing
 * historical pages stay available while matching live identities win.
 */
export function reconcileActivityHistoryLive(
  state: ActivityHistoryState,
  thread: OrchestrationThread,
): ActivityHistoryState {
  if (state.threadId !== thread.id) {
    return createActivityHistoryState(thread);
  }
  return {
    ...state,
    activities: mergeActivities(state.activities, thread.activities),
    pageInfo:
      state.loadedPageCount === 0
        ? (thread.activityHistory ?? NO_OLDER_ACTIVITY_HISTORY)
        : state.pageInfo,
  };
}

export function beginActivityHistoryLoad(state: ActivityHistoryState): ActivityHistoryState {
  if (!state.pageInfo.hasMoreBefore || state.pageInfo.beforeCursor === null) {
    return state;
  }
  return {
    ...state,
    loadStatus: "loading",
    error: null,
  };
}

/**
 * Prepend a bounded historical page, deduplicating by stable activity identity.
 * Existing state is newer and therefore wins a race with a live upsert.
 */
export function mergeActivityHistoryPage(
  state: ActivityHistoryState,
  page: OrchestrationGetActivityHistoryResult,
): ActivityHistoryState {
  if (state.threadId !== page.threadId) {
    return state;
  }
  return {
    ...state,
    activities: mergeActivities(page.activities, state.activities),
    pageInfo: page.pageInfo,
    loadStatus: "idle",
    error: null,
    loadedPageCount: state.loadedPageCount + 1,
  };
}

export function failActivityHistoryLoad(
  state: ActivityHistoryState,
  error: string,
): ActivityHistoryState {
  return {
    ...state,
    loadStatus: "error",
    error,
  };
}

/**
 * Query atoms retain their previous failure while a retry is in flight. Treat
 * that cached error as settled only after revalidation stops.
 */
export function hasSettledActivityHistoryFailure(
  isPending: boolean,
  error: string | null,
): error is string {
  return !isPending && error !== null;
}
