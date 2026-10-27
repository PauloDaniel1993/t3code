import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ScopedThreadRef,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act, render } from "../../test/render";
import { makeThreadFixture } from "../test-fixtures";
import { SidebarTaskTestClock } from "./sidebarTaskTestClock";
import { sidebarTaskLeaseClock } from "./sidebarTaskLeases";

const subscriptions = vi.hoisted(() => ({
  opened: vi.fn(),
  closed: vi.fn(),
  detailStatus: "loading",
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () => null,
  useThreadProjection: (ref: ScopedThreadRef | null) => {
    const key = ref === null ? null : `${ref.environmentId}:${ref.threadId}`;
    useEffect(() => {
      if (key === null) return;
      subscriptions.opened(key);
      return () => {
        subscriptions.closed(key);
      };
    }, [key]);
    return null;
  },
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: {},
  useThreadFamily: () => {},
  useEnvironmentThread: () => ({ status: subscriptions.detailStatus }),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./ui/toast", () => ({ toastManager: { add: vi.fn() } }));
import {
  closeSidebarTaskPeek,
  leaveSidebarTaskPeek,
  openSidebarTaskPeek,
  SidebarTaskPeek,
} from "./SidebarTaskPeek";

const environmentId = EnvironmentId.make("local");
const parentId = ThreadId.make("parent");
const task = (id: string) =>
  makeThreadFixture({
    environmentId,
    id: ThreadId.make(id),
    title: id,
    lineage: { parentThreadId: parentId, rootThreadId: parentId, relationshipToParent: "subagent" },
  });
function setup() {
  const clock = new SidebarTaskTestClock();
  const timer = vi.spyOn(sidebarTaskLeaseClock, "after").mockImplementation(clock.after);
  subscriptions.opened.mockClear();
  subscriptions.closed.mockClear();
  subscriptions.detailStatus = "loading";
  const anchor = document.createElement("button");
  document.body.append(anchor);
  return {
    anchor,
    clock,
    [Symbol.dispose]() {
      closeSidebarTaskPeek();
      anchor.remove();
      timer.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

it("retains a task through pending or failed reads and closes only on confirmed deletion", async () => {
  using h = setup();
  const { anchor, clock } = h;
  // This standalone portal does not use a router.
  await using _screen = await render(<SidebarTaskPeek onOpenThread={() => {}} />, {
    router: false,
  });
  const thread = task("eventual");
  await act(() => openSidebarTaskPeek({ anchor, thread, task: undefined }));
  await act(() => clock.advance(260));
  await act(() => clock.advance(150));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  subscriptions.detailStatus = "error";
  await act(() => openSidebarTaskPeek({ anchor, thread, task: undefined }));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  subscriptions.detailStatus = "deleted";
  await act(() => openSidebarTaskPeek({ anchor, thread, task: undefined }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("hydrates only after hover dwell, skips flicked rows and retains detail through close grace", async () => {
  using h = setup();
  const { anchor, clock } = h;
  // This standalone portal does not use a router.
  await using _screen = await render(<SidebarTaskPeek onOpenThread={() => {}} />, {
    router: false,
  });
  await act(() => openSidebarTaskPeek({ anchor, thread: task("first"), task: undefined }));
  await act(() => clock.advance(259));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(() => clock.advance(1));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(subscriptions.opened).not.toHaveBeenCalled();
  for (let i = 0; i < 30; i++) {
    await act(() => openSidebarTaskPeek({ anchor, thread: task(`flick-${i}`), task: undefined }));
    await act(() => clock.advance(100));
  }
  expect(subscriptions.opened).not.toHaveBeenCalled();
  await act(() => openSidebarTaskPeek({ anchor, thread: task("last"), task: undefined }));
  await act(() => clock.advance(149));
  expect(subscriptions.opened).not.toHaveBeenCalled();
  await act(() => clock.advance(1));
  expect(subscriptions.opened.mock.calls).toEqual([["local:last"], ["local:parent"]]);
  await act(() => leaveSidebarTaskPeek());
  await act(() => clock.advance(219));
  expect(subscriptions.closed).not.toHaveBeenCalled();
  await act(() => clock.advance(1));
  expect(subscriptions.closed).toHaveBeenCalledTimes(2);
});

for (const imported of [false, true]) {
  it.each([
    ["user", "you"],
    ["agent", "✦ agent"],
    ["system", "system"],
  ] as const)(
    `labels ${imported ? "imported" : "live"} tasks by their %s author`,
    async (createdBy, label) => {
      using h = setup();
      const { anchor, clock } = h;
      // This standalone portal does not use a router.
      await using _screen = await render(<SidebarTaskPeek onOpenThread={() => {}} />, {
        router: false,
      });

      const now = DateTime.makeUnsafe("2026-09-29T00:00:00Z");
      const thread = task("authored");
      const record: OrchestrationV2Subagent = {
        id: NodeId.make("authored-task"),
        threadId: parentId,
        runId: imported ? null : RunId.make("live-parent-run"),
        parentNodeId: NodeId.make("root"),
        origin: "app_owned",
        createdBy,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerThreadId: null,
        childThreadId: thread.id,
        nativeTaskRef: null,
        prompt: "Work",
        title: "Authored task",
        model: null,
        status: "completed",
        result: "Done",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        completionDelivery: { state: imported ? "disposed" : "pending", observedByRunId: null },
      };
      await act(() => openSidebarTaskPeek({ anchor, thread, task: record }));
      await act(() => clock.advance(260));
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        `${label}prompt-only context`,
      );
    },
  );
}

it("explains the native roster as all active agents plus the newest 12 inactive agents", async () => {
  using h = setup();
  const { anchor, clock } = h;
  // This standalone portal does not use a router.
  await using _screen = await render(<SidebarTaskPeek onOpenThread={() => {}} />, {
    router: false,
  });
  const now = DateTime.makeUnsafe("2026-09-29T00:00:00Z");
  await act(() =>
    openSidebarTaskPeek({
      anchor,
      thread: task("parent"),
      task: undefined,
      nativeAgent: {
        id: NodeId.make("native"),
        threadId: parentId,
        runId: null,
        parentNodeId: NodeId.make("root"),
        origin: "provider_native",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Work",
        title: "Native agent",
        model: null,
        status: "completed",
        result: "Done",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      },
    }),
  );
  await act(() => clock.advance(260));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Provider-owned agent · All active agents plus the newest 12 inactive agents",
  );
});
