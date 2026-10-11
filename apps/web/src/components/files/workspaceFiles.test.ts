import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  workspaceFileAsset,
  workspaceFileContext,
  workspaceFileMention,
  workspaceFileReference,
  workspaceFileScopeKey,
  workspaceFolderProblems,
  workspaceResultFolderPath,
} from "./workspaceFiles";

const project = {
  id: ProjectId.make("workspace-files"),
  workspaceRoot: "/source/api",
  workspaceFile: "/source/dev.code-workspace",
  folders: [
    { path: "/source/api", name: "api", label: "api" },
    { path: "/source/ui", name: "ui", label: "ui" },
    { uri: "vscode-remote://ssh-remote+host/srv", name: "remote", label: "remote" },
  ],
};
const thread = {
  worktreePath: "/session/api",
  workspaceFolders: project.folders,
  worktrees: [
    { repositoryRoot: "/source/api", path: "/session/api", branch: "feature" },
    { repositoryRoot: "/source/ui", path: "/session/ui", branch: "feature" },
  ],
};
const threadId = ThreadId.make("bound-thread");
const workspace = workspaceFileContext(project, thread, threadId, true)!;

describe("workspace file addresses", () => {
  it("canonicalizes Windows separators and preserves POSIX backslashes", () => {
    const windows = workspaceFileContext(
      {
        ...project,
        workspaceRoot: "C:/api",
        folders: [
          { path: "C:/api", name: "api", label: "api" },
          { path: "C:/ui", name: "ui", label: "ui" },
        ],
      },
      null,
      undefined,
      true,
    )!;
    expect(workspaceFileReference(windows, "c:\\ui\\src\\main.ts")?.canonicalPath).toBe(
      "ui/src/main.ts",
    );
    expect(workspaceFileReference(workspace, "/session/ui/a\\b.ts")?.canonicalPath).toBe(
      "ui/a\\b.ts",
    );
  });
  it("retains the frozen folders after relink, reorder, and unlink", () => {
    const changed = { ...project, workspaceRoot: "/new", workspaceFile: null, folders: [] };
    expect(workspaceFileContext(changed, thread, threadId, true)).toEqual(workspace);
  });

  it("uses current membership for an unbound draft and gates scoped inputs", () => {
    expect(workspaceFileContext(project, null, undefined, true)?.scope).toEqual({
      projectId: project.id,
    });
    expect(workspaceFileContext(project, null, undefined, true)?.folders).toHaveLength(3);
    expect(workspaceFileContext(project, thread, threadId, false)).toBeUndefined();
    expect(
      workspaceFileContext({ ...project, workspaceFile: null, folders: [] }, null, undefined, true),
    ).toBeUndefined();
  });

  it("maps a canonical selection and pins its owning folder", () => {
    expect(workspaceFileReference(workspace, "ui/src/main.ts")).toMatchObject({
      absolutePath: "/session/ui/src/main.ts",
      relativePath: "src/main.ts",
      folderPath: "/source/ui",
      scope: { projectId: project.id, threadId, folderPath: "/source/ui" },
    });
    expect(workspaceFileReference(workspace, "ui/src/main.ts", "/different")).toBeNull();
    expect(workspaceFileReference(workspace, "unknown/main.ts")).toBeNull();
    expect(workspaceFileReference(workspace, "remote/main.ts")?.absolutePath).toBeNull();
  });

  it("maps absolute links to the deepest effective folder while leaving host files separate", () => {
    const nested = workspaceFileContext(
      {
        ...project,
        folders: [
          ...project.folders,
          { path: "/source/ui/packages", name: "packages", label: "packages" },
        ],
      },
      null,
      undefined,
      true,
    )!;
    expect(workspaceFileReference(nested, "/source/ui/packages/lib.ts")?.canonicalPath).toBe(
      "packages/lib.ts",
    );
    expect(workspaceFileReference(workspace, "/session/ui/main.ts")?.canonicalPath).toBe(
      "ui/main.ts",
    );
    expect(workspaceFileReference(workspace, "/host/report.txt")).toBeNull();
  });

  it("does not remove a label-looking directory in a one-folder scope", () => {
    const single = workspaceFileContext(
      project,
      { worktreePath: null, workspaceFolders: [project.folders[0]!] },
      threadId,
      true,
    )!;
    expect(workspaceFileReference(single, "api/src/main.ts")).toMatchObject({
      canonicalPath: "api/src/main.ts",
      absolutePath: "/source/api/api/src/main.ts",
    });
  });

  it("keeps primary mentions relative and secondary mentions concrete, including escaping", () => {
    expect(workspaceFileMention(workspace, "api/src/main.ts")).toBe("[main.ts](src/main.ts)");
    expect(workspaceFileMention(workspace, "ui/src/a [b]#.ts")).toBe(
      "[ui/src/a \\[b\\]#.ts](/session/ui/src/a%20%5Bb%5D%23.ts)",
    );
    expect(workspaceFileMention(workspace, "remote/main.ts")).toBeNull();
    expect(workspaceFileMention(undefined, "src/main.ts")).toBe("[main.ts](src/main.ts)");
  });

  it("pins using the response owner rather than the narrowed search folder", () => {
    const table = [
      { folderPath: "/source/api", label: "api", status: "ok" as const },
      { folderPath: "/source/ui", label: "ui", status: "ok" as const },
    ];
    expect(workspaceResultFolderPath("ui/main.ts", table)).toBe("/source/ui");
    expect(workspaceResultFolderPath("ui/main.ts", [table[0]!])).toBe("/source/api");
    expect(workspaceResultFolderPath("missing/main.ts", table)).toBeUndefined();
    expect(
      workspaceFolderProblems([
        { ...table[0]!, status: "index-error" },
        { ...table[1]!, status: "unavailable" },
      ]),
    ).toBe("api: file index failed · ui: unavailable");
  });

  it("separates cache identities by project, thread and folder, and signs pinned assets", () => {
    const scope = { ...workspace.scope, folderPath: "/source/ui" };
    const key = workspaceFileScopeKey("/source/api", scope);
    expect(key).not.toBe(
      workspaceFileScopeKey("/source/api", { ...scope, folderPath: "/source/api" }),
    );
    expect(key).not.toBe(
      workspaceFileScopeKey("/source/api", { ...scope, threadId: ThreadId.make("other") }),
    );
    expect(key).not.toBe(
      workspaceFileScopeKey("/source/api", { ...scope, projectId: ProjectId.make("other") }),
    );
    expect(workspaceFileAsset(scope, "ui/image.png")).toEqual({
      _tag: "workspace-scope-file",
      scope,
      path: "ui/image.png",
    });
    expect(workspaceFileAsset(workspace.scope, "ui/image.png")).toBeUndefined();
  });
});
