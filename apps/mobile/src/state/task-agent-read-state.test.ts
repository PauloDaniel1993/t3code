import { hasUnreadTaskResults as sharedHasUnreadTaskResults } from "@t3tools/client-runtime/state/thread-tasks";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { TaskAgentModelInput } from "../features/threads/task-agent-surface/taskAgentModel";
import {
  DEFAULT_TASK_AGENT_COLD_START_POLICY,
  TASK_AGENT_COLD_START_POLICIES,
  createTaskAgentReadState,
  hasUnreadTaskResultForThread,
  hasUnreadTaskResults,
  markTaskAgentThreadsVisited,
  type TaskAgentColdStartPolicy,
  type TaskAgentReadState,
} from "./task-agent-read-state";

const parentThreadId = ThreadId.make("parent-thread");
const taskThreadId = ThreadId.make("task-thread");
const requestedAt = "2026-07-31T12:00:00.000Z";
const deliveredAt = "2026-07-31T12:05:00.000Z";
const laterVisitAt = "2026-07-31T12:10:00.000Z";

const deliveredTaskSummary = {
  total: 1,
  running: 0,
  latestDeliveredAt: deliveredAt,
} as const;

function visit(state: TaskAgentReadState, visitedAt: unknown): TaskAgentReadState {
  return markTaskAgentThreadsVisited(state, {
    parentThreadId,
    taskThreadId,
    visitedAt,
  });
}

describe("task-agent read-state transitions", () => {
  it("starts with neither the parent nor task visited", () => {
    const state = createTaskAgentReadState();

    expect(state.lastVisitedAtByThreadId.size).toBe(0);
    expect(
      hasUnreadTaskResultForThread({
        readState: state,
        threadId: parentThreadId,
        taskSummary: deliveredTaskSummary,
      }),
    ).toBe(true);
    expect(
      hasUnreadTaskResultForThread({
        readState: state,
        threadId: taskThreadId,
        taskSummary: deliveredTaskSummary,
      }),
    ).toBe(true);
  });

  it("records the first visit for both the parent and task", () => {
    const initial = createTaskAgentReadState();
    const next = visit(initial, requestedAt);

    expect(initial.lastVisitedAtByThreadId.size).toBe(0);
    expect(next).not.toBe(initial);
    expect(next.lastVisitedAtByThreadId.get(parentThreadId)).toBe(requestedAt);
    expect(next.lastVisitedAtByThreadId.get(taskThreadId)).toBe(requestedAt);
  });

  it("advances both markers for a newer visit", () => {
    const initial = visit(createTaskAgentReadState(), requestedAt);
    const next = visit(initial, laterVisitAt);

    expect(next.lastVisitedAtByThreadId.get(parentThreadId)).toBe(laterVisitAt);
    expect(next.lastVisitedAtByThreadId.get(taskThreadId)).toBe(laterVisitAt);
  });

  it("does not regress either marker for a stale or equal visit", () => {
    const initial = visit(createTaskAgentReadState(), laterVisitAt);
    const stale = visit(initial, requestedAt);
    const equal = visit(initial, laterVisitAt);

    expect(stale.lastVisitedAtByThreadId.get(parentThreadId)).toBe(laterVisitAt);
    expect(stale.lastVisitedAtByThreadId.get(taskThreadId)).toBe(laterVisitAt);
    expect(equal.lastVisitedAtByThreadId.get(parentThreadId)).toBe(laterVisitAt);
    expect(equal.lastVisitedAtByThreadId.get(taskThreadId)).toBe(laterVisitAt);
  });

  it("ignores invalid visit timestamps without changing the markers", () => {
    const initial = visit(createTaskAgentReadState(), requestedAt);
    const invalidTimestamps: ReadonlyArray<unknown> = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      "1969-12-31T23:59:59.999Z",
      "not-a-date",
      { timestamp: laterVisitAt },
    ];

    for (const invalidTimestamp of invalidTimestamps) {
      const next = visit(initial, invalidTimestamp);

      expect(next).not.toBe(initial);
      expect(next.lastVisitedAtByThreadId).toEqual(initial.lastVisitedAtByThreadId);
    }
  });

  it("does not mutate the input map when a visit advances it", () => {
    const initial = visit(createTaskAgentReadState(), requestedAt);
    const inputMarkers = initial.lastVisitedAtByThreadId;
    const next = visit(initial, laterVisitAt);

    expect(initial.lastVisitedAtByThreadId).toBe(inputMarkers);
    expect(inputMarkers.get(parentThreadId)).toBe(requestedAt);
    expect(inputMarkers.get(taskThreadId)).toBe(requestedAt);
    expect(next.lastVisitedAtByThreadId).not.toBe(inputMarkers);
  });
});

