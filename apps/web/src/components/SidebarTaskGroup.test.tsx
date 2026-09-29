import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  RunId,
  ThreadId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { makeThreadFixture } from "../test-fixtures";
import { useUiStateStore } from "../uiStateStore";

const hooks = vi.hoisted(() => ({
  projection:
    vi.fn<() => { projection: { subagents: ReadonlyArray<OrchestrationV2Subagent> } } | null>(),
  shell: vi.fn<() => EnvironmentThreadShell | null>(),
}));
vi.mock("../state/entities", () => ({
  useThreadProjection: hooks.projection,
  useThreadShell: hooks.shell,
}));
vi.mock("./SidebarTaskPeek", () => ({
  closeSidebarTaskPeek: () => {},
  leaveSidebarTaskPeek: () => {},
  openSidebarTaskPeek: () => {},
}));
const marks = vi.hoisted(() => vi.fn());
vi.mock("./SidebarTaskMark", () => ({
  SidebarTaskMark: ({ state }: { state: string }) => {
    marks(state);
    return <span>{state}</span>;
  },
}));
import { SidebarTaskDisclosure, SidebarTaskGroup } from "./SidebarTaskGroup";
import { SidebarTaskVisits } from "./SidebarTaskVisits";

const env = EnvironmentId.make("local");
const parent = makeThreadFixture({ environmentId: env, id: ThreadId.make("parent") });
function task(id: string): EnvironmentThreadShell {
  return makeThreadFixture({
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
      status: "queued",
      requestedAt: "2026-09-29T00:00:00Z",
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    },
    runtime: null,
  });
}
const callbacks = {
  onOpenThread: vi.fn(),
  onContextMenu: vi.fn(),
  onCommitRename: vi.fn(),
  onCancelRename: vi.fn(),
  onRenameTitleChange: vi.fn(),
  onNewTask: vi.fn(),
};
let renderer: ReactTestRenderer | undefined;
const render = (tasks: ReadonlyArray<EnvironmentThreadShell>) => (
  <>
    <SidebarTaskDisclosure parent={parent} tasks={tasks} />
    <SidebarTaskGroup
      parent={parent}
      tasks={tasks}
      {...callbacks}
      renamingThreadKey={null}
      renamingTitle=""
    />
  </>
);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T00:08:00.000Z"));
  useUiStateStore.setState({ sidebarTaskGroupsExpandedById: {}, threadLastVisitedAtById: {} });
  hooks.projection.mockReturnValue(null);
  hooks.shell.mockReturnValue(null);
  marks.mockClear();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sidebar task disclosure", () => {
  it("keeps delivered results unread when visiting the child, clears them on the parent, and respects collapse", () => {
    const deliveredAt = "2026-09-29T00:08:00.000Z";
    const finished = {
      ...task("child"),
      latestRun: null,
      updatedAt: deliveredAt,
    };
    const delivered: OrchestrationV2Subagent = {
      id: NodeId.make("agent"),
      threadId: parent.id,
      runId: RunId.make("run"),
      parentNodeId: NodeId.make("root"),
      origin: "app_owned",
      createdBy: "user",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerThreadId: null,
      childThreadId: finished.id,
      nativeTaskRef: null,
      prompt: "Work",
      title: "Work",
      model: null,
      status: "completed",
      result: "Done",
      startedAt: null,
      completedAt: DateTime.makeUnsafe(deliveredAt),
      updatedAt: DateTime.makeUnsafe(deliveredAt),
      completionDelivery: { state: "delivered", observedByRunId: null, deliveredAt },
    };
    hooks.projection.mockReturnValue({ projection: { subagents: [delivered] } });
    const view = (threadId = finished.id) => (
      <>
        <SidebarTaskDisclosure parent={parent} tasks={[finished]} />
        <SidebarTaskVisits threadRef={{ environmentId: env, threadId }} />
      </>
    );
    hooks.shell.mockReturnValue(finished);
    act(() => {
      renderer = create(view());
    });
    expect(renderer!.root.findByType("button").props["aria-label"]).toBe(
      "Hide 1 task, New task results",
    );
    expect(useUiStateStore.getState().threadLastVisitedAtById["local:parent"]).toBeUndefined();
    act(() =>
      renderer!.root
        .findByType("button")
        .props.onClick({ stopPropagation() {}, preventDefault() {} }),
    );
    expect(renderer!.root.findByType("button").props["aria-label"]).toBe(
      "Show 1 task, New task results",
    );
    hooks.shell.mockReturnValue(parent);
    act(() => renderer!.update(view(parent.id)));
    expect(renderer!.root.findByType("button").props["aria-label"]).toBe("Show 1 task");
    expect(useUiStateStore.getState().threadLastVisitedAtById["local:child"]).toBe(deliveredAt);
  });
  it("explicitly collapses running work and keeps that choice when another task is added", () => {
    const first = task("one");
    act(() => {
      renderer = create(render([first]));
    });
    expect(renderer!.root.findAllByType("button")).toHaveLength(3);
    const count = renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-expanded"] !== undefined)!;
    act(() => count.props.onClick({ stopPropagation() {}, preventDefault() {} }));
    expect(renderer!.root.findAllByType("button")).toHaveLength(1);
    expect(useUiStateStore.getState().sidebarTaskGroupsExpandedById["local:parent"]).toBe(false);
    act(() => renderer!.update(render([first, task("two")])));
    expect(renderer!.root.findAllByType("button")).toHaveLength(1);
    const collapsed = renderer!.root.findByType("button");
    act(() => collapsed.props.onClick({ stopPropagation() {}, preventDefault() {} }));
    expect(renderer!.root.findAllByType("button")).toHaveLength(4);
  });
  it("renders all 45 tasks and repaints only a changed task between clock ticks", () => {
    const tasks = Array.from({ length: 45 }, (_, index) => task(`task-${index}`));
    act(() => {
      renderer = create(render(tasks));
    });
    expect(renderer!.root.findAllByType("button")).toHaveLength(47);
    marks.mockClear();
    act(() =>
      renderer!.update(
        render(
          tasks.map((thread, index) =>
            index === 17 ? { ...thread, title: "Renamed task" } : thread,
          ),
        ),
      ),
    );
    expect(marks).toHaveBeenCalledTimes(1);
  });
  it("shares one five-second interval across rollups", () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    act(() => {
      renderer = create(
        <>
          {render([task("one")])}
          <SidebarTaskGroup
            parent={{ ...parent, id: ThreadId.make("other") }}
            tasks={[task("two")]}
            {...callbacks}
            renamingThreadKey={null}
            renamingTitle=""
          />
        </>,
      );
    });
    expect(intervals.mock.calls.filter((call) => call[1] === 5000)).toHaveLength(1);
    marks.mockClear();
    act(() => vi.advanceTimersByTime(5000));
    expect(marks).toHaveBeenCalledTimes(2);
    intervals.mockRestore();
  });
});
