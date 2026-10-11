import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  availableWorkspaceGitCheckouts,
  workspaceAvailabilityPending,
  workspaceFolderChipCount,
  workspaceFolderRows,
  workspaceRepositoryCount,
  workspaceSnapshotChanged,
  type WorkspaceFoldersProject,
} from "./workspace-folders-model";

const project: WorkspaceFoldersProject = {
  id: ProjectId.make("project"),
  workspaceRoot: "/repo/api",
  workspaceFile: "/repo/app.code-workspace",
  folders: [
    {
      name: "API",
      label: "api",
      path: "/repo/api",
      availability: "available",
      vcs: { checkoutRoot: "/repo/api" },
    },
    {
      name: "Web",
      label: "web",
      path: "/repo/web",
      availability: "available",
      vcs: { checkoutRoot: "/repo/web" },
    },
    { name: "Notes", label: "notes", path: "/repo/notes", availability: "available", vcs: null },
    {
      name: "Remote",
      label: "remote",
      uri: "vscode-remote://ssh-remote+devbox/code",
      availability: "unavailable",
      unavailableReason: "remote",
      remoteDescription: "SSH: devbox",
    },
  ],
};
const thread = {
  worktreePath: null,
  workspaceFolders: project.folders!.map((folder) => ({
    path: folder.path,
    uri: folder.uri,
    name: folder.name,
    label: folder.label,
    checkoutRoot: folder.vcs?.checkoutRoot ?? null,
  })),
};
describe("mobile workspace folders", () => {
  it("uses frozen checkout prefixes for diff ownership while keeping lexical paths for requests", () => {
    const aliased = {
      ...thread,
      workspaceFolders: [
        {
          name: "API",
          label: "api",
          path: "/alias/api",
          checkoutRoot: "/repo",
          checkoutPrefix: "packages/api",
        },
      ],
    };
    expect(workspaceFolderRows(project, aliased)[0]).toMatchObject({
      effectivePath: "/alias/api",
      diffPath: "/repo/packages/api",
    });
    expect(
      workspaceFolderRows(project, { ...aliased, worktreePath: "/picked/api" })[0]?.diffPath,
    ).toBe("/picked/api");
  });
  it("keeps the snapshot's names and order after a project relink", () => {
    const changed = {
      ...project,
      folders: [{ name: "Elsewhere", label: "elsewhere", path: "/new" }],
    };
    expect(workspaceFolderRows(changed, thread).map((row) => row.folder.name)).toEqual([
      "API",
      "Web",
      "Notes",
      "Remote",
    ]);
    expect(workspaceSnapshotChanged(changed, thread)).toBe(true);
    expect(workspaceSnapshotChanged(project, thread)).toBe(false);
  });
  it("groups remote and shared folders outside Git actions", () => {
    const rows = workspaceFolderRows(project, thread);
    expect(workspaceRepositoryCount(rows)).toBe(2);
    expect(rows.filter((row) => !row.isGit).map((row) => row.label)).toEqual(["notes", "remote"]);
    expect(rows[3]?.reason).toBe("Remote (SSH: devbox), not available here");
    expect(rows[3]?.effectivePath).toBeNull();
  });
  it("keeps the primary worktree available while reporting unavailable secondary sources", () => {
    const missing = {
      ...project,
      folders: project.folders?.map((folder) => ({
        ...folder,
        availability: "unavailable" as const,
        unavailableReason: "missing" as const,
      })),
    };
    const set = {
      ...thread,
      worktreePath: "/session/api",
      worktrees: [
        { repositoryRoot: "/repo/api", path: "/session/api", branch: "feature" },
        { repositoryRoot: "/repo/web", path: "/session/web", branch: "feature" },
      ],
    };
    const rows = workspaceFolderRows(missing, set);
    expect(rows.slice(0, 2).map((row) => row.effectivePath)).toEqual(["/session/api", null]);
    expect(workspaceAvailabilityPending(rows, [])).toBe(true);
  });
  it("reports recovery as a next-turn change without changing folder identities", () => {
    const rows = workspaceFolderRows(project, thread);
    expect(workspaceAvailabilityPending(rows, ["/repo/web"])).toBe(true);
    expect(workspaceAvailabilityPending(rows, [])).toBe(false);
  });
  it("a bound shell never borrows the project's changed count", () => {
    expect(workspaceFolderChipCount({ workspaceFolderCount: 2 }, project)).toBe(2);
    expect(workspaceFolderChipCount({}, project)).toBe(1);
    expect(workspaceFolderChipCount(null, project)).toBe(4);
  });
  it("excludes missing and shared folders from repository actions and leases", () => {
    const missing = {
      ...project,
      folders: project.folders?.map((folder) =>
        folder.label === "web"
          ? {
              ...folder,
              availability: "unavailable" as const,
              unavailableReason: "missing" as const,
            }
          : folder,
      ),
    };
    expect(
      availableWorkspaceGitCheckouts(missing, thread, workspaceFolderRows(missing, thread)).map(
        (checkout) => checkout.cwd,
      ),
    ).toEqual(["/repo/api"]);
  });
  it("uses the server's checkout-root fallback when the first folder is missing", () => {
    const sharedCheckout = {
      ...project,
      folders: project.folders?.map((folder) =>
        folder.label === "api"
          ? {
              ...folder,
              availability: "unavailable" as const,
              unavailableReason: "missing" as const,
            }
          : folder.label === "web"
            ? { ...folder, vcs: { checkoutRoot: "/repo" } }
            : folder,
      ),
    };
    const bound = {
      ...thread,
      workspaceFolders: thread.workspaceFolders.map((folder) =>
        folder.label === "api" || folder.label === "web"
          ? { ...folder, checkoutRoot: "/repo" }
          : folder,
      ),
    };
    expect(
      availableWorkspaceGitCheckouts(
        sharedCheckout,
        bound,
        workspaceFolderRows(sharedCheckout, bound),
      ),
    ).toMatchObject([{ root: "/repo", cwd: "/repo", label: "api" }]);
  });
});
