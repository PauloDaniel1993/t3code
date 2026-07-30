import {
  ActivityHistoryCursor,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  beginActivityHistoryLoad,
  createActivityHistoryState,
  failActivityHistoryLoad,
  hasSettledActivityHistoryFailure,
  mergeActivityHistoryPage,
  reconcileActivityHistoryLive,
} from "./activityHistory.ts";

function activity(id: string, sequence: number, summary = id): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "tool.updated",
    summary,
    payload: { summary },
    turnId: null,
    sequence,
    createdAt: "2026-04-02T00:00:00.000Z",
  };
}

function thread(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  withHistory = true,
): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-02T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    messages: [],
    proposedPlans: [],
    activities,
    ...(withHistory
      ? {
          activityHistory: {
            hasMoreBefore: true,
            beforeCursor: ActivityHistoryCursor.make("cursor-initial"),
          },
        }
      : {}),
    checkpoints: [],
    session: null,
  };
}

describe("activity history state", () => {
  it("does not settle a cached failure while a retry is pending", () => {
    expect(hasSettledActivityHistoryFailure(true, "stale failure")).toBe(false);
    expect(hasSettledActivityHistoryFailure(false, "fresh failure")).toBe(true);
    expect(hasSettledActivityHistoryFailure(false, null)).toBe(false);
  });

  it("prepends pages by durable order and deduplicates live identities", () => {
    const initial = createActivityHistoryState(thread([activity("activity-3", 3)]));
    const loading = beginActivityHistoryLoad(initial);
    expect(loading.loadStatus).toBe("loading");

    const withLiveTail = reconcileActivityHistoryLive(
      loading,
      thread([activity("activity-3", 3, "live terminal"), activity("activity-4", 4)]),
    );
    const merged = mergeActivityHistoryPage(withLiveTail, {
      threadId: ThreadId.make("thread-1"),
      activities: [
        activity("activity-1", 1),
        activity("activity-2", 2),
        activity("activity-3", 3, "stale page value"),
      ],
      pageInfo: {
        hasMoreBefore: false,
        beforeCursor: null,
      },
    });

    expect(merged.activities.map((entry) => entry.id)).toEqual([
      "activity-1",
      "activity-2",
      "activity-3",
      "activity-4",
    ]);
    expect(merged.activities[2]?.summary).toBe("live terminal");
    expect(merged.pageInfo.hasMoreBefore).toBe(false);
    expect(merged.loadedPageCount).toBe(1);
    expect(merged.loadStatus).toBe("idle");
  });

  it("keeps retry state and supports snapshots from older servers without metadata", () => {
    const legacy = createActivityHistoryState(thread([activity("activity-1", 1)], false));
    expect(legacy.pageInfo).toEqual({ hasMoreBefore: false, beforeCursor: null });
    expect(beginActivityHistoryLoad(legacy)).toBe(legacy);

    const failed = failActivityHistoryLoad(
      createActivityHistoryState(thread([activity("activity-2", 2)])),
      "Could not load history",
    );
    expect(failed.loadStatus).toBe("error");
    expect(failed.error).toBe("Could not load history");
    expect(beginActivityHistoryLoad(failed)).toMatchObject({
      loadStatus: "loading",
      error: null,
    });
  });
});
