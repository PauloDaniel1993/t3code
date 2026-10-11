import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: null }));
vi.mock("./shell", () => ({ environmentSnapshotAtom: vi.fn() }));

import { switchWorkspaceFileQuery, workspaceFileBindingKey } from "./workspace-file-bindings";

const projectScope = { projectId: ProjectId.make("project-1") };
const threadScope = { ...projectScope, threadId: ThreadId.make("thread-1") };
const project = {
  workspaceRoot: "/web",
  workspaceFile: "/app.code-workspace",
  folders: [
    { path: "/web", name: "web", label: "web" },
    { path: "/api", name: "api", label: "api" },
  ],
};
const thread = {
  worktreePath: "/trees/web",
  branch: "feature",
  worktrees: [
    { repositoryRoot: "/web", path: "/trees/web", branch: "feature" },
    { repositoryRoot: "/api", path: "/trees/api", branch: "feature" },
  ],
};

describe("workspace file binding caches", () => {
  it("follows live draft folders while keeping thread snapshots independent of project edits", () => {
    const renamed = {
      ...project,
      folders: [{ ...project.folders[0]!, label: "frontend" }, project.folders[1]!],
    };
    expect(workspaceFileBindingKey(projectScope, project, null)).not.toBe(
      workspaceFileBindingKey(projectScope, renamed, null),
    );
    expect(workspaceFileBindingKey(threadScope, project, thread)).toBe(
      workspaceFileBindingKey(threadScope, renamed, thread),
    );
  });

  it("invalidates on a secondary worktree remap or an in-place branch switch", () => {
    const original = workspaceFileBindingKey(threadScope, project, thread);
    expect(
      workspaceFileBindingKey(threadScope, project, {
        ...thread,
        worktrees: [thread.worktrees[0]!, { ...thread.worktrees[1]!, path: "/trees/other-api" }],
      }),
    ).not.toBe(original);
    expect(workspaceFileBindingKey(threadScope, project, { ...thread, branch: "other" })).not.toBe(
      original,
    );
  });

  it("drops previous file contents and ignores their late response after a binding switch", () => {
    const binding = Atom.make("old");
    const oldQuery = Atom.make(AsyncResult.success("old contents"));
    const newQuery = Atom.make<AsyncResult.AsyncResult<string>>(AsyncResult.initial(true));
    const query = switchWorkspaceFileQuery(binding, (key) => (key === "old" ? oldQuery : newQuery));
    const registry = AtomRegistry.make();
    const unmount = registry.mount(query);
    expect(registry.get(query)).toMatchObject({ _tag: "Success", value: "old contents" });
    registry.set(binding, "new");
    expect(registry.get(query)._tag).toBe("Initial");
    registry.set(oldQuery, AsyncResult.success("late old contents"));
    expect(registry.get(query)._tag).toBe("Initial");
    registry.set(newQuery, AsyncResult.success("new contents"));
    expect(registry.get(query)).toMatchObject({ _tag: "Success", value: "new contents" });
    unmount();
    registry.dispose();
  });

  it("refreshes the selected query when the user retries", () => {
    const binding = Atom.make("current");
    let reads = 0;
    const source = Atom.make(() => ++reads);
    const query = switchWorkspaceFileQuery(binding, () => source);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(query);
    expect(registry.get(query)).toBe(1);
    registry.refresh(query);
    expect(registry.get(query)).toBe(2);
    unmount();
    registry.dispose();
  });
});
