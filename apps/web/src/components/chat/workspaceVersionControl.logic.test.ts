import { ProjectId, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { workspaceFolderRows } from "../workspaceFolders.logic";
import { workspaceChangedFiles } from "./workspaceVersionControl.logic";

const project = {
  id: ProjectId.make("project"),
  workspaceRoot: "/repo/app",
  folders: [
    {
      name: "App",
      label: "app",
      path: "/repo/app",
      availability: "available" as const,
      vcs: { checkoutRoot: "/repo" },
    },
    {
      name: "Nested",
      label: "nested",
      path: "/repo/app/nested",
      availability: "available" as const,
      vcs: { checkoutRoot: "/repo" },
    },
    {
      name: "API",
      label: "api",
      path: "/api",
      availability: "available" as const,
      vcs: { checkoutRoot: "/api" },
    },
  ],
};
const thread = {
  worktreePath: "/set/app",
  workspaceFolders: project.folders.map((folder) => ({
    ...folder,
    checkoutRoot: folder.vcs.checkoutRoot,
    checkoutPrefix: folder.path === "/api" ? "" : folder.path.slice(6),
  })),
  worktrees: [
    { repositoryRoot: "/repo", path: "/set", branch: "feature" },
    { repositoryRoot: "/api", path: "/set-api", branch: "feature" },
  ],
};
const status = (paths: Array<string>): VcsStatusResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature",
  hasWorkingTreeChanges: true,
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
  workingTree: {
    files: paths.map((path) => ({ path, insertions: 1, deletions: 2 })),
    insertions: paths.length,
    deletions: paths.length * 2,
  },
});

describe("workspace combined changes", () => {
  it("uses each checkout once and labels files by their deepest frozen folder", () => {
    const files = workspaceChangedFiles(project, thread, workspaceFolderRows(project, thread), [
      status(["app/main.ts", "app/nested/deep.ts", "outside.ts"]),
      status(["src/api.ts"]),
    ]);
    expect(files.map((file) => file.canonicalPath)).toEqual([
      "app/main.ts",
      "nested/deep.ts",
      "api/src/api.ts",
    ]);
    expect(files.map((file) => file.row.folder.path)).toEqual([
      "/repo/app",
      "/repo/app/nested",
      "/api",
    ]);
  });
  it("does not relabel history with changed project folders or expose unavailable nested files", () => {
    const changed = {
      ...project,
      folders: [
        {
          ...project.folders[1]!,
          name: "Renamed",
          label: "renamed",
          availability: "unavailable" as const,
        },
        project.folders[0]!,
        project.folders[2]!,
      ],
    };
    const files = workspaceChangedFiles(changed, thread, workspaceFolderRows(changed, thread), [
      status(["app/main.ts", "app/nested/deep.ts"]),
      null,
    ]);
    expect(files.map((file) => file.canonicalPath)).toEqual(["app/main.ts"]);
  });
  it("keeps a one-folder scope free of label prefixes", () => {
    const single = { ...thread, workspaceFolders: [thread.workspaceFolders[0]!] };
    const files = workspaceChangedFiles(project, single, workspaceFolderRows(project, single), [
      status(["app/main.ts"]),
    ]);
    expect(files.map((file) => file.canonicalPath)).toEqual(["main.ts"]);
  });
  it("includes the primary's separately picked worktree without moving the other repository", () => {
    const picked = {
      ...thread,
      worktreePath: "/picked",
      worktrees: undefined,
      workspaceFolders: [thread.workspaceFolders[0]!, thread.workspaceFolders[2]!],
    };
    const files = workspaceChangedFiles(project, picked, workspaceFolderRows(project, picked), [
      status(["main.ts"]),
      status(["src/api.ts"]),
    ]);
    expect(files.map((file) => file.canonicalPath)).toEqual(["app/main.ts", "api/src/api.ts"]);
  });
});
