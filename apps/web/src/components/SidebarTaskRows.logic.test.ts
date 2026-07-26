import type { ThreadTaskMetadata } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  formatTaskElapsedLabel,
  formatTaskStatusLine,
  resolveMiniWindowMode,
  resolveTaskChips,
  groupSidebarTaskThreads,
  resolveTaskRowPresentation,
  taskIsCancellable,
  taskIsRedeliverable,
} from "./SidebarTaskRows.logic.ts";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");

const task = (overrides: Partial<ThreadTaskMetadata> = {}): ThreadTaskMetadata =>
  ({
    parentThreadId: "parent",
    title: "Inventory handlers",
    prompt: "List every handler.",
    context: { kind: "full-thread" },
    contextTruncated: false,
    createdBy: "agent",
    status: "running",
    requestedAt: "2026-07-25T11:57:00.000Z",
    startedAt: "2026-07-25T11:57:00.000Z",
    finishedAt: null,
    result: null,
    delivery: null,
    ...overrides,
  }) as ThreadTaskMetadata;

describe("resolveTaskRowPresentation", () => {
  it("shows a spinner while queued or running", () => {
    expect(resolveTaskRowPresentation(task({ status: "queued" })).icon).toBe("running");
    expect(resolveTaskRowPresentation(task({ status: "running" })).icon).toBe("running");
  });

  it("shows a check when finished and distinct icons for failure and cancellation", () => {
    expect(resolveTaskRowPresentation(task({ status: "finished" })).icon).toBe("done");
    expect(resolveTaskRowPresentation(task({ status: "failed" })).icon).toBe("failed");
    expect(resolveTaskRowPresentation(task({ status: "cancelled" })).icon).toBe("cancelled");
  });

  it("marks tasks that returned results to the parent", () => {
    expect(resolveTaskRowPresentation(task()).returnedToParent).toBe(false);
    expect(
      resolveTaskRowPresentation(
        task({ delivery: { state: "delivered", updatedAt: "2026-07-25T11:59:00.000Z" } }),
      ).returnedToParent,
    ).toBe(true);
    // A skipped delivery is not a return.
    expect(
      resolveTaskRowPresentation(
        task({
          delivery: {
            state: "skipped",
            reason: "parent-archived",
            updatedAt: "2026-07-25T11:59:00.000Z",
          },
        }),
      ).returnedToParent,
    ).toBe(false);
  });
});

describe("formatTaskElapsedLabel", () => {
  it("measures a running task from when it started", () => {
    expect(formatTaskElapsedLabel({ task: task(), nowMs: NOW })).toBe("3m");
  });

  // A settled task reports how long it took, not how long ago it stopped: a
  // number that keeps climbing after the work ended reads as still running.
  it("freezes a settled task at its run duration", () => {
    const settled = task({
      status: "finished",
      startedAt: "2026-07-25T11:50:00.000Z",
      finishedAt: "2026-07-25T11:52:00.000Z",
    });
    expect(formatTaskElapsedLabel({ task: settled, nowMs: NOW })).toBe("2m");
    // An hour later it still says the same thing.
    expect(formatTaskElapsedLabel({ task: settled, nowMs: NOW + 3_600_000 })).toBe("2m");
  });

  it("falls back to the request time when a settled task never recorded a start", () => {
    expect(
      formatTaskElapsedLabel({
        task: task({
          status: "finished",
          startedAt: null,
          requestedAt: "2026-07-25T11:59:30.000Z",
          finishedAt: "2026-07-25T11:59:45.000Z",
        }),
        nowMs: NOW,
      }),
    ).toBe("15s");
  });

  it("scales through seconds, hours, and days", () => {
    expect(
      formatTaskElapsedLabel({ task: task({ startedAt: "2026-07-25T11:59:20.000Z" }), nowMs: NOW }),
    ).toBe("40s");
    expect(
      formatTaskElapsedLabel({ task: task({ startedAt: "2026-07-25T09:00:00.000Z" }), nowMs: NOW }),
    ).toBe("3h");
    expect(
      formatTaskElapsedLabel({ task: task({ startedAt: "2026-07-23T12:00:00.000Z" }), nowMs: NOW }),
    ).toBe("2d");
  });

  it("returns an empty label for an unparseable timestamp", () => {
    expect(formatTaskElapsedLabel({ task: task({ startedAt: "nope" }), nowMs: NOW })).toBe("");
  });
});

describe("formatTaskStatusLine", () => {
  it("matches the mockup's working and done phrasing", () => {
    expect(formatTaskStatusLine({ task: task(), nowMs: NOW })).toBe("Working · 3m");
    expect(
      formatTaskStatusLine({
        task: task({
          status: "finished",
          startedAt: "2026-07-25T11:44:00.000Z",
          finishedAt: "2026-07-25T11:52:00.000Z",
        }),
        nowMs: NOW,
      }),
    ).toBe("Done in 8m");
  });

  it("labels failure and cancellation", () => {
    expect(
      formatTaskStatusLine({
        task: task({
          status: "failed",
          startedAt: "2026-07-25T11:58:00.000Z",
          finishedAt: "2026-07-25T11:59:00.000Z",
        }),
        nowMs: NOW,
      }),
    ).toBe("Failed after 1m");
    expect(
      formatTaskStatusLine({
        task: task({
          status: "cancelled",
          startedAt: "2026-07-25T11:58:00.000Z",
          finishedAt: "2026-07-25T11:59:00.000Z",
        }),
        nowMs: NOW,
      }),
    ).toBe("Cancelled after 1m");
  });
});

