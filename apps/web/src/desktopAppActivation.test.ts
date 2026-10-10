import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectMutationError,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleDesktopAppActivationRequest,
  type DesktopAppActivationDependencies,
} from "./desktopAppActivation";

const environmentId = EnvironmentId.make("primary");
const existingProjectId = ProjectId.make("project-existing");
const createdProjectId = ProjectId.make("project-created");
const threadId = ThreadId.make("thread-1");
const request = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
} as const;

function dependencies(
  overrides: Partial<DesktopAppActivationDependencies> = {},
): DesktopAppActivationDependencies {
  return {
    getTarget: () => ({ environmentId, platform: "linux", workspaceFileProjects: true }),
    findWorkspaceFileProject: () => null,
    importWorkspaceFile: vi.fn(async () => createdProjectId),
    findProject: () => ({
      id: existingProjectId,
      environmentId,
      workspaceRoot: request.workspaceRoot,
    }),
    createProject: vi.fn(async () => createdProjectId),
    waitForProject: vi.fn(async () => undefined),
    openThread: vi.fn(async () => ({ threadId })),
    ...overrides,
  };
}

describe("desktop app activation", () => {
  const fileRequest = {
    version: 1,
    requestId: "file-request",
    type: "open-workspace-file",
    workspaceFilePath: "/workspace/team.code-workspace",
    platform: "linux",
  } as const;

  it("imports a file and waits for the project event before opening a thread", async () => {
    const order: string[] = [];
    const deps = dependencies({
      importWorkspaceFile: vi.fn(async () => {
        order.push("import");
        return createdProjectId;
      }),
      waitForProject: async () => {
        order.push("project-event");
      },
      openThread: async () => {
        order.push("thread");
        return { threadId };
      },
    });
    expect(await handleDesktopAppActivationRequest(fileRequest, deps)).toMatchObject({
      ok: true,
      projectId: createdProjectId,
    });
    expect(order).toEqual(["import", "project-event", "thread"]);
    expect(deps.createProject).not.toHaveBeenCalled();
  });

  it("reuses the project linked to the file", async () => {
    const deps = dependencies({
      findWorkspaceFileProject: () => ({
        id: existingProjectId,
        environmentId,
        workspaceRoot: request.workspaceRoot,
      }),
    });
    expect(await handleDesktopAppActivationRequest(fileRequest, deps)).toMatchObject({
      ok: true,
      projectId: existingProjectId,
    });
    expect(deps.importWorkspaceFile).not.toHaveBeenCalled();
  });

  it("returns an import diagnostic without falling through to folder creation", async () => {
    const deps = dependencies({
      importWorkspaceFile: async () => {
        throw new ProjectMutationError({
          commandId: CommandId.make("import"),
          message: "Workspace file not found.",
          diagnostic: { code: "file-not-found", message: "Workspace file not found." },
        });
      },
    });
    expect(await handleDesktopAppActivationRequest(fileRequest, deps)).toMatchObject({
      ok: false,
      code: "project-create-failed",
      message: "Workspace file not found.",
    });
    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  it("opens the conflicting project if another client imports the file first", async () => {
    const deps = dependencies({
      importWorkspaceFile: async () => {
        throw new ProjectMutationError({
          commandId: CommandId.make("import"),
          message: "Already linked",
          conflictingProjectId: existingProjectId,
        });
      },
    });
    expect(await handleDesktopAppActivationRequest(fileRequest, deps)).toMatchObject({
      ok: true,
      projectId: existingProjectId,
    });
    expect(deps.waitForProject).toHaveBeenCalledWith({
      environmentId,
      projectId: existingProjectId,
    });
  });

  it("fails closed when workspace file projects are disabled", async () => {
    const deps = dependencies({ getTarget: () => ({ environmentId, platform: "linux" }) });
    expect(await handleDesktopAppActivationRequest(fileRequest, deps)).toMatchObject({
      ok: false,
      code: "project-create-failed",
    });
    expect(deps.importWorkspaceFile).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
  });
  it("reuses an existing project and opens a new thread", async () => {
    const deps = dependencies();

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).toHaveBeenCalledWith({ environmentId, projectId: existingProjectId });
    expect(response).toEqual({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: existingProjectId,
      threadId,
    });
  });

  it("waits for a created project before it opens the thread", async () => {
    const order: string[] = [];
    const deps = dependencies({
      findProject: () => null,
      createProject: vi.fn(async () => {
        order.push("create");
        return createdProjectId;
      }),
      waitForProject: vi.fn(async () => {
        order.push("project-event");
      }),
      openThread: vi.fn(async () => {
        order.push("open-thread");
        return { threadId };
      }),
    });

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(order).toEqual(["create", "project-event", "open-thread"]);
    expect(response).toMatchObject({ ok: true, projectId: createdProjectId });
  });

  it("rejects a Windows path when the primary environment is WSL", async () => {
    const response = await handleDesktopAppActivationRequest(
      { ...request, platform: "win32" },
      dependencies({ getTarget: () => ({ environmentId, platform: "linux" }) }),
    );

    expect(response).toMatchObject({ ok: false, code: "platform-mismatch" });
  });

  it("returns a project error without opening a thread", async () => {
    const openThread = vi.fn(async () => ({ threadId }));
    const response = await handleDesktopAppActivationRequest(
      request,
      dependencies({
        findProject: () => null,
        createProject: vi.fn(async () => {
          throw new Error("Project path is not available.");
        }),
        openThread,
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      code: "project-create-failed",
      message: "Project path is not available.",
    });
    expect(openThread).not.toHaveBeenCalled();
  });
});
