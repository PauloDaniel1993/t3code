import { ProjectId } from "@t3tools/contracts";
import type { WorkspaceThread } from "@t3tools/shared/workspaceFolders";
import { describe, expect, it } from "vite-plus/test";
import {
  workspaceAvailabilityPending,
  workspaceFolderChipCount,
  workspaceFolderRows,
  workspaceRepositoryCount,
  workspaceSnapshotChanged,
  type WorkspaceFoldersProject,
} from "./workspaceFolders.logic";

const project: WorkspaceFoldersProject = {
  id: ProjectId.make("project"),
  workspaceRoot: "/repo/app",
  workspaceFile: "/repo/dev.code-workspace",
  folders: [
    {
      name: "App",
      label: "app",
      path: "/repo/app",
      availability: "available",
      vcs: { checkoutRoot: "/repo" },
    },
    {
      name: "API",
      label: "api",
      path: "/api",
      availability: "available",
      vcs: { checkoutRoot: "/api" },
    },
    { name: "Notes", label: "notes", path: "/notes", availability: "available", vcs: null },
    {
      name: "Archive",
      label: "archive",
      path: "/archive",
      availability: "unavailable",
      unavailableReason: "missing",
    },
    {
      name: "Remote",
      label: "remote",
      uri: "vscode-remote://ssh-remote+devbox/srv/app",
      availability: "unavailable",
      unavailableReason: "remote",
      remoteDescription: "SSH: devbox",
    },
  ],
};
const thread: WorkspaceThread = {
  worktreePath: "/sets/session/app",
  workspaceFolders: project.folders!.map((folder) => ({
    ...folder,
    checkoutRoot: folder.vcs === null ? null : folder.vcs?.checkoutRoot,
    ...(folder.path === "/repo/app" ? { checkoutPrefix: "app" } : { checkoutPrefix: "" }),
  })),
  worktrees: [
    { repositoryRoot: "/repo", path: "/sets/session", branch: "feature" },
    { repositoryRoot: "/api", path: "/sets/api", branch: "feature" },
  ],
};

describe("workspace folder presentation", () => {
  it("maps git folders into their worktrees and leaves shared folders in place", () => {
    const rows = workspaceFolderRows(project, thread);
    expect(rows.map((row) => row.effectivePath)).toEqual([
      "/sets/session/app",
      "/sets/api",
      "/notes",
      null,
      null,
    ]);
    expect(rows.filter((row) => row.isGit).map((row) => row.label)).toEqual(["app", "api"]);
    expect(rows[2]).toMatchObject({ checkoutRoot: null, isWorktree: false, unavailable: false });
    expect(rows[3]?.reason).toBe("Missing on disk");
    expect(rows[4]?.reason).toBe("Remote (SSH: devbox), not available here");
  });

  it("counts a checkout once when it contains several workspace folders", () => {
    const rows = workspaceFolderRows(
      {
        ...project,
        folders: [
          ...project.folders!,
          {
            name: "Tests",
            label: "tests",
            path: "/repo/tests",
            availability: "available",
            vcs: { checkoutRoot: "/repo" },
          },
        ],
      },
      null,
    );
    expect(workspaceRepositoryCount(rows)).toBe(2);
  });

  it("keeps frozen names, order and locations after rename, reorder and unlink", () => {
    const changed = {
      ...project,
      folders: project.folders!.toReversed().map((folder) => ({ ...folder, name: "Changed" })),
    };
    expect(workspaceFolderRows(changed, thread).map((row) => row.folder.name)).toEqual([
      "App",
      "API",
      "Notes",
      "Archive",
      "Remote",
    ]);
    expect(workspaceSnapshotChanged(changed, thread)).toBe(true);
    expect(
      workspaceSnapshotChanged({ ...project, folders: undefined, workspaceFile: null }, thread),
    ).toBe(true);
    expect(
      workspaceFolderRows({ ...project, folders: undefined, workspaceFile: null }, thread).map(
        (row) => row.folder.path,
      ),
    ).toEqual(thread.workspaceFolders?.map((folder) => folder.path));
  });

  it("does not call changing availability a changed folder definition", () => {
    expect(workspaceSnapshotChanged(project, thread)).toBe(false);
    const changed = {
      ...project,
      folders: project.folders!.map((folder) => ({
        ...folder,
        availability: "unavailable" as const,
      })),
    };
    expect(workspaceSnapshotChanged(changed, thread)).toBe(false);
    expect(workspaceFolderRows(changed, thread).some((row) => row.isGit)).toBe(false);
  });

  it("uses last-run unavailability for folders removed from the current project", () => {
    const rows = workspaceFolderRows(
      { ...project, folders: project.folders!.slice(0, 1) },
      thread,
      ["/api"],
    );
    expect(rows[1]).toMatchObject({ unavailable: true, effectivePath: null, isGit: false });
  });

  it("does not silently enroll a snapshot's non-git folder in checkpoints", () => {
    const changed = {
      ...project,
      folders: project.folders!.map((folder) =>
        folder.path === "/notes" ? { ...folder, vcs: { checkoutRoot: "/notes" } } : folder,
      ),
    };
    expect(workspaceFolderRows(changed, thread)[2]).toMatchObject({
      checkoutRoot: null,
      isGit: false,
    });
  });

  it("drafts use the current definition and bound shells use only their count", () => {
    expect(workspaceFolderChipCount(null, project)).toBe(5);
    expect(workspaceFolderChipCount({}, project)).toBe(1);
    expect(workspaceFolderChipCount({ workspaceFolderCount: 2 }, project)).toBe(2);
    expect(workspaceFolderRows(project, null).map((row) => row.effectivePath)).toEqual([
      "/repo/app",
      "/api",
      "/notes",
      null,
      null,
    ]);
  });

  it("shows pending adoption only when effective availability differs from installed access", () => {
    const rows = workspaceFolderRows(project, thread);
    expect(workspaceAvailabilityPending(rows, undefined)).toBe(false);
    expect(
      workspaceAvailabilityPending(rows, {
        cwd: "/sets/session/app",
        additionalDirectories: ["/sets/api", "/notes"],
      }),
    ).toBe(false);
    expect(
      workspaceAvailabilityPending(rows, {
        cwd: "/sets/session/app",
        additionalDirectories: ["/sets/api", "/notes", "/archive"],
      }),
    ).toBe(true);
    expect(
      workspaceAvailabilityPending(rows, {
        cwd: "/sets/session/app",
        additionalDirectories: ["/notes"],
      }),
    ).toBe(true);
  });

  it("uses Windows path identity when matching health and comparing snapshots", () => {
    const windows = {
      ...project,
      workspaceRoot: "C:\\repo",
      folders: [
        {
          name: "App",
          label: "app",
          path: "C:\\Repo",
          availability: "unavailable" as const,
          unavailableReason: "inaccessible" as const,
        },
      ],
    };
    const bound = {
      worktreePath: null,
      workspaceFolders: [{ name: "App", label: "app", path: "c:/repo", checkoutRoot: "C:\\repo" }],
    };
    expect(workspaceSnapshotChanged(windows, bound)).toBe(false);
    expect(workspaceFolderRows(windows, bound)[0]?.reason).toBe("Inaccessible");
  });
});
