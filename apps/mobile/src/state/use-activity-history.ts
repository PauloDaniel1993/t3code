import {
  beginActivityHistoryLoad,
  createActivityHistoryState,
  failActivityHistoryLoad,
  hasSettledActivityHistoryFailure,
  mergeActivityHistoryPage,
  reconcileActivityHistoryLive,
  type ActivityHistoryState,
} from "@t3tools/client-runtime/state/activity-history";
import type {
  ActivityHistoryCursor,
  EnvironmentId,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { orchestrationEnvironment } from "./orchestration";
import { useEnvironmentQuery } from "./query";

interface RequestedHistoryPage {
  readonly threadKey: string;
  readonly cursor: ActivityHistoryCursor;
}

const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = Object.freeze([]);

export function useActivityHistory(
  thread: OrchestrationThread | null,
  environmentId: EnvironmentId | null,
) {
  const threadKey =
    thread === null || environmentId === null ? null : `${environmentId}:${thread.id}`;
  const [state, setState] = useState<ActivityHistoryState | null>(null);
  const [requestedPage, setRequestedPage] = useState<RequestedHistoryPage | null>(null);

  useEffect(() => {
    if (thread === null) {
      setState(null);
      setRequestedPage(null);
      return;
    }
    setState((current) =>
      current?.threadId === thread.id
        ? reconcileActivityHistoryLive(current, thread)
        : createActivityHistoryState(thread),
    );
    setRequestedPage((current) => (current?.threadKey === threadKey ? current : null));
  }, [thread, threadKey]);

  const current = useMemo(() => {
    if (thread === null) {
      return null;
    }
    return state?.threadId === thread.id
      ? reconcileActivityHistoryLive(state, thread)
      : createActivityHistoryState(thread);
  }, [state, thread]);

  const query = useEnvironmentQuery(
    thread !== null && environmentId !== null && requestedPage?.threadKey === threadKey
      ? orchestrationEnvironment.activityHistory({
          environmentId,
          input: {
            threadId: thread.id,
            before: requestedPage.cursor,
          },
        })
      : null,
  );

  useEffect(() => {
    if (thread === null || requestedPage === null || requestedPage.threadKey !== threadKey) {
      return;
    }
    const page = query.data;
    if (page !== null) {
      setState((existing) =>
        mergeActivityHistoryPage(
          existing?.threadId === thread.id
            ? reconcileActivityHistoryLive(existing, thread)
            : createActivityHistoryState(thread),
          page,
        ),
      );
      setRequestedPage(null);
      return;
    }
    const queryError = query.error;
    if (hasSettledActivityHistoryFailure(query.isPending, queryError)) {
      setState((existing) =>
        failActivityHistoryLoad(
          existing?.threadId === thread.id
            ? reconcileActivityHistoryLive(existing, thread)
            : createActivityHistoryState(thread),
          queryError,
        ),
      );
      setRequestedPage(null);
    }
  }, [query.data, query.error, query.isPending, requestedPage, thread, threadKey]);

  const loadOlder = useCallback(() => {
    if (
      thread === null ||
      threadKey === null ||
      current === null ||
      !current.pageInfo.hasMoreBefore ||
      current.pageInfo.beforeCursor === null ||
      current.loadStatus === "loading"
    ) {
      return;
    }
    setState(beginActivityHistoryLoad(current));
    setRequestedPage({
      threadKey,
      cursor: current.pageInfo.beforeCursor,
    });
  }, [current, thread, threadKey]);

  return {
    activities: current?.activities ?? thread?.activities ?? EMPTY_ACTIVITIES,
    hasMoreBefore: current?.pageInfo.hasMoreBefore ?? false,
    isLoading: current?.loadStatus === "loading" || query.isPending,
    error: current?.error ?? null,
    loadOlder,
  };
}
