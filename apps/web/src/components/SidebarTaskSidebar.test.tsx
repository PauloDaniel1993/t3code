// @vitest-environment jsdom
import { getSidebarHarness } from "./sidebarTaskSidebar.testkit";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../test-fixtures";
import { useUiStateStore } from "../uiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { archiveSelectedThreadEntries } from "./Sidebar.logic";
import Sidebar from "./Sidebar";

const sidebarHarness = getSidebarHarness();
const environmentId = EnvironmentId.make("local");
let tree: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sidebarHarness.menu.mockClear();
  sidebarHarness.remove.mockClear();
  sidebarHarness.archive.mockClear();
  sidebarHarness.settle.mockReset();
  sidebarHarness.navigate.mockClear();
  sidebarHarness.newThread.mockClear();
  sidebarHarness.routeTarget = null;
  sidebarHarness.selection = [];
  sidebarHarness.projects = ["shown", "hidden"].map((id) => ({
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot: `/workspace/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-29T00:00:00Z",
    updatedAt: "2026-09-29T00:00:00Z",
  }));
  useUiStateStore.setState({
    sidebarTaskGroupsExpandedById: { "local:parent": false },
    threadLastVisitedAtById: {},
    sidebarProjectScopeKey: "local:/workspace/shown",
  });
  useThreadSelectionStore.getState().clearSelection();
});

it.each(["Current thread", "No matching thread"])(
  "settling the current thread during search for %s opens the next thread",
  async (query) => {
    const current = makeThreadFixture({
      environmentId,
      projectId: ProjectId.make("shown"),
      id: ThreadId.make("current"),
      title: "Current thread",
      settledOverride: "active",
      activeOrderKey: "a0",
    });
    const next = makeThreadFixture({
      environmentId,
      projectId: current.projectId,
      id: ThreadId.make("next"),
      title: "Next thread",
      settledOverride: "active",
      activeOrderKey: "a1",
    });
    sidebarHarness.threads = [current, next];
    sidebarHarness.routeTarget = {
      kind: "server",
      threadRef: { environmentId, threadId: current.id },
    };
    sidebarHarness.settle.mockImplementation(async () => {
      sidebarHarness.threads = [{ ...current, settledOverride: "settled" }, next];
      return { _tag: "Success" };
    });
    let resolveMenuChoice!: (choice: string) => void;
    sidebarHarness.menu.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveMenuChoice = resolve;
      }),
    );
    act(() => {
      tree = create(<Sidebar />, {
        createNodeMock: (element) =>
          document.createElement(typeof element.type === "string" ? element.type : "div"),
      });
    });
    const currentRow = tree!.root.find(
      (node) =>
        typeof node.type === "string" &&
        node.props["aria-current"] === "page" &&
        node.props.onContextMenu !== undefined,
    );
    // Choose Settle from the open menu after search has replaced the normal rows.
    act(() =>
      currentRow.props.onContextMenu({
        preventDefault() {},
        stopPropagation() {},
        clientX: 0,
        clientY: 0,
      }),
    );
    expect(sidebarHarness.menu).toHaveBeenCalledOnce();
    act(() =>
      tree!.root.findByProps({ "aria-label": "Search threads" }).props.onChange({
        target: { value: query },
      }),
    );
    expect(tree!.root.findAllByProps({ title: next.title })).toHaveLength(0);
    await act(async () => resolveMenuChoice("settle"));
    expect(sidebarHarness.settle).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      threadId: current.id,
    });
    expect(sidebarHarness.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: next.id },
    });
    expect(sidebarHarness.newThread).not.toHaveBeenCalled();
  },
);
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  vi.unstubAllGlobals();
});

it.each(["delete", "archive"])(
  "bulk %s uses the actual Sidebar selection and excludes collapsed tasks and filtered rows",
  async (action) => {
    sidebarHarness.menu.mockResolvedValue(action === "delete" ? "delete" : "dismiss");
    const parent = makeThreadFixture({
      environmentId,
      projectId: ProjectId.make("shown"),
      id: ThreadId.make("parent"),
      title: "Visible parent",
      settledOverride: "active",
    });
    const child = makeThreadFixture({
      environmentId,
      projectId: parent.projectId,
      id: ThreadId.make("task"),
      title: "Hidden task",
      lineage: {
        parentThreadId: parent.id,
        rootThreadId: parent.id,
        relationshipToParent: "subagent",
      },
    });
    const filtered = makeThreadFixture({
      environmentId,
      projectId: ProjectId.make("hidden"),
      id: ThreadId.make("filtered"),
      title: "Other thread",
      settledOverride: "active",
    });
    sidebarHarness.threads = [parent, child, filtered];
    act(() => {
      tree = create(<Sidebar />, {
        createNodeMock: (element) =>
          document.createElement(typeof element.type === "string" ? element.type : "div"),
      });
    });
    act(() =>
      useThreadSelectionStore.setState({
        selectedThreadKeys: new Set(["local:parent", "local:task", "local:filtered"]),
      }),
    );
    const rendered = tree!.root.findAll(
      (node) => typeof node.type === "string" && node.props.onContextMenu !== undefined,
    );
    expect(rendered.length).toBeGreaterThan(0);
    await act(async () =>
      rendered[0]!.props.onContextMenu({
        preventDefault() {},
        stopPropagation() {},
        clientX: 0,
        clientY: 0,
      }),
    );
    if (action === "delete")
      expect(sidebarHarness.remove).toHaveBeenCalledExactlyOnceWith(
        { environmentId, threadId: parent.id },
        expect.anything(),
      );
    else expect(sidebarHarness.remove).not.toHaveBeenCalled();
    expect(sidebarHarness.selection.map((entry) => entry.threadKey)).toEqual(["local:parent"]);
    expect(sidebarHarness.menu.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([{ id: "delete", label: "Delete (1)", destructive: true }]),
    );
    // V2's bulk menu has Settle/Delete, not Archive. Apply its captured, real
    // actionable selection to the shared archive executor as well.
    if (action === "archive") {
      await archiveSelectedThreadEntries({
        entries: sidebarHarness.selection,
        archive: sidebarHarness.archive,
      });
      expect(sidebarHarness.archive).toHaveBeenCalledExactlyOnceWith(
        { threadKey: "local:parent", thread: parent },
        expect.any(Function),
      );
    }
  },
);
