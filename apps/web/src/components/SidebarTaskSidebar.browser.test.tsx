import { getSidebarHarness } from "./sidebarTaskSidebar.testkit";
import { act, render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../test-fixtures";
import { useUiStateStore } from "../uiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { archiveSelectedThreadEntries } from "./Sidebar.logic";
import Sidebar from "./Sidebar";

const sidebarHarness = getSidebarHarness();
const environmentId = EnvironmentId.make("local");
function setup() {
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
}

it.each(["Current thread", "No matching thread"])(
  "settling the current thread during search for %s opens the next thread",
  async (query) => {
    setup();
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
    // The harness supplies the router and captures navigation.
    await using screen = await render(
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />,
      { router: false },
    );
    const currentRow = screen.container.querySelector('[aria-current="page"]')!;
    // Resolve the context menu only after search replaces the normal rows.
    await act(() =>
      currentRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    expect(sidebarHarness.menu).toHaveBeenCalledOnce();
    await screen.getByRole("textbox", { name: "Search threads" }).fill(query);
    expect(screen.container.querySelector(`[title="${next.title}"]`)).toBeNull();
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
it.each(["delete", "archive"])(
  "bulk %s uses the actual Sidebar selection and excludes collapsed tasks and filtered rows",
  async (action) => {
    setup();
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
    // The harness supplies the router and captures navigation.
    await using screen = await render(
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />,
      { router: false },
    );
    await act(() =>
      useThreadSelectionStore.setState({
        selectedThreadKeys: new Set(["local:parent", "local:task", "local:filtered"]),
      }),
    );
    const rendered = screen.container.querySelectorAll(
      '[data-testid="sidebar-row-card"], [data-testid="sidebar-row-slim"]',
    );
    expect(rendered.length).toBeGreaterThan(0);
    await act(() =>
      rendered[0]!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      ),
    );
    await vi.waitFor(() => expect(sidebarHarness.menu).toHaveBeenCalled());
    if (action === "delete")
      await vi.waitFor(() =>
        expect(sidebarHarness.remove).toHaveBeenCalledExactlyOnceWith(
          { environmentId, threadId: parent.id },
          expect.anything(),
        ),
      );
    else expect(sidebarHarness.remove).not.toHaveBeenCalled();
    expect(sidebarHarness.selection.map((entry) => entry.threadKey)).toEqual(["local:parent"]);
    expect(sidebarHarness.menu.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "delete", label: "Delete (1)", destructive: true }),
      ]),
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
