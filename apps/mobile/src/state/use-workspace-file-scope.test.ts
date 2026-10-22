import { ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react", () => ({ useMemo: <A>(compute: () => A) => compute() }));

import { useWorkspaceFileScope } from "./use-workspace-file-scope";

it("keeps the composer's thread scope after detail loads and its project unlinks", () => {
  const project = { id: ProjectId.make("project-1"), workspaceFile: null };
  const id = ThreadId.make("thread-1");
  const shell = { id, workspaceFolderCount: 2, workspacePrimaryPath: "/workspace/web" };
  const detail = {
    id,
    workspaceFolders: [
      { path: "/workspace/web", name: "web", label: "web" },
      { path: "/workspace/api", name: "api", label: "api" },
    ],
  };
  const expected = { projectId: project.id, threadId: id };

  expect(useWorkspaceFileScope({ enabled: true, project, thread: shell })).toEqual(expected);
  expect(useWorkspaceFileScope({ enabled: true, project, thread: detail })).toEqual(expected);
});

it("keeps ordinary threads and disabled workspace support on cwd inputs", () => {
  const project = { id: ProjectId.make("project-1"), workspaceFile: null };
  const thread = { id: ThreadId.make("thread-1") };

  expect(useWorkspaceFileScope({ enabled: true, project, thread })).toBeNull();
  expect(
    useWorkspaceFileScope({ enabled: false, project, thread: { ...thread, workspaceFolders: [] } }),
  ).toBeNull();
});
