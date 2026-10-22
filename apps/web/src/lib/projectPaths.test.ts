import { describe, expect, it } from "vite-plus/test";

import { findProjectByPath, findProjectByWorkspaceFile } from "./projectPaths";
import { appendBrowsePathSegment } from "@t3tools/client-runtime/state/projects";

describe("projectPaths", () => {
  it("keeps workspace-file selections free of trailing separators", () => {
    expect(appendBrowsePathSegment("/repo/", "team.code-workspace", "workspace-file")).toBe(
      "/repo/team.code-workspace",
    );
    expect(appendBrowsePathSegment("C:\\Work\\", "team.code-workspace", "workspace-file")).toBe(
      "C:\\Work\\team.code-workspace",
    );
  });

  it("matches workspace file identity for drive paths and UNC without changing POSIX case", () => {
    const drive = { id: "drive", workspaceFile: "C:/Team Space/team.code-workspace" };
    const unc = { id: "unc", workspaceFile: "\\\\server\\share\\Team Space\\team.code-workspace" };
    const posix = { id: "posix", workspaceFile: "/work/Team.code-workspace" };
    const projects = [drive, unc, posix, { id: "plain", workspaceFile: null }];
    expect(findProjectByWorkspaceFile(projects, "c:\\team space\\TEAM.CODE-WORKSPACE")).toBe(drive);
    expect(
      findProjectByWorkspaceFile(projects, "\\\\SERVER\\SHARE\\team space\\team.code-workspace"),
    ).toBe(unc);
    expect(findProjectByWorkspaceFile(projects, "/work/team.code-workspace")).toBeUndefined();
    expect(findProjectByWorkspaceFile(projects, " ")).toBeUndefined();
  });

  it("folder activation selects the plain project when a linked project shares its primary", () => {
    const linked = {
      id: "linked",
      workspaceRoot: "C:/Work/Repo",
      workspaceFile: "C:/team.code-workspace",
    };
    const plain = { id: "plain", workspaceRoot: "C:/Work/Repo", workspaceFile: null };
    expect(findProjectByPath([linked, plain], "c:\\work\\repo")).toBe(plain);
    expect(findProjectByPath([linked], "C:/Work/Repo")).toBeUndefined();
  });

  it("finds existing projects even when the input formatting differs", () => {
    const existing = findProjectByPath(
      [
        { id: "project-1", cwd: "/repo/app" },
        { id: "project-2", cwd: "C:\\Work\\Repo" },
      ],
      "C:/Work/Repo/",
    );

    expect(existing?.id).toBe("project-2");
  });
});
