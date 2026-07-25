import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  defaultTaskGroupExpanded,
  groupTasksByParent,
  hasUnreadTaskResults,
  isTaskResultMessage,
  isTaskThread,
  resolveOrchestrationMessageSource,
  runningTaskCount,
  topLevelThreads,
  type TaskLinkedThread,
} from "./threadTasks.ts";

const id = (value: string) => ThreadId.make(value);

const parent: TaskLinkedThread = { id: id("parent") };
const runningTask: TaskLinkedThread = {
  id: id("t1"),
  parentThreadId: id("parent"),
  task: { status: "running" },
};
const doneTask: TaskLinkedThread = {
  id: id("t2"),
  parentThreadId: id("parent"),
  task: { status: "finished" },
};
const otherThread: TaskLinkedThread = { id: id("other") };

describe("thread task grouping", () => {
  it("identifies task threads by their parent link", () => {
    expect(isTaskThread(parent)).toBe(false);
    expect(isTaskThread(runningTask)).toBe(true);
  });

  it("groups tasks under their parent preserving order", () => {
    const grouped = groupTasksByParent([parent, runningTask, otherThread, doneTask]);
    expect(grouped.get(id("parent"))?.map((task) => task.id)).toEqual([id("t1"), id("t2")]);
    expect(grouped.has(id("other"))).toBe(false);
  });

  it("removes task threads from the top-level list", () => {
    expect(topLevelThreads([parent, runningTask, otherThread, doneTask]).map((t) => t.id)).toEqual([
      id("parent"),
      id("other"),
    ]);
  });

  it("counts queued and running tasks only", () => {
    expect(runningTaskCount([runningTask, doneTask])).toBe(1);
    expect(
      runningTaskCount([
        { id: id("t3"), parentThreadId: id("parent"), task: { status: "queued" } },
      ]),
    ).toBe(1);
    expect(runningTaskCount([doneTask])).toBe(0);
  });
});

describe("hasUnreadTaskResults", () => {
  const summary = { total: 1, running: 0, latestDeliveredAt: "2026-07-25T12:00:00.000Z" };

  it("is false when nothing was ever delivered", () => {
    expect(
      hasUnreadTaskResults({
        taskSummary: { total: 1, running: 1, latestDeliveredAt: null },
        lastVisitedAt: undefined,
      }),
    ).toBe(false);
    expect(hasUnreadTaskResults({ taskSummary: null, lastVisitedAt: undefined })).toBe(false);
  });

  it("is true for a never-visited parent with a delivery", () => {
    expect(hasUnreadTaskResults({ taskSummary: summary, lastVisitedAt: undefined })).toBe(true);
  });

  it("clears once the parent is visited after the delivery", () => {
    expect(
      hasUnreadTaskResults({ taskSummary: summary, lastVisitedAt: "2026-07-25T12:00:01.000Z" }),
    ).toBe(false);
  });

  it("stays set when the last visit predates the delivery", () => {
    expect(
      hasUnreadTaskResults({ taskSummary: summary, lastVisitedAt: "2026-07-25T11:59:59.000Z" }),
    ).toBe(true);
  });

  it("treats an unparseable visit timestamp as never-visited", () => {
    expect(hasUnreadTaskResults({ taskSummary: summary, lastVisitedAt: "not-a-date" })).toBe(true);
  });
});

describe("defaultTaskGroupExpanded", () => {
  it("expands while work is in flight", () => {
    expect(defaultTaskGroupExpanded({ tasks: [runningTask], hasUnreadResults: false })).toBe(true);
  });

  it("expands while results are unread", () => {
    expect(defaultTaskGroupExpanded({ tasks: [doneTask], hasUnreadResults: true })).toBe(true);
  });

  it("collapses when everything is finished and seen", () => {
    expect(defaultTaskGroupExpanded({ tasks: [doneTask], hasUnreadResults: false })).toBe(false);
  });
});

describe("message source", () => {
  it("derives from role when absent", () => {
    expect(resolveOrchestrationMessageSource({ role: "user" })).toBe("user");
    expect(resolveOrchestrationMessageSource({ role: "assistant" })).toBe("provider");
    expect(resolveOrchestrationMessageSource({ role: "system" })).toBe("system");
  });

  it("prefers the stored source", () => {
    expect(resolveOrchestrationMessageSource({ role: "user", source: "task-result" })).toBe(
      "task-result",
    );
  });

  it("recognizes task wake-up messages", () => {
    expect(isTaskResultMessage({ role: "user", source: "task-result" })).toBe(true);
    expect(isTaskResultMessage({ role: "user" })).toBe(false);
  });
});
