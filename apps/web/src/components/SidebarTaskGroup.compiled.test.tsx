import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { makeThreadFixture } from "../test-fixtures";
import { useUiStateStore } from "../uiStateStore";
import { sidebarTaskLeaseClock } from "./sidebarTaskLeases";
import { SidebarTaskTestClock } from "./sidebarTaskTestClock";

const detail = vi.hoisted(() => ({ subagents: [] as OrchestrationV2Subagent[] }));
vi.mock("../state/threads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const atom = Atom.make(() => ({ projection: { runs: [], subagents: detail.subagents } }));
  return { environmentThreadDetails: { threadAtom: () => atom } };
});
vi.mock("./SidebarTaskPeek", () => ({
  closeSidebarTaskPeek: () => {},
  leaveSidebarTaskPeek: () => {},
  openSidebarTaskPeek: () => {},
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: () => null,
  TooltipPopup: () => null,
  TooltipTrigger: () => null,
}));
import { SidebarTaskGroup } from "./SidebarTaskGroup";
import { useSidebarTaskPresentationStore } from "./sidebarTaskPresentation";

const env = EnvironmentId.make("local");
const parent = makeThreadFixture({ environmentId: env, id: ThreadId.make("parent") });
const task = (id: string): EnvironmentThreadShell =>
  makeThreadFixture({
    environmentId: env,
    id: ThreadId.make(id),
    title: id,
    lineage: {
      rootThreadId: parent.id,
      parentThreadId: parent.id,
      relationshipToParent: "subagent",
    },
    latestRun: {
      runId: RunId.make(id),
      status: "running",
      requestedAt: "2026-09-29T00:00:00Z",
      startedAt: "2026-09-29T00:00:00Z",
      completedAt: null,
      assistantMessageId: null,
    },
    runtime: null,
  });
const record = (thread: EnvironmentThreadShell): OrchestrationV2Subagent => ({
  id: NodeId.make(`node-${thread.id}`),
  threadId: parent.id,
  runId: RunId.make("run"),
  parentNodeId: NodeId.make("root"),
  origin: "app_owned",
  createdBy: "user",
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerThreadId: null,
  childThreadId: thread.id,
  nativeTaskRef: null,
  prompt: "Work",
  title: thread.title,
  model: null,
  status: "running",
  result: null,
  startedAt: DateTime.makeUnsafe("2026-09-29T00:00:00Z"),
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-09-29T00:00:00Z"),
});
const view = (tasks: ReadonlyArray<EnvironmentThreadShell>) => (
  <SidebarTaskGroup
    parent={parent}
    tasks={tasks}
    onOpenThread={() => {}}
    onContextMenu={() => {}}
    onCommitRename={() => {}}
    onCancelRename={() => {}}
    onRenameTitleChange={() => {}}
    renamingThreadKey={null}
    renamingTitle=""
    onNewTask={() => {}}
  />
);
const titles = (tree: ReactTestRenderer) =>
  tree.root.findAll((node) => node.type === "span" && node.props.className?.includes("truncate"));

let tree: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  useUiStateStore.setState({ sidebarTaskGroupsExpandedById: {}, threadLastVisitedAtById: {} });
  useSidebarTaskPresentationStore.setState({ byParent: new Map() });
});
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The web build runs the React Compiler; this file does too (see vite.config.ts).
it("keeps one hook order while a group leases, learns its roster, grows, and toggles", () => {
  const errors = vi.spyOn(console, "error");
  const clock = new SidebarTaskTestClock();
  vi.spyOn(sidebarTaskLeaseClock, "after").mockImplementation(clock.after);
  const one = task("one");
  const two = task("two");
  detail.subagents = [record(one)];
  act(() => {
    tree = create(view([one]), {
      createNodeMock: () => ({ closest: () => null, getBoundingClientRect: () => ({ top: 0 }) }),
    });
  });
  expect(titles(tree!)).toHaveLength(1);
  // The lease swaps the empty atom for the detail slice, whose roster is then remembered.
  act(() => clock.advance(1000));
  expect(
    useSidebarTaskPresentationStore.getState().byParent.get("local:parent")?.subagents,
  ).toEqual(detail.subagents);
  // An import adds tasks to an already mounted group.
  act(() => tree!.update(view([one, two])));
  expect(titles(tree!)).toHaveLength(2);
  act(() => useUiStateStore.getState().setSidebarTaskGroupExpanded("local:parent", false));
  expect(titles(tree!)).toHaveLength(0);
  act(() => clock.advance(10_000));
  act(() => useUiStateStore.getState().setSidebarTaskGroupExpanded("local:parent", true));
  act(() => clock.advance(1000));
  expect(titles(tree!)).toHaveLength(2);
  expect(errors.mock.calls.flat().join(" ")).not.toMatch(/Hooks/);
});
