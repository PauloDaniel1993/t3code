import {
  DEFAULT_THREAD_TASK_MAX_RUNNING,
  resolveThreadTaskLimits,
  THREAD_TASK_CONTEXT_MAX_CHARS,
  THREAD_TASK_RESULT_SUMMARY_MAX_CHARS,
  type OrchestrationMessage,
  type OrchestrationThread,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  boundTaskResultSummary,
  buildTaskWakeMessageText,
  checkTaskCreateEligibility,
  countParentTasks,
  describeTaskContext,
  materializeTaskPrompt,
  taskIsArmed,
  taskOutcomeForTurnState,
  taskThreadIsSettled,
} from "./threadTasks.ts";

const threadId = (value: string) => ThreadId.make(value);
const messageId = (value: string) => MessageId.make(value);

function message(
  overrides: Omit<Partial<OrchestrationMessage>, "id"> & { id: string },
): OrchestrationMessage {
  return {
    id: messageId(overrides.id),
    role: overrides.role ?? "user",
    text: overrides.text ?? "hello",
    turnId: null,
    streaming: overrides.streaming ?? false,
    createdAt: overrides.createdAt ?? "2026-07-25T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-25T00:00:00.000Z",
    ...(overrides.source === undefined ? {} : { source: overrides.source }),
    ...(overrides.attachments === undefined ? {} : { attachments: overrides.attachments }),
  } as OrchestrationMessage;
}

const parentBase = {
  id: threadId("parent"),
  parentThreadId: null,
  deletedAt: null,
  archivedAt: null,
  messages: [] as ReadonlyArray<OrchestrationMessage>,
};

const noTasks = { total: 0, running: 0, lifetime: 0 };

describe("checkTaskCreateEligibility", () => {
  it("accepts an eligible parent", () => {
    expect(
      checkTaskCreateEligibility({
        parent: parentBase,
        parentThreadId: threadId("parent"),
        counts: noTasks,
        context: { kind: "full-thread" },
      }),
    ).toBeNull();
  });

  it("rejects a missing parent", () => {
    expect(
      checkTaskCreateEligibility({
        parent: undefined,
        parentThreadId: threadId("parent"),
        counts: noTasks,
        context: { kind: "none" },
      })?.reason,
    ).toBe("parent-missing");
  });

  it("rejects a deleted or archived parent", () => {
    expect(
      checkTaskCreateEligibility({
        parent: { ...parentBase, deletedAt: "2026-07-25T00:00:00.000Z" },
        parentThreadId: threadId("parent"),
        counts: noTasks,
        context: { kind: "none" },
      })?.reason,
    ).toBe("parent-ineligible");
    expect(
      checkTaskCreateEligibility({
        parent: { ...parentBase, archivedAt: "2026-07-25T00:00:00.000Z" },
        parentThreadId: threadId("parent"),
        counts: noTasks,
        context: { kind: "none" },
      })?.reason,
    ).toBe("parent-ineligible");
  });

  it("rejects nesting beyond one level", () => {
    expect(
      checkTaskCreateEligibility({
        parent: { ...parentBase, parentThreadId: threadId("grandparent") },
        parentThreadId: threadId("parent"),
        counts: noTasks,
        context: { kind: "none" },
      })?.reason,
    ).toBe("nesting-depth");
  });

  it("rejects once the concurrency cap is reached", () => {
    expect(
      checkTaskCreateEligibility({
        parent: parentBase,
        parentThreadId: threadId("parent"),
        counts: {
          total: DEFAULT_THREAD_TASK_MAX_RUNNING,
          running: DEFAULT_THREAD_TASK_MAX_RUNNING,
          lifetime: 5,
        },
        context: { kind: "none" },
      })?.reason,
    ).toBe("concurrency-cap");
  });

  it("honours a configured concurrency cap over the built-in one", () => {
    const overTheConfiguredCap = {
      parent: parentBase,
      parentThreadId: threadId("parent"),
      counts: { total: 2, running: 2, lifetime: 2 },
      context: { kind: "none" },
    } as const;
    expect(checkTaskCreateEligibility(overTheConfiguredCap)).toBeNull();
    expect(
      checkTaskCreateEligibility({
        ...overTheConfiguredCap,
        limits: resolveThreadTaskLimits({ maxRunning: 2 }),
      })?.reason,
    ).toBe("concurrency-cap");
    expect(
      checkTaskCreateEligibility({
        ...overTheConfiguredCap,
        limits: resolveThreadTaskLimits({ maxRunning: 20 }),
      }),
    ).toBeNull();
  });

  it("rejects once the lifetime cap is reached", () => {
    expect(
      checkTaskCreateEligibility({
        parent: parentBase,
        parentThreadId: threadId("parent"),
        counts: { total: 0, running: 0, lifetime: 25 },
        context: { kind: "none" },
      })?.reason,
    ).toBe("lifetime-cap");
  });

  it("rejects selected message ids absent from the parent transcript", () => {
    expect(
      checkTaskCreateEligibility({
        parent: { ...parentBase, messages: [message({ id: "m1" })] },
        parentThreadId: threadId("parent"),
        counts: noTasks,
        context: { kind: "selected-messages", messageIds: [messageId("m1"), messageId("nope")] },
      })?.reason,
    ).toBe("invalid-context");
  });
});

