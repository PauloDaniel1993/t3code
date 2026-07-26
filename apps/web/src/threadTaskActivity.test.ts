import { describe, expect, it } from "vite-plus/test";

import {
  describeThreadTaskCreated,
  describeThreadTaskFinished,
  parseThreadTaskActivity,
  type ThreadTaskCreatedActivity,
  type ThreadTaskFinishedActivity,
} from "./threadTaskActivity";

const created = (payload: Record<string, unknown>): ThreadTaskCreatedActivity | null => {
  const parsed = parseThreadTaskActivity({ kind: "task.created", payload });
  return parsed?.kind === "task.created" ? parsed : null;
};

const finished = (payload: Record<string, unknown>): ThreadTaskFinishedActivity | null => {
  const parsed = parseThreadTaskActivity({ kind: "task.finished", payload });
  return parsed?.kind === "task.finished" ? parsed : null;
};

describe("parseThreadTaskActivity", () => {
  it("ignores activities that are not task lifecycle rows", () => {
    expect(parseThreadTaskActivity({ kind: "tool.progress", payload: {} })).toBeNull();
  });

  it("rejects payloads that are not objects or are missing identity", () => {
    expect(parseThreadTaskActivity({ kind: "task.created", payload: null })).toBeNull();
    expect(parseThreadTaskActivity({ kind: "task.created", payload: "nope" })).toBeNull();
    expect(created({ title: "Inventory handlers" })).toBeNull();
    expect(created({ taskThreadId: "task-1" })).toBeNull();
  });

  it("reads a created row and defaults unknown authorship to the user", () => {
    expect(
      created({
        taskThreadId: "task-1",
        title: "Inventory handlers",
        createdBy: "agent",
        contextLabel: "full thread context",
      }),
    ).toEqual({
      kind: "task.created",
      taskThreadId: "task-1",
      title: "Inventory handlers",
      createdBy: "agent",
      contextLabel: "full thread context",
    });
    // Anything that is not explicitly the agent is attributed to the person —
    // never the other way around.
    expect(created({ taskThreadId: "task-1", title: "T", createdBy: "hmm" })?.createdBy).toBe(
      "user",
    );
    expect(created({ taskThreadId: "task-1", title: "T" })?.contextLabel).toBeNull();
  });

  it("reads a finished row, treating only an explicit delivery as delivered", () => {
    expect(
      finished({
        taskThreadId: "task-1",
        title: "Inventory handlers",
        outcome: "succeeded",
        summary: "4 findings",
        summaryTruncated: true,
        deliveryState: "delivered",
      }),
    ).toEqual({
      kind: "task.finished",
      taskThreadId: "task-1",
      title: "Inventory handlers",
      outcome: "succeeded",
      summary: "4 findings",
      summaryTruncated: true,
      delivered: true,
      skipReason: null,
    });

    const skipped = finished({
      taskThreadId: "task-1",
      title: "Inventory handlers",
      outcome: "failed",
      deliveryState: "skipped",
      deliverySkipReason: "parent-archived",
    });
    expect(skipped).toMatchObject({
      outcome: "failed",
      summary: "",
      summaryTruncated: false,
      delivered: false,
      skipReason: "parent-archived",
    });
  });

  it("falls back to a succeeded outcome for an unrecognized value", () => {
    expect(finished({ taskThreadId: "t", title: "T", outcome: "weird" })?.outcome).toBe(
      "succeeded",
    );
  });
});

describe("describeThreadTaskFinished", () => {
  const base: ThreadTaskFinishedActivity = {
    kind: "task.finished",
    taskThreadId: "task-1",
    title: "Inventory handlers",
    outcome: "succeeded",
    summary: "4 findings",
    summaryTruncated: false,
    delivered: true,
    skipReason: null,
  };

  it("states that the parent resumed only when results were actually delivered", () => {
    expect(describeThreadTaskFinished(base)).toBe("Task finished. Main thread resumed.");
    expect(describeThreadTaskFinished({ ...base, outcome: "failed" })).toBe(
      "Task failed. Main thread resumed.",
    );
    expect(describeThreadTaskFinished({ ...base, outcome: "cancelled" })).toBe(
      "Task was cancelled. Main thread resumed.",
    );
  });

  it("never claims a resume for a skipped delivery, and names the reason in plain words", () => {
    expect(
      describeThreadTaskFinished({ ...base, delivered: false, skipReason: "parent-archived" }),
    ).toBe("Task finished · results were not delivered (this thread was archived).");
    expect(describeThreadTaskFinished({ ...base, delivered: false, skipReason: null })).toBe(
      "Task finished · results were not delivered.",
    );
  });

  it("passes an unmapped reason through rather than inventing wording", () => {
    expect(
      describeThreadTaskFinished({ ...base, delivered: false, skipReason: "brand-new-reason" }),
    ).toBe("Task finished · results were not delivered (brand-new-reason).");
  });
});

describe("describeThreadTaskCreated", () => {
  it("attributes the task to its creator", () => {
    expect(
      describeThreadTaskCreated({
        kind: "task.created",
        taskThreadId: "task-1",
        title: "T",
        createdBy: "agent",
        contextLabel: null,
      }),
    ).toBe("Agent created task");
    expect(
      describeThreadTaskCreated({
        kind: "task.created",
        taskThreadId: "task-1",
        title: "T",
        createdBy: "user",
        contextLabel: null,
      }),
    ).toBe("You created task");
  });
});
