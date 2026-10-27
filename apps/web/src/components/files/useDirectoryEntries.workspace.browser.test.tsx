import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
const mocks = vi.hoisted(() => ({ list: vi.fn(), execute: vi.fn() }));
vi.mock("~/state/projects", () => ({ projectEnvironment: { listEntries: mocks.list } }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ executeAtomQuery: mocks.execute }));
import { useDirectoryEntries } from "./useDirectoryEntries";
import { workspaceFileContext } from "./workspaceFiles";

const environmentId = EnvironmentId.make("lazy-explorer");
const project = {
  id: ProjectId.make("project"),
  workspaceRoot: "/api",
  workspaceFile: "/dev.code-workspace",
  folders: [
    { path: "/api", name: "api", label: "api" },
    { path: "/ui", name: "ui", label: "ui" },
  ],
};
const workspace = workspaceFileContext(
  project,
  { worktreePath: null, workspaceFolders: project.folders },
  ThreadId.make("thread"),
  true,
)!;
const folders = [
  { folderPath: "/api", label: "api", status: "ok" },
  { folderPath: "/ui", label: "ui", status: "unavailable" },
] as const;
function Explorer({
  context = workspace,
  onChange,
}: {
  context?: typeof workspace;
  onChange: (state: ReturnType<typeof useDirectoryEntries>) => void;
}) {
  const entries = useDirectoryEntries(environmentId, "/api", context);
  useLayoutEffect(() => {
    onChange(entries);
  }, [entries, onChange]);
  return null;
}

function setup() {
  mocks.list.mockReset().mockImplementation((request) => request);
  mocks.execute.mockReset().mockImplementation(async (_registry, request) =>
    AsyncResult.success({
      entries:
        request.input.directoryPath === "api" ? [{ path: "api/readme.md", kind: "file" }] : [],
      folders,
      truncated: false,
    }),
  );
}

describe("workspace explorer loading", () => {
  it("keeps loaded directories across unrelated projection object changes", async () => {
    setup();
    let state!: ReturnType<typeof useDirectoryEntries>;
    const onChange = (next: typeof state) => {
      state = next;
    };
    await using screen = await render(<Explorer onChange={onChange} />);
    await act(async () => {
      await state.load("api");
    });
    await screen.rerender(
      <Explorer
        onChange={onChange}
        context={{
          ...workspace,
          scope: { ...workspace.scope },
          folders: workspace.folders.map((folder) => ({ ...folder })),
        }}
      />,
    );
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(state.entries).toContainEqual({ path: "api/readme.md", kind: "file" });
  });
  it("loads only the folder table, then pins an explicitly expanded root and caches it", async () => {
    setup();
    let state!: ReturnType<typeof useDirectoryEntries>;
    const onChange = (next: typeof state) => {
      state = next;
    };
    await using _screen = await render(<Explorer onChange={onChange} />);
    expect(state.entries).toEqual([
      { path: "api", kind: "directory" },
      { path: "ui", kind: "directory" },
    ]);
    expect(state.folders).toEqual(folders);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.list.mock.calls[0]![0].input).toEqual({
      scope: workspace.scope,
      directoryPath: "",
    });
    await act(async () => {
      await state.load("api");
    });
    expect(state.entries).toEqual([
      { path: "api", kind: "directory" },
      { path: "api/readme.md", kind: "file" },
      { path: "ui", kind: "directory" },
    ]);
    expect(mocks.list.mock.calls[1]![0].input).toEqual({
      scope: { ...workspace.scope, folderPath: "/api" },
      directoryPath: "api",
    });
    await act(async () => {
      await state.load("api");
    });
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it("caps directory reads at four and discards completions after unmount", async () => {
    setup();
    let state!: ReturnType<typeof useDirectoryEntries>;
    const onChange = (next: typeof state) => {
      state = next;
    };
    await using screen = await render(<Explorer onChange={onChange} />);
    const releases: Array<() => void> = [];
    mocks.execute.mockImplementation(
      () =>
        new Promise((resolve) =>
          releases.push(() =>
            resolve(AsyncResult.success({ entries: [], folders, truncated: false })),
          ),
        ),
    );
    let requests: Promise<void>[] = [];
    await act(async () => {
      requests = Array.from({ length: 6 }, (_, index) => state.load(`api/dir${index}`));
    });
    expect(releases).toHaveLength(4);
    await screen.unmount();
    await act(async () => {
      releases.forEach((release) => release());
      await Promise.all(requests);
    });
    expect(releases).toHaveLength(4);
  });

  it("reloads membership and ignores old in-flight entries when a draft relinks", async () => {
    setup();
    let state!: ReturnType<typeof useDirectoryEntries>;
    const onChange = (next: typeof state) => {
      state = next;
    };
    const draft = workspaceFileContext(project, null, undefined, true)!;
    await using screen = await render(<Explorer context={draft} onChange={onChange} />);
    let release!: () => void;
    mocks.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              AsyncResult.success({
                entries: [{ path: "ui/old.ts", kind: "file" }],
                folders,
                truncated: false,
              }),
            );
        }),
    );
    let oldRequest!: Promise<void>;
    await act(async () => {
      oldRequest = state.load("ui");
    });
    const nextProject = {
      ...project,
      folders: [project.folders[0]!, { path: "/docs", name: "docs", label: "docs" }],
    };
    const nextFolders = [folders[0], { folderPath: "/docs", label: "docs", status: "ok" as const }];
    mocks.execute.mockResolvedValue(
      AsyncResult.success({ entries: [], folders: nextFolders, truncated: false }),
    );
    await screen.rerender(
      <Explorer
        onChange={onChange}
        context={workspaceFileContext(nextProject, null, undefined, true)!}
      />,
    );
    await act(async () => {
      release();
      await oldRequest;
    });
    expect(state.entries).toEqual([
      { path: "api", kind: "directory" },
      { path: "docs", kind: "directory" },
    ]);
    expect(state.folders).toEqual(nextFolders);
    expect(mocks.execute).toHaveBeenCalledTimes(3);
    expect(state.isPending).toBe(false);
  });
});