describe("resolveTaskChips", () => {
  it("shows creator, context, and model in mockup order", () => {
    const chips = resolveTaskChips({ task: task(), modelLabel: "K3 · Max" });
    expect(chips.map((chip) => chip.label)).toEqual(["✦ agent", "full thread context", "K3 · Max"]);
  });

  it("labels a manual task and a selected-message context", () => {
    const chips = resolveTaskChips({
      task: task({
        createdBy: "user",
        context: {
          kind: "selected-messages",
          messageIds: ["a", "b", "c"] as unknown as ThreadTaskMetadata["context"] extends {
            messageIds: infer M;
          }
            ? M
            : never,
        },
      }),
      modelLabel: null,
    });
    expect(chips.map((chip) => chip.label)).toEqual(["you", "3 selected messages"]);
  });

  it("notes trimmed context and the returned chip", () => {
    const chips = resolveTaskChips({
      task: task({
        contextTruncated: true,
        delivery: { state: "delivered", updatedAt: "2026-07-25T11:59:00.000Z" },
      }),
      modelLabel: null,
    });
    expect(chips.map((chip) => chip.label)).toEqual([
      "✦ agent",
      "full thread context (trimmed)",
      "↩ returned · woke parent",
    ]);
  });
});

describe("mini window affordances", () => {
  it("blocks inline steering while the task waits on a human", () => {
    expect(
      resolveMiniWindowMode({
        status: "running",
        hasPendingApprovals: true,
        hasPendingUserInput: false,
      }),
    ).toBe("blocked");
    expect(
      resolveMiniWindowMode({
        status: "running",
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      }),
    ).toBe("blocked");
  });

  it("allows steering otherwise", () => {
    expect(
      resolveMiniWindowMode({
        status: "finished",
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toBe("steer");
  });

  it("offers cancel only while in flight and re-delivery only after a result", () => {
    expect(taskIsCancellable("running")).toBe(true);
    expect(taskIsCancellable("queued")).toBe(true);
    expect(taskIsCancellable("finished")).toBe(false);
    expect(taskIsRedeliverable(task())).toBe(false);
    expect(
      taskIsRedeliverable(
        task({
          result: {
            outcome: "succeeded",
            summary: "4 findings",
            summaryTruncated: false,
            assistantMessageId: null,
            completedAt: "2026-07-25T11:52:00.000Z",
          },
        }),
      ),
    ).toBe(true);
  });
});

describe("groupSidebarTaskThreads", () => {
  interface Row {
    readonly id: string;
    readonly environmentId: string;
    readonly parentThreadId?: string | null;
    readonly createdAt: string;
  }
  const row = (id: string, overrides: Partial<Row> = {}): Row => ({
    id,
    environmentId: "env-1",
    createdAt: `2026-07-25T12:00:0${id.slice(-1)}.000Z`,
    ...overrides,
  });
  const group = (threads: ReadonlyArray<Row>, supported = true) =>
    groupSidebarTaskThreads({
      threads,
      supportsThreadTasks: () => supported,
      parentKey: (task) => `${task.environmentId}:${task.parentThreadId}`,
      compareTasks: (left, right) => left.createdAt.localeCompare(right.createdAt),
    });

  it("puts each thread in exactly one place", () => {
    const result = group([
      row("p1"),
      row("t2", { parentThreadId: "p1" }),
      row("p3"),
      row("t4", { parentThreadId: "p1" }),
    ]);
    expect(result.topLevel.map((thread) => thread.id)).toEqual(["p1", "p3"]);
    expect(result.tasksByParent.get("env-1:p1")?.map((thread) => thread.id)).toEqual(["t2", "t4"]);
    // No task also appears at the top level — a duplicated row would be two
    // entries for one thread.
    expect(result.topLevel.some((thread) => thread.parentThreadId != null)).toBe(false);
  });

  it("orders each group oldest first", () => {
    const result = group([
      row("t3", { parentThreadId: "p1", createdAt: "2026-07-25T12:00:03.000Z" }),
      row("t1", { parentThreadId: "p1", createdAt: "2026-07-25T12:00:01.000Z" }),
      row("t2", { parentThreadId: "p1", createdAt: "2026-07-25T12:00:02.000Z" }),
    ]);
    expect(result.tasksByParent.get("env-1:p1")?.map((thread) => thread.id)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  it("keeps a task at the top level where the environment cannot render groups", () => {
    // Nesting a thread into a group that will never render would drop it from
    // the sidebar entirely, so an unsupported environment ignores the link.
    const result = group([row("p1"), row("t2", { parentThreadId: "p1" })], false);
    expect(result.topLevel.map((thread) => thread.id)).toEqual(["p1", "t2"]);
    expect(result.tasksByParent.size).toBe(0);
  });

  it("keeps an orphaned task's group even with no parent row in view", () => {
    // An archived or filtered-out parent is not in `threads`; its tasks still
    // group, and simply render nothing until the parent is visible again.
    const result = group([row("t1", { parentThreadId: "gone" })]);
    expect(result.topLevel).toEqual([]);
    expect(result.tasksByParent.get("env-1:gone")?.map((thread) => thread.id)).toEqual(["t1"]);
  });

  it("treats an explicit null parent as top level", () => {
    const result = group([row("p1", { parentThreadId: null })]);
    expect(result.topLevel.map((thread) => thread.id)).toEqual(["p1"]);
  });
});
