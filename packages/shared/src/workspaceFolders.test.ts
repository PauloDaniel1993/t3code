import { describe, expect, it } from "vite-plus/test";

import {
  allocateFolderLabels,
  isPathWithin,
  isSamePath,
  orphanedThreadWorktreePaths,
  projectFolders,
  relativePathWithin,
  resolveThreadWorkspace,
  threadUsingWorktrees,
  threadPrimaryPath,
  worktreeSetPath,
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

  it("reads a shell's snapshot primary, which has no folder list", () => {
    expect(
      threadPrimaryPath(
        { worktreePath: null, workspacePrimaryPath: "/repo/web" },
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

describe("worktreeSetPath", () => {
  it("leaves a folder that already lies in a member's worktree where it is", () => {
    // A worktree kept inside its own repository, bound before the project was linked.
    const members = [{ repositoryRoot: "/repo", path: "/repo/.worktrees/feature", branch: "b" }];
    expect(worktreeSetPath("/repo/.worktrees/feature/web", members)).toBe(
      "/repo/.worktrees/feature/web",
    );
    expect(worktreeSetPath("/repo/web", members)).toBe("/repo/.worktrees/feature/web");
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

  it("never nests a relative path in an absolute one", () => {
    expect(isPathWithin("/repo", "repo/notes")).toBe(false);
    expect(isSamePath("/repo", "repo")).toBe(false);
  });

  it("treats a backslash as part of a POSIX name", () => {
    expect(isPathWithin("/repo", "/repo\\notes")).toBe(false);
    expect(isSamePath("/repo/", "/repo")).toBe(true);
    expect(isSamePath("C:\\Repo\\", "c:/repo")).toBe(true);
    expect(isSamePath("/repo/web", "/repo")).toBe(false);
  });
});

describe("relativePathWithin", () => {
  it("spells a path below a root with forward slashes", () => {
    expect(relativePathWithin("/repo", "/repo/web/src")).toBe("web/src");
    expect(relativePathWithin("/repo/", "/repo")).toBe("");
    expect(relativePathWithin("/repo", "/repository")).toBeNull();
    expect(relativePathWithin("C:\\Repo", "c:\\repo\\Web\\src")).toBe("Web/src");
  });
});

describe("orphanedThreadWorktreePaths", () => {
  const thread = (
    id: string,
    worktreePath: string | null,
    worktrees?: ReadonlyArray<{ readonly repositoryRoot: string; readonly path: string }>,
  ) => ({
    id,
    worktreePath,
    ...(worktrees === undefined
      ? {}
      : { worktrees: worktrees.map((member) => ({ ...member, branch: "feature" })) }),
  });
  const set = [
    { repositoryRoot: "/repos/web", path: "/worktrees/s" },
    { repositoryRoot: "/repos/api", path: "/worktrees/s/api" },
  ];

  it("names a plain thread's one worktree, and nothing without one or for an unknown thread", () => {
    expect(orphanedThreadWorktreePaths([thread("a", "/worktrees/a")], "a")).toEqual([
      "/worktrees/a",
    ]);
    expect(orphanedThreadWorktreePaths([thread("a", null)], "a")).toEqual([]);
    expect(orphanedThreadWorktreePaths([], "a")).toEqual([]);
  });

  it("names every member of a set", () => {
    expect(orphanedThreadWorktreePaths([thread("a", "/worktrees/s/web", set)], "a")).toEqual([
      "/worktrees/s",
      "/worktrees/s/api",
    ]);
  });

  it("names nothing while another thread works inside any member", () => {
    const threads = [
      thread("a", "/worktrees/s/web", set),
      // Picked only the nested member's worktree in the branch picker.
      thread("b", "/worktrees/s/api/src"),
    ];
    expect(orphanedThreadWorktreePaths(threads, "a")).toEqual([]);
    expect(
      orphanedThreadWorktreePaths(
        [thread("a", "C:\\Worktrees\\a"), thread("b", "c:/worktrees/a")],
        "a",
      ),
    ).toEqual([]);
  });

  it("names the other thread that blocks removal", () => {
    const threads = [thread("a", "/worktrees/s/web", set), thread("b", "/worktrees/s/api")];
    expect(threadUsingWorktrees(threads, "a", ["/worktrees/s"])?.id).toBe("b");
    expect(threadUsingWorktrees(threads, "b", ["/worktrees/s/api"])?.id).toBe("a");
    expect(threadUsingWorktrees(threads, "a", ["/worktrees/other"])).toBeUndefined();
  });

  it("ignores threads in other worktrees and in the source checkout", () => {
    const threads = [
      thread("a", "/worktrees/s/web", set),
      thread("b", "/worktrees/s-2"),
      thread("c", null),
      thread("d", "/repos/web"),
    ];
    expect(orphanedThreadWorktreePaths(threads, "a")).toEqual(["/worktrees/s", "/worktrees/s/api"]);
  });
});
