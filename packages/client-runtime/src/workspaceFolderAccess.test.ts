import { describe, expect, it } from "vite-plus/test";

import { isProviderEligibleForScope, workspaceFolderScope } from "./workspaceFolderAccess.ts";

const linkedProject = {
  workspaceRoot: "/work/app",
  workspaceFile: "/work/app.code-workspace",
  trackedFolders: [{ path: "/elsewhere/tracked", name: "tracked" }],
  folders: [
    { path: "/work/app", name: "app", label: "app", availability: "available" as const },
    { path: "/work/app/web", name: "web", label: "web", availability: "available" as const },
    { path: "/work/docs", name: "docs", label: "docs", availability: "available" as const },
    { path: "/work/gone", name: "gone", label: "gone", availability: "unavailable" as const },
    { uri: "vscode-remote://ssh-remote+box/srv", name: "srv", label: "srv" },
  ],
};

describe("workspaceFolderScope", () => {
  it("gives a new thread of a linked project its project's reachable folders outside the primary", () => {
    expect(workspaceFolderScope({ thread: null, project: linkedProject })).toEqual({
      additionalDirectories: ["/work/docs"],
    });
  });

  it("gives plain projects and threads without a snapshot one folder", () => {
    expect(workspaceFolderScope({ thread: null, project: { workspaceRoot: "/work/app" } })).toEqual(
      { additionalDirectories: [] },
    );
    expect(
      workspaceFolderScope({
        thread: { worktreePath: null, workspacePrimaryPath: "/work/app" },
        project: linkedProject,
      }),
    ).toEqual({ additionalDirectories: [] });
  });

  it("checks a plain project's tracked folders for local runs", () => {
    const project = {
      workspaceRoot: "C:\\Projects\\App",
      trackedFolders: [
        { path: "c:/projects/app/web", name: "web", discovered: true },
        { path: "C:/Projects/Application", name: "other repo" },
        { path: "c:\\projects\\application", name: "alias" },
      ],
    };
    for (const thread of [null, { worktreePath: null }]) {
      const scope = workspaceFolderScope({ thread, project });
      expect(scope).toEqual({ additionalDirectories: ["C:/Projects/Application"] });
      expect(isProviderEligibleForScope({ workspaceFolderAccess: "unsupported" }, scope)).toBe(
        false,
      );
    }
    const singleWorktree = workspaceFolderScope({
      thread: { worktreePath: "C:/Worktrees/App" },
      project,
    });
    const nestedOnly = workspaceFolderScope({
      thread: null,
      project: { ...project, trackedFolders: project.trackedFolders.slice(0, 1) },
    });
    expect(isProviderEligibleForScope({}, singleWorktree)).toBe(true);
    expect(isProviderEligibleForScope({}, nestedOnly)).toBe(true);
  });

  it("reads a bound thread's frozen snapshot, mapped into its worktree set", () => {
    expect(
      workspaceFolderScope({
        thread: {
          worktreePath: "/wt/s/repo/app",
          workspaceFolders: [
            { path: "/repo/app", name: "app", label: "app", checkoutRoot: "/repo" },
            { path: "/repo/lib", name: "lib", label: "lib", checkoutRoot: "/repo" },
          ],
          worktrees: [{ repositoryRoot: "/repo", path: "/wt/s/repo", branch: "t3code/x" }],
        },
        // The project has since moved on; the thread keeps its own folders.
        project: { workspaceRoot: "/elsewhere" },
      }),
    ).toEqual({ additionalDirectories: ["/wt/s/repo/lib"] });
  });
});

describe("isProviderEligibleForScope", () => {
  const spanning = { additionalDirectories: ["/work/docs"] };

  it("lets only a supported provider run a scope with additional directories", () => {
    expect(isProviderEligibleForScope({ workspaceFolderAccess: "supported" }, spanning)).toBe(true);
    expect(isProviderEligibleForScope({ workspaceFolderAccess: "unverified" }, spanning)).toBe(
      false,
    );
    expect(isProviderEligibleForScope({ workspaceFolderAccess: "unsupported" }, spanning)).toBe(
      false,
    );
    // An older server says nothing, which is unverified.
    expect(isProviderEligibleForScope({}, spanning)).toBe(false);
  });

  it("lets every provider run a one-folder scope", () => {
    expect(isProviderEligibleForScope({}, { additionalDirectories: [] })).toBe(true);
  });
});
