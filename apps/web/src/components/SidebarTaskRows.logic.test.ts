import type { ThreadTaskMetadata } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  formatTaskElapsedLabel,
  formatTaskStatusLine,
  resolveMiniWindowMode,
  resolveTaskChips,
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

  it("measures a settled task from when it finished", () => {
    expect(
      formatTaskElapsedLabel({
        task: task({ status: "finished", finishedAt: "2026-07-25T11:52:00.000Z" }),
        nowMs: NOW,
      }),
    ).toBe("8m");
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
        task: task({ status: "finished", finishedAt: "2026-07-25T11:52:00.000Z" }),
        nowMs: NOW,
      }),
    ).toBe("Done · 8m ago");
  });

  it("labels failure and cancellation", () => {
    expect(
      formatTaskStatusLine({
        task: task({ status: "failed", finishedAt: "2026-07-25T11:59:00.000Z" }),
        nowMs: NOW,
      }),
    ).toBe("Failed · 1m ago");
    expect(
      formatTaskStatusLine({
        task: task({ status: "cancelled", finishedAt: "2026-07-25T11:59:00.000Z" }),
        nowMs: NOW,
      }),
    ).toBe("Cancelled · 1m ago");
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
