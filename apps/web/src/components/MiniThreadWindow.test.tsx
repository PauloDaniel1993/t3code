import type { ScopedThreadRef, ThreadTaskMetadata } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const threadState = vi.hoisted(() => ({
  thread: null as unknown,
  shell: null as unknown,
}));

vi.mock("../state/entities", () => ({
  useThread: () => threadState.thread,
  useThreadShell: () => threadState.shell,
}));

const { MiniThreadWindow } = await import("./MiniThreadWindow");

const threadRef = {
  environmentId: "env-1",
  threadId: "task-1",
} as unknown as ScopedThreadRef;

const task = (overrides: Partial<ThreadTaskMetadata> = {}): ThreadTaskMetadata =>
  ({
    parentThreadId: "parent-1",
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

const setThread = (input: {
  readonly task: ThreadTaskMetadata | null;
  readonly messages?: ReadonlyArray<{ role: string; text: string }>;
  readonly shell?: { hasPendingApprovals?: boolean; hasPendingUserInput?: boolean };
}) => {
  threadState.thread =
    input.task === null ? null : { task: input.task, messages: input.messages ?? [] };
  threadState.shell = input.shell ?? { hasPendingApprovals: false, hasPendingUserInput: false };
};

const render = (props: Partial<Parameters<typeof MiniThreadWindow>[0]> = {}) =>
  renderToStaticMarkup(
    <MiniThreadWindow
      threadRef={threadRef}
      anchor={null}
      modelLabel="K3 · Max"
      isMobile={false}
      onClose={() => {}}
      onOpenThread={() => {}}
      onSteer={() => {}}
      onCancelTask={() => {}}
      onRedeliver={() => {}}
      onKeepOpen={() => {}}
      onPeekLeave={() => {}}
      {...props}
    />,
  );

beforeEach(() => {
  setThread({ task: task() });
});

describe("MiniThreadWindow", () => {
  it("renders the task's status, title, and chips", () => {
    const html = render();
    expect(html).toContain("Inventory handlers");
    expect(html).toContain("Working");
    expect(html).toContain("full thread context");
    expect(html).toContain("K3 · Max");
    expect(html).toContain("Open thread");
  });

  it("renders nothing on mobile, where activating a row opens the full thread", () => {
    expect(render({ isMobile: true })).toBe("");
  });

  it("renders nothing until the task thread has loaded", () => {
    setThread({ task: null });
    expect(render()).toBe("");
  });

  it("offers cancel while in flight and re-delivery only once there is a result", () => {
    expect(render()).toContain("Cancel task");
    expect(render()).not.toContain("Return results again");

    setThread({
      task: task({
        status: "finished",
        finishedAt: "2026-07-25T11:59:00.000Z",
        result: {
          outcome: "succeeded",
          summary: "4 findings",
          summaryTruncated: false,
          assistantMessageId: null,
          completedAt: "2026-07-25T11:59:00.000Z",
        },
      } as Partial<ThreadTaskMetadata>),
    });
    const settled = render();
    expect(settled).not.toContain("Cancel task");
    expect(settled).toContain("Return results again");
  });

  it("replaces the composer with an explanation when the task is waiting on a human", () => {
    setThread({ task: task(), shell: { hasPendingApprovals: true } });
    const html = render();
    expect(html).toContain("waiting on you");
    expect(html).not.toContain("Steer this task");
  });

  it("says the parent resumed only for a delivered result", () => {
    setThread({
      task: task({
        delivery: { state: "delivered", updatedAt: "2026-07-25T11:59:00.000Z" },
      } as Partial<ThreadTaskMetadata>),
    });
    expect(render()).toContain("main thread resumed");

    setThread({
      task: task({
        delivery: {
          state: "skipped",
          reason: "parent-archived",
          updatedAt: "2026-07-25T11:59:00.000Z",
        },
      } as Partial<ThreadTaskMetadata>),
    });
    const skipped = render();
    expect(skipped).toContain("were not delivered");
    expect(skipped).toContain("parent-archived");
    expect(skipped).not.toContain("main thread resumed");
  });
});
