import { act } from "react";
import { create as createRenderer, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  RunId,
  ThreadId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { makeThreadFixture } from "../test-fixtures";
import { useUiStateStore } from "../uiStateStore";

const hooks = vi.hoisted(() => ({
  projection:
    vi.fn<
      () => { projection: Pick<OrchestrationV2ThreadProjection, "subagents" | "runs"> } | null
    >(),
  shell: vi.fn<() => EnvironmentThreadShell | null>(),
}));
vi.mock("../state/entities", () => ({
  useThreadProjection: hooks.projection,
  useThreadShell: hooks.shell,
  readThreadShell: hooks.shell,
}));
vi.mock("./SidebarTaskPeek", () => ({
  closeSidebarTaskPeek: () => {},
  leaveSidebarTaskPeek: () => {},
  openSidebarTaskPeek: () => {},
}));
vi.mock("./ui/tooltip", async () => {
  const { cloneElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    TooltipTrigger: ({
      children,
      render,
    }: {
      children: React.ReactNode;
      render: React.ReactElement;
    }) => cloneElement(render, {}, children),
    TooltipPopup: ({ children }: { children: React.ReactNode }) => children,
  };
});
vi.mock("../state/threads", () => ({ environmentThreadDetails: {} }));
vi.mock("./sidebarTaskPresentation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sidebarTaskPresentation")>()),
  useSidebarTaskProjection: (ref: unknown) =>
    ref === null ? null : (hooks.projection()?.projection ?? null),
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
import { useSidebarTaskPresentationStore } from "./sidebarTaskPresentation";

const create: typeof createRenderer = (element, options) =>
  createRenderer(element, {
    ...options,
    createNodeMock: () => ({ closest: () => null }),
  });
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
  useSidebarTaskPresentationStore.setState({ byParent: new Map() });
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
    hooks.projection.mockReturnValue({ projection: { subagents: [delivered], runs: [] } });
    useSidebarTaskPresentationStore
      .getState()
      .remember("local:parent", { subagents: [delivered], runs: [] });
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
    expect(marks).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(55000));
    expect(marks).toHaveBeenCalledTimes(2);
    intervals.mockRestore();
  });
});

function completedTaskRecord(
  child: EnvironmentThreadShell,
  state: "delivered" | "acknowledged" = "delivered",
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(`agent-${child.id}`),
    threadId: parent.id,
    runId: RunId.make("run"),
    parentNodeId: NodeId.make("root"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: child.id,
    nativeTaskRef: null,
    prompt: "Work",
    title: child.title,
    model: null,
    status: "completed",
    result: "Done",
    startedAt: DateTime.makeUnsafe("2026-09-29T00:00:00Z"),
    completedAt: DateTime.makeUnsafe("2026-09-29T00:08:00Z"),
    updatedAt: DateTime.makeUnsafe("2026-09-29T00:08:00Z"),
    completionDelivery: { state, observedByRunId: null, deliveredAt: "2026-09-29T00:08:00Z" },
  };
}

it("keeps the return mark and unread dot after acknowledgement and a bounded replacement", () => {
  const child = { ...task("returned"), latestRun: null };
  const record = completedTaskRecord(child);
  hooks.projection.mockReturnValue({ projection: { subagents: [record], runs: [] } });
  useUiStateStore.setState({ sidebarTaskGroupsExpandedById: { "local:parent": true } });
  act(() => {
    renderer = create(render([child]));
  });
  act(() => vi.advanceTimersByTime(250));
  expect(
    renderer!.root.findAllByProps({ "aria-label": "Returned results to the parent thread" }),
  ).toHaveLength(1);
  hooks.projection.mockReturnValue({
    projection: {
      subagents: [
        { ...record, completionDelivery: { ...record.completionDelivery!, state: "acknowledged" } },
      ],
      runs: [],
    },
  });
  act(() => renderer!.update(render([child])));
  expect(
    renderer!.root.findAllByProps({ "aria-label": "Returned results to the parent thread" }),
  ).toHaveLength(1);
  hooks.projection.mockReturnValue({ projection: { subagents: [], runs: [] } });
  act(() => renderer!.update(render([child])));
  expect(
    renderer!.root.findAllByProps({ "aria-label": "Returned results to the parent thread" }),
  ).toHaveLength(1);
  expect(
    renderer!.root.findAllByProps({ "aria-label": "Hide 1 task, New task results" }),
  ).toHaveLength(1);
  expect(renderer!.root.findAllByType("span").some((span) => span.children.includes("8m"))).toBe(
    true,
  );
});

