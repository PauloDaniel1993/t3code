import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { workspaceFolderDiffTarget, workspaceFolderOwnsDiffPath } from "./workspaceFolderDiff";
import { resolveDiffPathForWorkspace } from "./diffFileActions";

const project = {
  id: ProjectId.make("project"),
  workspaceRoot: "/repo/app",
  folders: [
    { name: "App", label: "app", path: "/repo/app", vcs: { checkoutRoot: "/repo" } },
    { name: "Nested", label: "nested", path: "/repo/app/nested", vcs: { checkoutRoot: "/repo" } },
    { name: "API", label: "api", path: "/api", vcs: { checkoutRoot: "/api" } },
  ],
};
const thread = {
  worktreePath: "/set/app",
  workspaceFolders: project.folders.map((folder) => ({
    ...folder,
    checkoutRoot: folder.vcs.checkoutRoot,
    checkoutPrefix: folder.path === "/api" ? "" : folder.path.slice("/repo/".length),
  })),
  worktrees: [
    { repositoryRoot: "/repo", path: "/set", branch: "feature" },
    { repositoryRoot: "/api", path: "/set-api", branch: "feature" },
  ],
};

describe("workspace folder diff scope", () => {
  it("pins a secondary folder to its mapped repository and excludes other files", () => {
    const target = workspaceFolderDiffTarget(project, thread, "/api")!;
    expect(target.cwd).toBe("/set-api");
    expect(target.repositoryRoot).toBe("/set-api");
    expect(workspaceFolderOwnsDiffPath(target, "src/server.ts")).toBe(true);
  });

  it("narrows nested folder changes and lets the deepest folder own overlaps", () => {
    const parent = workspaceFolderDiffTarget(project, thread, "/repo/app")!;
    const nested = workspaceFolderDiffTarget(project, thread, "/repo/app/nested")!;
    expect(workspaceFolderOwnsDiffPath(parent, "app/main.ts")).toBe(true);
    expect(workspaceFolderOwnsDiffPath(parent, "outside.ts")).toBe(false);
    expect(workspaceFolderOwnsDiffPath(parent, "app/nested/index.ts")).toBe(false);
    expect(workspaceFolderOwnsDiffPath(nested, "app/nested/index.ts")).toBe(true);
    expect(workspaceFolderOwnsDiffPath(nested, "../index.ts")).toBe(false);
  });

  it("never substitutes the primary when a selected folder is missing or unavailable", () => {
    expect(workspaceFolderDiffTarget(project, thread, "/unknown")).toBeNull();
    expect(
      workspaceFolderDiffTarget(
        { ...project, folders: project.folders.slice(0, 1) },
        thread,
        "/api",
        ["/api"],
      ),
    ).toBeNull();
    expect(
      workspaceFolderDiffTarget(
        {
          ...project,
          folders: project.folders.map((folder) => ({
            ...folder,
            availability: "unavailable" as const,
          })),
        },
        thread,
        "/api",
      ),
    ).toBeNull();
  });

  it("compares symlinked folders in checkout space and opens paths relative to the folder", () => {
    const linked = {
      worktreePath: null,
      workspaceFolders: [
        {
          name: "Web",
          label: "web",
          path: "/link/web",
          checkoutRoot: "/real/repo",
          checkoutPrefix: "apps/web",
        },
      ],
    };
    const target = workspaceFolderDiffTarget(project, linked, "/link/web")!;
    expect(target.cwd).toBe("/link/web");
    expect(target.workspaceRoot).toBe("/real/repo/apps/web");
    expect(workspaceFolderOwnsDiffPath(target, "apps/web/main.ts")).toBe(true);
    expect(workspaceFolderOwnsDiffPath(target, "apps/api/main.ts")).toBe(false);
    expect(
      resolveDiffPathForWorkspace({
        filePath: "apps/web/main.ts",
        workspaceRoot: target.workspaceRoot,
        repositoryRoot: target.repositoryRoot,
      }),
    ).toBe("main.ts");
  });

  it("preserves unavailable nested ownership in both current checkouts and worktrees", () => {
    const unavailableNested = {
      ...project,
      folders: project.folders.map((folder) =>
        folder.label === "nested" ? { ...folder, availability: "unavailable" as const } : folder,
      ),
    };
    for (const bound of [thread, { ...thread, worktreePath: null, worktrees: [] }]) {
      const parent = workspaceFolderDiffTarget(unavailableNested, bound, "/repo/app")!;
      expect(workspaceFolderOwnsDiffPath(parent, "app/main.ts")).toBe(true);
      expect(workspaceFolderOwnsDiffPath(parent, "app/nested/deleted.ts")).toBe(false);
      expect(workspaceFolderDiffTarget(unavailableNested, bound, "/repo/app/nested")).toBeNull();
    }
  });
});
