import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveInlineCodeFileLinkMeta, resolveMarkdownFileLinkMeta } from "~/markdown-links";
import { workspaceFileContext, workspaceFileOpenReference } from "../files/workspaceFiles";
import { buildStartTicketsAsTasksPrompt } from "./StarMapPanel.logic";
import { buildStarMapTicketTaskDraft } from "./StarMapTicketDetail.logic";
import {
  selectedStarMapFolder,
  starMapFileTarget,
  starMapMarkdownContext,
  starMapTaskSourcePath,
} from "./StarMapSurface.logic";

const project = {
  id: ProjectId.make("wayfinder-folders"),
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
const threadId = ThreadId.make("map-thread");
const workspace = workspaceFileContext(project, thread, threadId, true)!;
const ticketPath = ".plan/effort/issues/01-fix.md";

describe("Wayfinder folder selection and sources", () => {
  it("starts at the primary mapped cwd and selects exactly one secondary cwd", () => {
    expect(selectedStarMapFolder(workspace, null)).toMatchObject({
      isPrimary: true,
      effectivePath: "/session/api",
    });
    expect(selectedStarMapFolder(workspace, "/source/ui")).toMatchObject({
      isPrimary: false,
      effectivePath: "/session/ui",
    });
    expect(selectedStarMapFolder(workspace, "/session/ui")?.isPrimary).toBe(true);
  });

  it("keeps a bound thread's folders and labels after reorder, relink, and unlink", () => {
    const changed = workspaceFileContext(
      { ...project, workspaceRoot: "/new", workspaceFile: null, folders: [] },
      thread,
      threadId,
      true,
    )!;
    expect(selectedStarMapFolder(changed, "/source/ui")).toEqual(workspace.folders[1]);
    expect(selectedStarMapFolder(changed, null)).toEqual(workspace.folders[0]);
  });

  it("returns removed draft choices to the primary and keeps unavailable choices explicit", () => {
    const draft = workspaceFileContext(
      { ...project, folders: [project.folders[0]!, project.folders[2]!] },
      null,
      undefined,
      true,
    )!;
    expect(selectedStarMapFolder(draft, "/source/ui")?.effectivePath).toBe("/source/api");
    expect(selectedStarMapFolder(draft, project.folders[2]!.uri!)).toMatchObject({
      label: "remote",
      effectivePath: null,
      isPrimary: false,
    });
    const unavailable = {
      ...workspace,
      folders: workspace.folders.map((folder) =>
        folder.isPrimary ? folder : { ...folder, effectivePath: null },
      ),
    };
    expect(selectedStarMapFolder(unavailable, "/source/ui")?.effectivePath).toBeNull();
  });

  it("opens same-named ticket files with their selected folder's canonical path and identity", () => {
    expect(starMapFileTarget(ticketPath, "/session/api", workspace)).toEqual({
      path: `api/${ticketPath}`,
      folderPath: "/source/api",
    });
    expect(starMapFileTarget(ticketPath, "/session/ui", workspace)).toEqual({
      path: `ui/${ticketPath}`,
      folderPath: "/source/ui",
    });
    expect(starMapFileTarget(ticketPath, "/outside", workspace)).toBeNull();
  });

  it("opens secondary ticket body links in their owning folder through the primary Files panel", () => {
    const markdown = starMapMarkdownContext("/session/ui", workspace);
    for (const resolve of [resolveMarkdownFileLinkMeta, resolveInlineCodeFileLinkMeta]) {
      const link = resolve("src/index.ts:12", markdown.cwd, markdown.imageBaseDir)!;
      expect(link.line).toBe(12);
      expect(
        workspaceFileOpenReference(
          workspace,
          link.workspaceRelativePath ?? link.filePath,
          markdown.cwd,
        ),
      ).toMatchObject({
        canonicalPath: "ui/src/index.ts",
        folderPath: "/source/ui",
        absolutePath: "/session/ui/src/index.ts",
      });
    }
    expect(starMapMarkdownContext("/plain", undefined)).toEqual({
      cwd: "/plain",
      imageBaseDir: "/plain",
    });
  });

  it("addresses both bulk and single-ticket tasks in the secondary mapped folder", () => {
    const source = starMapTaskSourcePath(ticketPath, "/session/ui", workspace);
    expect(source).toBe(`/session/ui/${ticketPath}`);
    const node = { ordinal: 1, label: "Fix", relativePath: source };
    const bulk = buildStartTicketsAsTasksPrompt(
      {
        title: "Effort",
        mapRelativePath: starMapTaskSourcePath(".plan/effort/map.md", "/session/ui", workspace),
      },
      [node],
    );
    expect(bulk).toContain("`/session/ui/.plan/effort/map.md`");
    expect(bulk).toContain(`\`${source}\``);
    const single = buildStarMapTicketTaskDraft({ node, contents: null, truncated: false });
    expect(single.prompt).toContain(`Source: \`${source}\``);
    expect(single.prompt).toContain(`Read the full ticket at \`${source}\``);
    expect(starMapTaskSourcePath(ticketPath, "/session/api", workspace)).toBe(ticketPath);
  });

  it("rebases primary-owned task sources when the selected folder contains the primary", () => {
    const overlapping = workspaceFileContext(
      {
        ...project,
        workspaceRoot: "/repo/.plan",
        folders: [
          { path: "/repo/.plan", name: "plans", label: "plans" },
          { path: "/repo", name: "repo", label: "repo" },
        ],
      },
      null,
      undefined,
      true,
    )!;
    expect(starMapTaskSourcePath(".plan/effort/map.md", "/repo", overlapping)).toBe(
      "effort/map.md",
    );
    expect(starMapTaskSourcePath(ticketPath, "/repo", overlapping)).toBe("effort/issues/01-fix.md");
    expect(starMapFileTarget(ticketPath, "/repo", overlapping)).toEqual({
      path: "plans/effort/issues/01-fix.md",
      folderPath: "/repo/.plan",
    });
  });

  it("preserves plain and single-folder paths, including label-looking directories", () => {
    const path = `api/${ticketPath}`;
    expect(selectedStarMapFolder(undefined, null)).toBeUndefined();
    expect(starMapFileTarget(path, "/plain", undefined)).toEqual({ path, folderPath: undefined });
    expect(starMapTaskSourcePath(path, "/plain", undefined)).toBe(path);
    const single = workspaceFileContext(
      project,
      { worktreePath: "/session/api", workspaceFolders: [project.folders[0]!] },
      threadId,
      true,
    )!;
    expect(starMapFileTarget(path, "/session/api", single)).toEqual({
      path,
      folderPath: "/source/api",
    });
    expect(starMapTaskSourcePath(path, "/session/api", single)).toBe(path);
  });

  it("uses mapped Windows paths for secondary tasks and pins the original identity", () => {
    const windows = workspaceFileContext(
      {
        ...project,
        workspaceRoot: "C:/api",
        folders: [
          { path: "C:/api", name: "api", label: "api" },
          { path: "C:/ui", name: "ui", label: "ui" },
        ],
      },
      {
        worktreePath: "D:/session/api",
        workspaceFolders: [
          { path: "C:/api", name: "api", label: "api" },
          { path: "C:/ui", name: "ui", label: "ui" },
        ],
        worktrees: [{ repositoryRoot: "C:/ui", path: "D:/session/ui", branch: "feature" }],
      },
      threadId,
      true,
    )!;
    expect(starMapTaskSourcePath(ticketPath, "D:/session/ui", windows)).toBe(
      `D:/session/ui\\${ticketPath.replaceAll("/", "\\")}`,
    );
    expect(starMapFileTarget(ticketPath, "D:/session/ui", windows)).toEqual({
      path: `ui/${ticketPath}`,
      folderPath: "C:/ui",
    });
  });
});
