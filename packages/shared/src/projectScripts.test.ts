import { describe, expect, it } from "vite-plus/test";
import { projectScriptCwd, projectScriptRuntimeEnv } from "./projectScripts.ts";

const project = { cwd: "/new-primary" };
const thread = {
  worktreePath: "/sessions/feature/api/src",
  workspaceFolders: [
    { path: "/repos/api/src", name: "API", label: "api", checkoutRoot: "/repos/api" },
    { path: "/repos/ui", name: "UI", label: "ui", checkoutRoot: "/repos/ui" },
    { path: "/shared", name: "Shared", label: "shared" },
    { uri: "vscode-remote://ssh-remote+box/repo", name: "Remote", label: "remote" },
  ],
  worktrees: [
    { repositoryRoot: "/repos/api", path: "/sessions/feature/api", branch: "feature" },
    { repositoryRoot: "/repos/ui", path: "/sessions/feature/ui", branch: "feature" },
  ],
};

describe("Action workspace locations", () => {
  it("keeps legacy root and worktree behavior", () => {
    expect(projectScriptCwd({ project: { cwd: "/repo" } })).toBe("/repo");
    expect(projectScriptRuntimeEnv({ project: { cwd: "/repo" } })).toEqual({
      T3CODE_PROJECT_ROOT: "/repo",
    });
    expect(projectScriptCwd({ project: { cwd: "/repo" }, worktreePath: "/worktree" })).toBe(
      "/worktree",
    );
  });

  it("uses the frozen primary and its subfolder offset after the project changes", () => {
    expect(projectScriptCwd({ project, thread })).toBe("/sessions/feature/api/src");
    expect(projectScriptRuntimeEnv({ project, thread })).toEqual({
      T3CODE_PROJECT_ROOT: "/repos/api/src",
      T3CODE_WORKTREE_PATH: "/sessions/feature/api/src",
    });
    expect(
      projectScriptCwd({
        project,
        thread: { worktreePath: null, workspacePrimaryPath: "/old-primary" },
      }),
    ).toBe("/old-primary");
    expect(
      projectScriptRuntimeEnv({
        project,
        thread: { worktreePath: null, workspacePrimaryPath: "/old-primary" },
      }),
    ).toEqual({ T3CODE_PROJECT_ROOT: "/old-primary" });
  });

  it("maps a secondary Action and its environment into that folder's worktree", () => {
    const input = { project, thread, folderPath: "/repos/ui" };
    expect(projectScriptCwd(input)).toBe("/sessions/feature/ui");
    expect(projectScriptRuntimeEnv(input)).toEqual({
      T3CODE_PROJECT_ROOT: "/repos/ui",
      T3CODE_WORKTREE_PATH: "/sessions/feature/ui",
    });
  });

  it("leaves shared folders in place and keeps extra environment overrides", () => {
    const input = { project, thread, folderPath: "/shared", extraEnv: { CUSTOM: "yes" } };
    expect(projectScriptCwd(input)).toBe("/shared");
    expect(projectScriptRuntimeEnv(input)).toEqual({
      T3CODE_PROJECT_ROOT: "/shared",
      T3CODE_WORKTREE_PATH: "/shared",
      CUSTOM: "yes",
    });
  });

  it("can select an unbound project's folder without widening a bound thread", () => {
    const unbound = {
      cwd: "/repos/api",
      folders: [
        { path: "/repos/api", name: "API" },
        { path: "/repos/ui", name: "UI" },
      ],
    };
    expect(projectScriptCwd({ project: unbound, folderPath: "/repos/ui" })).toBe("/repos/ui");
    expect(() =>
      projectScriptCwd({
        project: unbound,
        thread: { worktreePath: null },
        folderPath: "/repos/ui",
      }),
    ).toThrow("not part of this thread");
  });

  it("rejects removed, remote and unavailable targets without a primary fallback", () => {
    expect(() => projectScriptCwd({ project, thread, folderPath: "/removed" })).toThrow(
      "not part of this thread",
    );
    expect(() =>
      projectScriptCwd({
        project,
        thread,
        folderPath: "/repos/ui",
        unavailableFolderPaths: ["/repos/ui"],
      }),
    ).toThrow("unavailable");
    expect(() =>
      projectScriptCwd({ project, thread, folderPath: "vscode-remote://ssh-remote+box/repo" }),
    ).toThrow("not part of this thread");
  });

  it("matches Windows folder identities case-insensitively", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "C:\\repos\\api" },
        thread: {
          worktreePath: "C:\\sessions\\api",
          workspaceFolders: [
            { path: "C:\\repos\\api", name: "API", label: "api" },
            { path: "D:\\repos\\ui", name: "UI", label: "ui" },
          ],
          worktrees: [
            { repositoryRoot: "D:\\repos\\ui", path: "D:\\sessions\\ui", branch: "feature" },
          ],
        },
        folderPath: "d:/repos/UI",
      }),
    ).toBe("D:\\sessions\\ui");
  });
});
