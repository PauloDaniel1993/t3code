import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { workspaceFolderDiffTarget, workspaceFolderOwnsDiffPath } from "./workspaceFolderDiff";

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
});