describe("countParentTasks", () => {
  const rows = [
    {
      id: threadId("a"),
      parentThreadId: threadId("p"),
      task: { status: "running" },
      deletedAt: null,
    },
    {
      id: threadId("b"),
      parentThreadId: threadId("p"),
      task: { status: "finished" },
      deletedAt: null,
    },
    {
      id: threadId("c"),
      parentThreadId: threadId("p"),
      task: { status: "queued" },
      deletedAt: "2026-07-25T00:00:00.000Z",
    },
    {
      id: threadId("d"),
      parentThreadId: threadId("other"),
      task: { status: "running" },
      deletedAt: null,
    },
  ] as unknown as ReadonlyArray<
    Pick<OrchestrationThread, "parentThreadId" | "task" | "deletedAt"> & { readonly id: ThreadId }
  >;

  it("counts live, running, and lifetime tasks for one parent", () => {
    expect(countParentTasks(rows, threadId("p"))).toEqual({ total: 2, running: 1, lifetime: 3 });
  });

  it("ignores other parents", () => {
    expect(countParentTasks(rows, threadId("none"))).toEqual({
      total: 0,
      running: 0,
      lifetime: 0,
    });
  });
});

describe("materializeTaskPrompt", () => {
  const messages = [
    message({ id: "m1", role: "user", text: "first" }),
    message({ id: "m2", role: "assistant", text: "second" }),
    message({ id: "m3", role: "assistant", text: "streaming", streaming: true }),
    message({ id: "m4", role: "user", text: "wake", source: "task-result" }),
  ];

  it("passes the prompt through when context is none", () => {
    const result = materializeTaskPrompt({
      parentMessages: messages,
      context: { kind: "none" },
      prompt: "do the thing",
      parentTitle: "Parent",
    });
    expect(result).toEqual({ text: "do the thing", contextTruncated: false });
  });

  it("includes completed messages and excludes streaming and task-result rows", () => {
    const result = materializeTaskPrompt({
      parentMessages: messages,
      context: { kind: "full-thread" },
      prompt: "do the thing",
      parentTitle: "Parent",
    });
    expect(result.text).toContain("first");
    expect(result.text).toContain("second");
    expect(result.text).not.toContain("streaming");
    expect(result.text).not.toContain("wake");
    expect(result.text.endsWith("do the thing")).toBe(true);
    expect(result.contextTruncated).toBe(false);
  });

  it("includes only the selected messages", () => {
    const result = materializeTaskPrompt({
      parentMessages: messages,
      context: { kind: "selected-messages", messageIds: [messageId("m2")] },
      prompt: "compare",
      parentTitle: "Parent",
    });
    expect(result.text).toContain("second");
    expect(result.text).not.toContain("first");
  });

  it("drops oldest messages first when over budget and never trims the prompt", () => {
    // Sized so the newest message just fits the budget and the oldest cannot.
    const long = "x".repeat(THREAD_TASK_CONTEXT_MAX_CHARS - 50);
    const result = materializeTaskPrompt({
      parentMessages: [
        message({ id: "old", role: "user", text: "OLDEST-MARKER" }),
        message({ id: "new", role: "assistant", text: long }),
      ],
      context: { kind: "full-thread" },
      prompt: "PROMPT-MARKER",
      parentTitle: "Parent",
    });
    expect(result.contextTruncated).toBe(true);
    expect(result.text).not.toContain("OLDEST-MARKER");
    expect(result.text).toContain("PROMPT-MARKER");
  });

  it("describes attachments without inlining bytes", () => {
    const result = materializeTaskPrompt({
      parentMessages: [
        message({
          id: "m1",
          role: "user",
          text: "see this",
          attachments: [
            { type: "image", id: "img", name: "diagram.png", mimeType: "image/png", sizeBytes: 5 },
          ],
        }),
      ],
      context: { kind: "full-thread" },
      prompt: "look",
      parentTitle: "Parent",
    });
    expect(result.text).toContain("diagram.png");
    expect(result.text).toContain("image/png");
  });
});

