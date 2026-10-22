import { CommandId, ProjectId, ProjectMutationError, type Project } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveMobileAddProjectTarget,
  workspaceFileActionError,
  workspaceFileErrorMessage,
  workspaceFileMutationOutcome,
} from "./workspace-file-projects";

const projectId = ProjectId.make("project:existing");
const conflict = new ProjectMutationError({
  commandId: CommandId.make("command:import"),
  message: "Failed to mutate project",
  diagnostic: { code: "conflict", message: "File already linked" },
  conflictingProjectId: projectId,
});

describe("mobile add-project target", () => {
  it("keeps missing-parent file paths on import even with a trailing separator", () => {
    expect(
      resolveMobileAddProjectTarget({
        path: "/missing/team.code-workspace/",
        platform: "Linux",
        workspaceFileProjects: true,
        browse: null,
      }).kind,
    ).toBe("workspace-file");
  });
  it("preserves directory creation when a parent has not been created yet", () => {
    expect(
      resolveMobileAddProjectTarget({
        path: "/missing/new-project",
        platform: "Linux",
        workspaceFileProjects: false,
        browse: null,
      }),
    ).toEqual({ kind: "directory", path: "/missing/new-project" });
  });
  it("keeps a workspace-named directory plain and preserves the server spelling on Windows", () => {
    expect(
      resolveMobileAddProjectTarget({
        path: "C:/work/TEAM.CODE-WORKSPACE",
        platform: "Win32",
        workspaceFileProjects: true,
        browse: {
          parentPath: "C:/work",
          entries: [
            {
              name: "team.code-workspace",
              fullPath: "C:/work/team.code-workspace",
              kind: "directory",
            },
          ],
        },
      }),
    ).toEqual({ kind: "directory", path: "C:/work/team.code-workspace" });
  });
  it("selects a server file entry without appending a slash", () => {
    expect(
      resolveMobileAddProjectTarget({
        path: "/work/team.code-workspace",
        platform: "Linux",
        workspaceFileProjects: true,
        browse: {
          parentPath: "/work",
          entries: [
            {
              name: "team.code-workspace",
              fullPath: "/work/team.code-workspace",
              kind: "workspace-file",
            },
          ],
        },
      }),
    ).toEqual({ kind: "workspace-file", path: "/work/team.code-workspace" });
  });
  it("sends a missing file with a case-insensitive suffix to import rather than directory creation", () => {
    expect(
      resolveMobileAddProjectTarget({
        path: "/work/missing.CODE-WORKSPACE",
        platform: "Linux",
        workspaceFileProjects: true,
        browse: { parentPath: "/work", entries: [] },
      }).kind,
    ).toBe("workspace-file");
  });
  it("keeps an authoritatively browsed trailing-separator directory plain", () => {
    expect(
      resolveMobileAddProjectTarget({
        path: "/work/team.code-workspace/",
        platform: "Linux",
        workspaceFileProjects: true,
        browse: { parentPath: "/work/team.code-workspace", entries: [] },
      }).kind,
    ).toBe("directory");
  });
  it("treats old-server entries with no kind as directories", () => {
    expect(
      resolveMobileAddProjectTarget({
        path: "/work/team.code-workspace",
        platform: "Linux",
        workspaceFileProjects: false,
        browse: {
          parentPath: "/work",
          entries: [{ name: "team.code-workspace", fullPath: "/work/team.code-workspace" }],
        },
      }).kind,
    ).toBe("directory");
  });
  it("fails closed for file mode when the capability is absent", () => {
    expect(() =>
      resolveMobileAddProjectTarget({
        path: "/work/team.code-workspace",
        platform: "Linux",
        workspaceFileProjects: false,
        browse: { parentPath: "/work", entries: [] },
      }),
    ).toThrow("not enabled");
  });
  it("does not use a differently cased Linux directory as an exact match", () => {
    expect(
      resolveMobileAddProjectTarget({
        path: "/work/TEAM.code-workspace",
        platform: "Linux",
        workspaceFileProjects: true,
        browse: {
          parentPath: "/work",
          entries: [
            {
              name: "team.code-workspace",
              fullPath: "/work/team.code-workspace",
              kind: "directory",
            },
          ],
        },
      }).kind,
    ).toBe("workspace-file");
  });
});

describe("workspace-file mutation outcomes", () => {
  it("completes successful workspace actions without an error", async () => {
    await expect(workspaceFileActionError(async () => {})).resolves.toBeNull();
  });

  it("preserves diagnostics for synchronous and asynchronous action failures", async () => {
    const error = new ProjectMutationError({
      commandId: CommandId.make("command:invalid"),
      message: "Failed to mutate project",
      diagnostic: {
        code: "malformed-jsonc",
        message: "Expected a closing brace",
        line: 4,
        column: 2,
      },
    });
    await expect(
      workspaceFileActionError(() => {
        throw error;
      }),
    ).resolves.toBe("Expected a closing brace (line 4, column 2)");
    await expect(workspaceFileActionError(() => Promise.reject(error))).resolves.toBe(
      "Expected a closing brace (line 4, column 2)",
    );
  });

  it("uses the server-derived title and folder definition", () => {
    const project: Project = {
      id: projectId,
      title: "Server title",
      workspaceRoot: "/work/api",
      workspaceFile: "/work/team.code-workspace",
      folders: [{ path: "/work/api", name: "API", label: "API", availability: "available" }],
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T00:00:00.000Z",
      deletedAt: null,
    };
    expect(workspaceFileMutationOutcome(AsyncResult.success(project), true)).toEqual({
      project,
      projectId,
    });
  });
  it("opens the existing project only for duplicate file imports", () => {
    expect(workspaceFileMutationOutcome(AsyncResult.failure(Cause.fail(conflict)), true)).toEqual({
      project: null,
      projectId,
    });
    expect(() =>
      workspaceFileMutationOutcome(AsyncResult.failure(Cause.fail(conflict)), false),
    ).toThrow(conflict);
  });
  it("does not redirect unlink's root conflict to another project", () => {
    const error = new ProjectMutationError({
      commandId: CommandId.make("command:unlink"),
      message: "Plain project owns the root",
      conflictingProjectId: projectId,
    });
    expect(() =>
      workspaceFileMutationOutcome(AsyncResult.failure(Cause.fail(error)), false),
    ).toThrow(error);
  });
  it("keeps validation diagnostics and their syntax locations", () => {
    const error = new ProjectMutationError({
      commandId: CommandId.make("command:invalid"),
      message: "Failed to mutate project",
      diagnostic: {
        code: "malformed-jsonc",
        message: "Expected a closing brace",
        line: 4,
        column: 2,
      },
    });
    expect(workspaceFileErrorMessage(error)).toBe("Expected a closing brace (line 4, column 2)");
    expect(() =>
      workspaceFileMutationOutcome(AsyncResult.failure(Cause.fail(error)), true),
    ).toThrow(error);
  });
  it("reports interrupted operations without treating them as a duplicate", () => {
    expect(() =>
      workspaceFileMutationOutcome(AsyncResult.failure(Cause.interrupt()), true),
    ).toThrow("interrupted");
  });
});