it("opens no detail streams or clocks for 54 collapsed groups", () => {
  const rows = Array.from({ length: 54 }, (_, index) => ({
    ...parent,
    id: ThreadId.make(`parent-${index}`),
  }));
  useUiStateStore.setState({
    sidebarTaskGroupsExpandedById: Object.fromEntries(
      rows.map((row) => [`local:${row.id}`, false]),
    ),
  });
  const interval = vi.spyOn(globalThis, "setInterval");
  hooks.projection.mockClear();
  act(() => {
    renderer = create(
      <>
        {rows.map((row) => (
          <SidebarTaskGroup
            key={row.id}
            parent={row}
            tasks={[task(`task-${row.id}`)]}
            {...callbacks}
            renamingThreadKey={null}
            renamingTitle=""
          />
        ))}
      </>,
    );
  });
  expect(hooks.projection).not.toHaveBeenCalled();
  expect(interval.mock.calls.filter((call) => call[1] === 5000)).toHaveLength(0);
  interval.mockRestore();
});

it("ignores file drops on child rows so they cannot attach to the parent", () => {
  act(() => {
    renderer = create(render([task("one")]));
  });
  const stopPropagation = vi.fn();
  const preventDefault = vi.fn();
  renderer!.root
    .findByProps({ className: "group/sidebar-task-group relative ml-3 pl-3" })
    .props.onDrop({ stopPropagation, preventDefault });
  expect(stopPropagation).toHaveBeenCalledOnce();
  expect(preventDefault).toHaveBeenCalledOnce();
});

it("keeps IME Enter in the rename editor, commits once, and cancels without a blur commit", () => {
  const child = task("rename");
  const view = () => (
    <SidebarTaskGroup
      parent={parent}
      tasks={[child]}
      {...callbacks}
      renamingThreadKey="local:rename"
      renamingTitle="New title"
    />
  );
  act(() => {
    renderer = create(view());
  });
  let input = renderer!.root.findByType("input");
  const preventDefault = vi.fn();
  input.props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: true }, preventDefault });
  expect(callbacks.onCommitRename).not.toHaveBeenCalled();
  input.props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault });
  input.props.onBlur();
  expect(callbacks.onCommitRename).toHaveBeenCalledExactlyOnceWith(
    { environmentId: env, threadId: child.id },
    "New title",
    child.title,
  );
  act(() => {
    renderer!.unmount();
    renderer = create(view());
  });
  input = renderer!.root.findByType("input");
  input.props.onKeyDown({ key: "Escape", nativeEvent: { isComposing: false }, preventDefault });
  input.props.onBlur();
  expect(callbacks.onCancelRename).toHaveBeenCalledOnce();
  expect(callbacks.onCommitRename).toHaveBeenCalledTimes(1);
});

it("cold collapsed parents show a shell delivery dot without loading detail, and keep explicit collapse", () => {
  const coldParent = {
    ...parent,
    source: { ...parent.source, latestTaskDeliveredAt: "2026-09-29T00:08:00.000Z" },
  };
  const child = { ...task("cold"), latestRun: null };
  useUiStateStore.setState({ sidebarTaskGroupsExpandedById: { "local:parent": false } });
  act(() => {
    renderer = create(<SidebarTaskDisclosure parent={coldParent} tasks={[child]} />);
  });
  expect(renderer!.root.findByType("button").props["aria-label"]).toBe(
    "Show 1 task, New task results",
  );
  expect(hooks.projection).not.toHaveBeenCalled();
  act(() => useUiStateStore.setState({ sidebarTaskGroupsExpandedById: {} }));
  expect(renderer!.root.findByType("button").props["aria-label"]).toBe(
    "Hide 1 task, New task results",
  );
  expect(hooks.projection).not.toHaveBeenCalled();
});
describe.each(["cold shell", "remembered roster"] as const)(
  "task unread state from %s",
  (source) => {
    const importedAt = "2026-09-29T00:10:00.000Z";
    const deliveredBeforeImport = "2026-09-29T00:08:00.000Z";
    const deliveredAfterImport = "2026-09-29T00:11:00.000Z";

    function view(deliveredAt: string, lastVisitedAt: string | null = null, taskCount = 1) {
      const children = Array.from({ length: taskCount }, (_, index) => ({
        ...task(`imported-${index}`),
        latestRun: null,
      }));
      if (source === "remembered roster") {
        useSidebarTaskPresentationStore.getState().remember("local:parent", {
          runs: [],
          subagents: children.map((child) => ({
            ...completedTaskRecord(child),
            runId: null,
            completionDelivery: { state: "delivered", observedByRunId: null, deliveredAt },
          })),
        });
      }
      return (
        <SidebarTaskDisclosure
          parent={{
            ...parent,
            lastVisitedAt,
            source: {
              ...parent.source,
              historyOrigin: "v1_import",
              legacyImportedAt: importedAt,
              ...(source === "cold shell" ? { latestTaskDeliveredAt: deliveredAt } : {}),
            },
          }}
          tasks={children}
        />
      );
    }

    const unreadDots = () =>
      renderer!.root.findAllByProps({ role: "img", "aria-label": "New task results" });

    it("shows no dots for 501 historical imported deliveries in a fresh browser profile", () => {
      act(() => {
        renderer = create(view(deliveredBeforeImport, null, 501));
      });
      expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({});
      expect(unreadDots()).toHaveLength(0);
      expect(renderer!.root.findByType("button").props["aria-expanded"]).toBe(false);
      expect(hooks.projection).not.toHaveBeenCalled();
    });

    it("shows a dot when a new result is delivered after import", () => {
      act(() => {
        renderer = create(view(deliveredBeforeImport));
      });
      expect(unreadDots()).toHaveLength(0);
      act(() => renderer!.update(view(deliveredAfterImport)));
      expect(unreadDots()).toHaveLength(1);
      expect(renderer!.root.findByType("button").props["aria-expanded"]).toBe(true);
    });

    it("clears the dot when only the server records a parent visit", () => {
      act(() => {
        renderer = create(view(deliveredAfterImport));
      });
      expect(unreadDots()).toHaveLength(1);
      act(() => renderer!.update(view(deliveredAfterImport, "2026-09-29T00:12:00.000Z")));
      expect(unreadDots()).toHaveLength(0);
      expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({});
      // A stale browser visit cannot override the later visit from another device.
      act(() =>
        useUiStateStore.getState().markThreadVisited("local:parent", deliveredBeforeImport),
      );
      expect(unreadDots()).toHaveLength(0);
    });

    it("clears the dot when only the browser records a parent visit", () => {
      act(() => {
        renderer = create(view(deliveredAfterImport));
      });
      expect(unreadDots()).toHaveLength(1);
      act(() =>
        useUiStateStore.getState().markThreadVisited("local:parent", "2026-09-29T00:12:00.000Z"),
      );
      expect(unreadDots()).toHaveLength(0);
      // A stale server visit cannot override the browser's later navigation.
      act(() => renderer!.update(view(deliveredAfterImport, deliveredBeforeImport)));
      expect(unreadDots()).toHaveLength(0);
    });
  },
);