describe("task-agent unread queries", () => {
  it("treats a delivery with no visit marker as unread", () => {
    expect(
      hasUnreadTaskResults({
        taskSummary: deliveredTaskSummary,
        lastVisitedAt: undefined,
      }),
    ).toBe(true);
  });

  it("treats equal delivery and visit timestamps as read", () => {
    expect(
      hasUnreadTaskResults({
        taskSummary: deliveredTaskSummary,
        lastVisitedAt: deliveredAt,
      }),
    ).toBe(false);
  });

  it("treats a delivery older than the marker as read", () => {
    expect(
      hasUnreadTaskResults({
        taskSummary: deliveredTaskSummary,
        lastVisitedAt: laterVisitAt,
      }),
    ).toBe(false);
  });

  it("treats a delivery newer than the marker as unread", () => {
    expect(
      hasUnreadTaskResults({
        taskSummary: deliveredTaskSummary,
        lastVisitedAt: requestedAt,
      }),
    ).toBe(true);
  });

  it("treats an absent delivery as not unread", () => {
    for (const taskSummary of [
      undefined,
      null,
      { ...deliveredTaskSummary, latestDeliveredAt: null },
    ]) {
      expect(hasUnreadTaskResults({ taskSummary, lastVisitedAt: undefined })).toBe(false);
    }
  });

  it("clears the unread result for both IDs after they are visited at delivery time", () => {
    const readState = visit(createTaskAgentReadState(), deliveredAt);

    expect(
      hasUnreadTaskResultForThread({
        readState,
        threadId: parentThreadId,
        taskSummary: deliveredTaskSummary,
      }),
    ).toBe(false);
    expect(
      hasUnreadTaskResultForThread({
        readState,
        threadId: taskThreadId,
        taskSummary: deliveredTaskSummary,
      }),
    ).toBe(false);
  });

  it("ships the named unread cold-start policy", () => {
    expect(DEFAULT_TASK_AGENT_COLD_START_POLICY).toBe(TASK_AGENT_COLD_START_POLICIES.unread);
    expect(DEFAULT_TASK_AGENT_COLD_START_POLICY).toBe("unread");
    expect(
      hasUnreadTaskResults({
        taskSummary: deliveredTaskSummary,
        lastVisitedAt: undefined,
        coldStartPolicy: DEFAULT_TASK_AGENT_COLD_START_POLICY,
      }),
    ).toBe(true);
  });

  it("supports the explicit read cold-start policy branch", () => {
    const policy: TaskAgentColdStartPolicy = TASK_AGENT_COLD_START_POLICIES.read;

    expect(
      hasUnreadTaskResults({
        taskSummary: deliveredTaskSummary,
        lastVisitedAt: undefined,
        coldStartPolicy: policy,
      }),
    ).toBe(false);
  });

  it("matches the shared unread rule for the shipped policy", () => {
    const cases = [
      { taskSummary: deliveredTaskSummary, lastVisitedAt: undefined },
      { taskSummary: deliveredTaskSummary, lastVisitedAt: requestedAt },
      { taskSummary: deliveredTaskSummary, lastVisitedAt: deliveredAt },
      { taskSummary: deliveredTaskSummary, lastVisitedAt: "not-a-date" },
      {
        taskSummary: { ...deliveredTaskSummary, latestDeliveredAt: "not-a-date" },
        lastVisitedAt: laterVisitAt,
      },
      {
        taskSummary: { ...deliveredTaskSummary, latestDeliveredAt: null },
        lastVisitedAt: undefined,
      },
      { taskSummary: undefined, lastVisitedAt: undefined },
    ] as const;

    for (const input of cases) {
      expect(
        hasUnreadTaskResults({
          ...input,
          coldStartPolicy: DEFAULT_TASK_AGENT_COLD_START_POLICY,
        }),
      ).toBe(sharedHasUnreadTaskResults(input));
    }
  });

  it("returns a model-compatible read state", () => {
    const state: TaskAgentModelInput["readState"] = visit(createTaskAgentReadState(), requestedAt);

    expect(state.lastVisitedAtByThreadId.get(parentThreadId)).toBe(requestedAt);
    expect(state.lastVisitedAtByThreadId.get(taskThreadId)).toBe(requestedAt);
  });
});