describe("boundTaskResultSummary", () => {
  it("keeps short summaries intact", () => {
    expect(boundTaskResultSummary("  done  ")).toEqual({
      summary: "done",
      summaryTruncated: false,
    });
  });

  it("keeps the tail of an oversized summary because conclusions live at the end", () => {
    const text = `HEAD-MARKER${"y".repeat(THREAD_TASK_RESULT_SUMMARY_MAX_CHARS)}TAIL-MARKER`;
    const result = boundTaskResultSummary(text);
    expect(result.summaryTruncated).toBe(true);
    expect(result.summary).toContain("TAIL-MARKER");
    expect(result.summary).not.toContain("HEAD-MARKER");
    expect(result.summary.length).toBe(THREAD_TASK_RESULT_SUMMARY_MAX_CHARS);
  });
});

describe("buildTaskWakeMessageText", () => {
  it("restates the task and carries the result", () => {
    const text = buildTaskWakeMessageText({
      title: "Inventory handlers",
      prompt: "List every handler.",
      outcome: "succeeded",
      summary: "4 findings",
      summaryTruncated: false,
      taskThreadId: threadId("task-1"),
    });
    expect(text).toContain("Inventory handlers");
    expect(text).toContain("List every handler.");
    expect(text).toContain("4 findings");
    expect(text).toContain("task-1");
    expect(text).not.toContain("truncated");
  });

  it("points at the task thread when the summary was truncated", () => {
    const text = buildTaskWakeMessageText({
      title: "t",
      prompt: "p",
      outcome: "failed",
      summary: "boom",
      summaryTruncated: true,
      taskThreadId: threadId("task-1"),
    });
    expect(text).toContain("failed");
    expect(text).toContain("truncated");
  });
});

describe("taskThreadIsSettled", () => {
  const settledTurn = {
    turnId: "turn-1",
    state: "completed",
    requestedAt: "2026-07-25T00:00:00.000Z",
    startedAt: "2026-07-25T00:00:00.000Z",
    completedAt: "2026-07-25T00:01:00.000Z",
    assistantMessageId: null,
  } as unknown as NonNullable<OrchestrationThread["latestTurn"]>;

  it("is settled when the turn completed with nothing pending", () => {
    expect(
      taskThreadIsSettled({
        latestTurn: settledTurn,
        session: null,
        hasOpenBlockingRequest: false,
      }),
    ).toBe(true);
  });

  it("is not settled before the first turn", () => {
    expect(
      taskThreadIsSettled({ latestTurn: null, session: null, hasOpenBlockingRequest: false }),
    ).toBe(false);
  });

  it("is not settled while a turn runs", () => {
    expect(
      taskThreadIsSettled({
        latestTurn: { ...settledTurn, state: "running" },
        session: null,
        hasOpenBlockingRequest: false,
      }),
    ).toBe(false);
  });

  it("is not settled while an approval or input request is open", () => {
    expect(
      taskThreadIsSettled({
        latestTurn: settledTurn,
        session: null,
        hasOpenBlockingRequest: true,
      }),
    ).toBe(false);
  });

  it("is not settled while the session still has an active turn", () => {
    expect(
      taskThreadIsSettled({
        latestTurn: settledTurn,
        session: { activeTurnId: "turn-1" } as unknown as OrchestrationThread["session"],
        hasOpenBlockingRequest: false,
      }),
    ).toBe(false);
  });
});

describe("taskOutcomeForTurnState and taskIsArmed", () => {
  it("maps terminal turn states onto outcomes", () => {
    expect(taskOutcomeForTurnState("completed")).toBe("succeeded");
    expect(taskOutcomeForTurnState("error")).toBe("failed");
    expect(taskOutcomeForTurnState("interrupted")).toBe("cancelled");
  });

  it("disarms once a result exists or the task was cancelled", () => {
    expect(taskIsArmed(null)).toBe(false);
    expect(taskIsArmed({ status: "running", result: null } as never)).toBe(true);
    expect(taskIsArmed({ status: "running", result: { outcome: "succeeded" } } as never)).toBe(
      false,
    );
    expect(taskIsArmed({ status: "cancelled", result: null } as never)).toBe(false);
  });
});

describe("describeTaskContext", () => {
  it("labels each context kind for the parent timeline", () => {
    expect(describeTaskContext({ kind: "full-thread" })).toBe("full thread context");
    expect(describeTaskContext({ kind: "none" })).toBe("no context");
    expect(describeTaskContext({ kind: "selected-messages", messageIds: [messageId("a")] })).toBe(
      "1 selected message",
    );
    expect(
      describeTaskContext({
        kind: "selected-messages",
        messageIds: [messageId("a"), messageId("b")],
      }),
    ).toBe("2 selected messages");
  });
});
