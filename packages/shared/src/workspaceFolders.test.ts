import { describe, expect, it } from "vite-plus/test";

import {
  allocateFolderLabels,
  isPathWithin,
  projectFolders,
  resolveThreadWorkspace,
  threadPrimaryPath,
} from "./workspaceFolders.ts";

const labels = (entries: Parameters<typeof allocateFolderLabels>[0]) =>
  allocateFolderLabels(entries).map((folder) => folder.label);

describe("allocateFolderLabels", () => {
  it("lets every folder keep its preferred label before repeats take a suffix", () => {
    expect(
      labels([
        { path: "/srv/one/app", name: "app" },
        { path: "/srv/two/app", name: "app" },
        { path: "/srv/app-2", name: "app-2" },
      ]),
    ).toEqual(["app", "app-3", "app-2"]);
  });

  it("compares labels case-insensitively and keeps each folder's own casing", () => {
    expect(
      labels([
        { path: "C:\\work\\App", name: "App" },
        { path: "D:\\work\\app", name: "app" },
        { path: "E:\\work\\APP-2", name: "APP-2" },
      ]),
    ).toEqual(["App", "app-3", "APP-2"]);
  });

  it("makes names one path segment, so sanitized names collide like plain ones", () => {
    expect(
      labels([
        { path: "/srv/a", name: "web/api" },
        { path: "/srv/b", name: "web:api" },
        { path: "/srv/c", name: "tab\there" },
      ]),
    ).toEqual(["web-api", "web-api-2", "tab-here"]);
  });

  it("falls back to the basename, then to folder, when a name is not a usable segment", () => {
    expect(
      labels([
        { path: "C:\\work\\api\\", name: ".." },
        { uri: "vscode-remote://ssh-remote+devbox/srv/docs", name: "." },
        { path: "/", name: "." },
      ]),
    ).toEqual(["api", "docs", "folder"]);
  });

  it("reserves labels for remote folders too, so availability never renumbers", () => {
    const folders = [
      { uri: "vscode-remote://ssh-remote+devbox/srv/api", name: "api" },
      { path: "/srv/api", name: "api" },
    ];
    expect(labels(folders)).toEqual(["api", "api-2"]);
    expect(allocateFolderLabels(folders)[0]).toEqual({ ...folders[0], label: "api" });
  });
});

describe("projectFolders", () => {
  it("gives a plain project one folder at its workspace root", () => {
    expect(projectFolders({ workspaceRoot: "C:\\work\\T3 Code" })).toEqual([
      { path: "C:\\work\\T3 Code", name: "T3 Code", label: "T3 Code" },
    ]);
  });

  it("keeps the labels a linked project is served with and labels stored entries", () => {
    const served = [
      { path: "/srv/app", name: "app", label: "app" },
      { path: "/srv/other/app", name: "app", label: "app-2" },
    ];
    expect(projectFolders({ workspaceRoot: "/srv/app", folders: served })).toBe(served);
    expect(
      projectFolders({
        workspaceRoot: "/srv/app",
        folders: [
          { path: "/srv/app", name: "app" },
          { path: "/srv/other/app", name: "app" },
        ],
      }).map((folder) => folder.label),
    ).toEqual(["app", "app-2"]);
  });
});

const project = { workspaceRoot: "/repo/web" };
const snapshotFolders = [
  { path: "/repo/web", name: "web", label: "web", checkoutRoot: "/repo" },
  { path: "/repo/lib/vendor", name: "vendor", label: "vendor", checkoutRoot: "/repo/lib/vendor" },
  { path: "/repo/lib", name: "lib", label: "lib", checkoutRoot: "/repo" },
  { path: "/notes", name: "notes", label: "notes", checkoutRoot: null },
  { uri: "vscode-remote://ssh-remote+devbox/srv/api", name: "api", label: "api" },
];
const worktrees = [
  { repositoryRoot: "/repo", path: "/wt/s/repo", branch: "t3code/feature" },
  { repositoryRoot: "/repo/lib/vendor", path: "/wt/s/repo/lib/vendor", branch: "t3code/feature" },
];

