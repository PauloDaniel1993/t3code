// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { makeThreadFixture } from "../test-fixtures";
import { SidebarTaskTestClock } from "./sidebarTaskTestClock";
import { sidebarTaskLeaseClock } from "./sidebarTaskLeases";

const subscriptions = vi.hoisted(() => ({ opened: vi.fn(), closed: vi.fn() }));
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
vi.mock("../state/threads", () => ({ threadEnvironment: {} }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./ui/toast", () => ({ toastManager: { add: vi.fn() } }));
import {
  closeSidebarTaskPeek,
  leaveSidebarTaskPeek,
  openSidebarTaskPeek,
  SidebarTaskPeek,
} from "./SidebarTaskPeek";

let root: Root;
let anchor: HTMLElement;
let clock: SidebarTaskTestClock;
const environmentId = EnvironmentId.make("local");
const parentId = ThreadId.make("parent");
const task = (id: string) =>
  makeThreadFixture({
    environmentId,
    id: ThreadId.make(id),
    title: id,
    lineage: { parentThreadId: parentId, rootThreadId: parentId, relationshipToParent: "subagent" },
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  clock = new SidebarTaskTestClock();
  vi.spyOn(sidebarTaskLeaseClock, "after").mockImplementation(clock.after);
  subscriptions.opened.mockClear();
  subscriptions.closed.mockClear();
  anchor = document.createElement("button");
  document.body.append(anchor);
  root = createRoot(document.createElement("div"));
  act(() => root.render(<SidebarTaskPeek onOpenThread={() => {}} />));
});
afterEach(() => {
  act(() => {
    closeSidebarTaskPeek();
    root.unmount();
  });
  anchor.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("hydrates only after hover dwell, skips flicked rows and retains detail through close grace", () => {
  act(() => openSidebarTaskPeek({ anchor, thread: task("first"), task: undefined }));
  act(() => clock.advance(259));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  act(() => clock.advance(1));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(subscriptions.opened).not.toHaveBeenCalled();
  for (let i = 0; i < 30; i++) {
    act(() => openSidebarTaskPeek({ anchor, thread: task(`flick-${i}`), task: undefined }));
    act(() => clock.advance(100));
  }
  expect(subscriptions.opened).not.toHaveBeenCalled();
  act(() => openSidebarTaskPeek({ anchor, thread: task("last"), task: undefined }));
  act(() => clock.advance(149));
  expect(subscriptions.opened).not.toHaveBeenCalled();
  act(() => clock.advance(1));
  expect(subscriptions.opened.mock.calls).toEqual([["local:last"], ["local:parent"]]);
  act(() => leaveSidebarTaskPeek());
  act(() => clock.advance(219));
  expect(subscriptions.closed).not.toHaveBeenCalled();
  act(() => clock.advance(1));
  expect(subscriptions.closed).toHaveBeenCalledTimes(2);
});

it("explains the native roster as all active agents plus the newest 12 inactive agents", () => {
  const now = DateTime.makeUnsafe("2026-09-29T00:00:00Z");
  act(() =>
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
  act(() => clock.advance(260));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Provider-owned agent · All active agents plus the newest 12 inactive agents",
  );
});
