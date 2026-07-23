import {
  beginActivityHistoryLoad,
  createActivityHistoryState,
  failActivityHistoryLoad,
  hasSettledActivityHistoryFailure,
  mergeActivityHistoryPage,
  reconcileActivityHistoryLive,
  type ActivityHistoryState,
} from "@t3tools/client-runtime/state/activity-history";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import type { ActivityHistoryCursor, OrchestrationThreadActivity } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { orchestrationEnvironment } from "../state/orchestration";
import { useEnvironmentQuery } from "../state/query";

interface RequestedHistoryPage {
  readonly threadKey: string;
  readonly cursor: ActivityHistoryCursor;
}

export interface ThreadActivityHistoryView {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly hasMoreBefore: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly loadOlder: () => void;
}

const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = Object.freeze([]);

export function useActivityHistory(thread: EnvironmentThread | null): ThreadActivityHistoryView {
  const threadKey = thread === null ? null : `${thread.environmentId}:${thread.id}`;
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
    thread !== null && requestedPage?.threadKey === threadKey
      ? orchestrationEnvironment.activityHistory({
          environmentId: thread.environmentId,
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