it("collapsed native counts include new child shells absent from the remembered roster", () => {
  const known = { ...task("known"), latestRun: null };
  const record = { ...completedTaskRecord(known), origin: "provider_native" as const };
  useSidebarTaskPresentationStore
    .getState()
    .remember("local:parent", { subagents: [record], runs: [] });
  useUiStateStore.setState({ sidebarTaskGroupsExpandedById: { "local:parent": false } });
  const view = (rows: ReadonlyArray<EnvironmentThreadShell>) => (
    <SidebarTaskDisclosure parent={parent} tasks={[]} nativeThreads={rows} />
  );
  act(() => {
    renderer = create(view([known]));
  });
  expect(renderer!.root.findByType("button").props["aria-label"]).toBe("Show 1 agent");
  act(() => renderer!.update(view([known, task("new-native")])));
  expect(renderer!.root.findByType("button").props["aria-label"]).toBe("Show 2 agents");
});

describe("open task row", () => {
  const nested = {
    ...task("nested"),
    lineage: {
      rootThreadId: parent.id,
      parentThreadId: ThreadId.make("one"),
      relationshipToParent: "subagent" as const,
    },
  };
  const current = () =>
    renderer!.root
      .findAllByType("button")
      .filter((button) => button.props["aria-current"] === "page")
      .map((button) => button.findAllByType("span").map((span) => span.children.join("")));

  it("marks only the task matching the open thread, including a flattened nested task", () => {
    const view = (openThreadKey: string | null) => (
      <SidebarTaskGroup
        parent={parent}
        tasks={[task("one"), task("two"), nested]}
        openThreadKey={openThreadKey}
        {...callbacks}
        renamingThreadKey={null}
        renamingTitle=""
      />
    );
    act(() => {
      renderer = create(view("local:two"));
    });
    expect(current()).toHaveLength(1);
    expect(current()[0]).toContain("two");
    act(() => renderer!.update(view("local:nested")));
    expect(current()).toHaveLength(1);
    expect(current()[0]).toContain("nested");
    act(() => renderer!.update(view("local:parent")));
    expect(current()).toHaveLength(0);
  });

  it("expands a settled group for the open task but keeps an explicit collapse", () => {
    const settled = [
      { ...task("one"), latestRun: null },
      { ...task("two"), latestRun: null },
    ];
    const view = (openThreadKey: string | null) => (
      <>
        <SidebarTaskDisclosure parent={parent} tasks={settled} openThreadKey={openThreadKey} />
        <SidebarTaskGroup
          parent={parent}
          tasks={settled}
          openThreadKey={openThreadKey}
          {...callbacks}
          renamingThreadKey={null}
          renamingTitle=""
        />
      </>
    );
    act(() => {
      renderer = create(view(null));
    });
    expect(current()).toHaveLength(0);
    expect(renderer!.root.findAllByType("button")).toHaveLength(1);
    act(() => renderer!.update(view("local:two")));
    expect(current()).toHaveLength(1);
    const disclosure = renderer!.root.findAllByType("button")[0]!;
    act(() => disclosure.props.onClick({ stopPropagation() {}, preventDefault() {} }));
    expect(current()).toHaveLength(0);
    expect(renderer!.root.findAllByType("button")[0]!.props.className).toContain("text-foreground");
  });
});
