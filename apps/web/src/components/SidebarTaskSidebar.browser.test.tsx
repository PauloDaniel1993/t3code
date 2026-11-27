import { RouterProvider } from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, render } from "../../test/render";
import { makeThreadFixture } from "../test-fixtures";
import { useThreadSelectionStore } from "../threadSelectionStore";
import {
  setupTaskSidebar,
  sidebarTestEnvironmentId as environmentId,
} from "./sidebarTaskSidebar.testkit";

it.each(["Current thread", "No matching thread"])(
  "settling the current thread during search for %s opens the next thread",
  async (query) => {
    using stack = new DisposableStack();
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
    const threads = [current, next];
    const { settleThread, menu, newThread, router } = setupTaskSidebar(stack, threads, current);
    settleThread.mockImplementation(async () => {
      threads[0] = { ...current, settledOverride: "settled" };
      return AsyncResult.success({ sequence: 1 });
    });
    let resolveMenuChoice!: (choice: string) => void;
    menu.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveMenuChoice = resolve;
      }),
    );
    // The fixture supplies the real router with a matching thread route.
    await using screen = await render(<RouterProvider router={router} />, { router: false });
    const currentRow = screen.getByRole("button", { name: /^Current thread/ });
    const nextRow = screen.getByRole("button", { name: /^Next thread/ });
    await expect.element(currentRow).toHaveAttribute("aria-current", "page");
    await expect.element(nextRow).toBeInTheDocument();
    // Resolve the context menu only after search replaces the normal rows.
    await act(() =>
      currentRow
        .element()
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    expect(menu).toHaveBeenCalledOnce();
    expect(menu.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "settle" })]),
    );
    await screen.getByRole("combobox", { name: "Search threads" }).fill(query);
    await expect.element(nextRow).not.toBeInTheDocument();
    await act(async () => resolveMenuChoice("settle"));
    expect(settleThread).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      threadId: current.id,
    });
    expect(router.state.location.pathname).toBe(`/${environmentId}/${next.id}`);
    expect(newThread).not.toHaveBeenCalled();
  },
);
it("bulk delete uses the actual Sidebar selection and excludes collapsed tasks and filtered rows", async () => {
  using stack = new DisposableStack();
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
  const { deleteThread, menu, router } = setupTaskSidebar(stack, [parent, child, filtered]);
  menu.mockResolvedValue("delete");
  // The fixture supplies the real router with a matching thread route.
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  const parentRow = screen.getByRole("button", { name: /^Visible parent/ });
  await expect.element(parentRow).toBeInTheDocument();
  await expect.element(screen.getByText(child.title, { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText(filtered.title, { exact: true })).not.toBeInTheDocument();
  await act(() =>
    useThreadSelectionStore.setState({
      selectedThreadKeys: new Set(["local:parent", "local:task", "local:filtered"]),
    }),
  );
  await act(() =>
    parentRow
      .element()
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  await vi.waitFor(() =>
    expect(deleteThread).toHaveBeenCalledExactlyOnceWith(
      { environmentId, threadId: parent.id },
      expect.anything(),
    ),
  );
  expect(menu.mock.calls[0]?.[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "delete", label: "Delete (1)", destructive: true }),
    ]),
  );
});