describe("threadPrimaryPath", () => {
  it("is worktreePath ?? workspaceRoot for a thread without a snapshot", () => {
    expect(threadPrimaryPath({ worktreePath: null }, project)).toBe("/repo/web");
    expect(threadPrimaryPath({ worktreePath: "/wt/feature" }, project)).toBe("/wt/feature");
    expect(threadPrimaryPath({ worktreePath: "/wt/feature" }, undefined)).toBe("/wt/feature");
    expect(threadPrimaryPath({ worktreePath: null }, null)).toBeNull();
  });

  it("keeps a snapshot thread at its own primary after the project's primary moves", () => {
    expect(
      threadPrimaryPath(
        { worktreePath: null, workspaceFolders: snapshotFolders },
        { workspaceRoot: "/elsewhere" },
      ),
    ).toBe("/repo/web");
  });
});

describe("resolveThreadWorkspace", () => {
  it("returns exactly worktreePath ?? workspaceRoot, as one folder, without a snapshot", () => {
    for (const worktreePath of [null, "/wt/feature"]) {
      expect(resolveThreadWorkspace({ thread: { worktreePath }, project })).toEqual({
        primaryPath: worktreePath ?? "/repo/web",
        folders: [
          {
            folder: { path: "/repo/web", name: "web", label: "web" },
            label: "web",
            effectivePath: worktreePath ?? "/repo/web",
            isPrimary: true,
            checkoutRoot: undefined,
          },
        ],
      });
    }
  });

  it("maps each folder into the deepest set member containing it, else leaves it in place", () => {
    const workspace = resolveThreadWorkspace({
      thread: { worktreePath: "/wt/s/repo/web", workspaceFolders: snapshotFolders, worktrees },
      project,
    });
    expect(workspace.primaryPath).toBe("/wt/s/repo/web");
    expect(workspace.folders.map((folder) => [folder.label, folder.effectivePath])).toEqual([
      ["web", "/wt/s/repo/web"],
      ["vendor", "/wt/s/repo/lib/vendor"],
      ["lib", "/wt/s/repo/lib"],
      ["notes", "/notes"],
      ["api", null],
    ]);
    expect(workspace.folders.map((folder) => folder.isPrimary)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(workspace.folders[3]?.checkoutRoot).toBeNull();
  });

  it("leaves folders in place when only the primary has a worktree, and skips unavailable ones", () => {
    const workspace = resolveThreadWorkspace({
      thread: { worktreePath: "/wt/picked", workspaceFolders: snapshotFolders },
      project,
      unavailableFolderPaths: ["/notes"],
    });
    expect(workspace.folders.map((folder) => folder.effectivePath)).toEqual([
      "/wt/picked",
      "/repo/lib/vendor",
      "/repo/lib",
      null,
      null,
    ]);
  });

  it("matches Windows members case-insensitively and joins with backslashes", () => {
    const workspace = resolveThreadWorkspace({
      thread: {
        worktreePath: "D:\\wt\\s\\Repo",
        workspaceFolders: [
          { path: "C:\\Work\\Repo", name: "Repo", label: "Repo", checkoutRoot: "C:\\Work\\Repo" },
          {
            path: "c:/work/repo/Docs",
            name: "Docs",
            label: "Docs",
            checkoutRoot: "C:\\Work\\Repo",
          },
        ],
        worktrees: [{ repositoryRoot: "C:\\Work\\Repo", path: "D:\\wt\\s\\Repo", branch: "b" }],
      },
      project: { workspaceRoot: "C:\\Work\\Repo" },
    });
    expect(workspace.folders.map((folder) => folder.effectivePath)).toEqual([
      "D:\\wt\\s\\Repo",
      "D:\\wt\\s\\Repo\\Docs",
    ]);
  });
});

describe("isPathWithin", () => {
  it("compares whole segments, never across path kinds", () => {
    expect(isPathWithin("/repo", "/repo")).toBe(true);
    expect(isPathWithin("/repo", "/repo/web")).toBe(true);
    expect(isPathWithin("/repo", "/repository")).toBe(false);
    expect(isPathWithin("/", "/repo")).toBe(true);
    expect(isPathWithin("C:\\Repo", "c:/repo/web")).toBe(true);
    expect(isPathWithin("/Repo", "/repo")).toBe(false);
    expect(isPathWithin("/repo", "C:\\repo")).toBe(false);
  });
});
