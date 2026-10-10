import { ProjectMutationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type {
  DesktopAppActivationFailure,
  DesktopAppActivationRequest,
  DesktopAppActivationResponse,
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ProjectId,
  ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";

export interface DesktopAppActivationProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

const isProjectMutationError = Schema.is(ProjectMutationError);

export interface DesktopAppActivationTarget {
  readonly environmentId: EnvironmentId;
  readonly platform: ExecutionEnvironmentPlatformOs;
  readonly workspaceFileProjects?: boolean;
}

export interface DesktopAppActivationDependencies {
  readonly getTarget: () => DesktopAppActivationTarget | null;
  readonly findProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => DesktopAppActivationProject | null;
  readonly createProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => Promise<ProjectId>;
  readonly findWorkspaceFileProject: (
    environmentId: EnvironmentId,
    workspaceFilePath: string,
  ) => DesktopAppActivationProject | null;
  readonly importWorkspaceFile: (
    environmentId: EnvironmentId,
    workspaceFilePath: string,
  ) => Promise<ProjectId>;
  readonly waitForProject: (projectRef: ScopedProjectRef) => Promise<void>;
  readonly openThread: (
    projectRef: ScopedProjectRef,
  ) => Promise<{ readonly threadId: ThreadId } | null>;
}

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return { version: 1, requestId, ok: false, code, message };
}

function desktopPlatformToEnvironmentOs(
  platform: DesktopAppActivationRequest["platform"],
): ExecutionEnvironmentPlatformOs {
  return platform === "win32" ? "windows" : platform;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export async function handleDesktopAppActivationRequest(
  request: DesktopAppActivationRequest,
  dependencies: DesktopAppActivationDependencies,
): Promise<DesktopAppActivationResponse> {
  const target = dependencies.getTarget();
  if (target === null) {
    return failure(
      request.requestId,
      "environment-unavailable",
      "The desktop app's primary local environment is not connected.",
    );
  }

  const requestPlatform = desktopPlatformToEnvironmentOs(request.platform);
  if (requestPlatform !== target.platform) {
    return failure(
      request.requestId,
      "platform-mismatch",
      `The command path is for ${requestPlatform}, but the desktop app's primary environment uses ${target.platform}. Cross-platform path mapping is not supported.`,
    );
  }

  const fileRequest = request.type === "open-workspace-file";
  if (fileRequest && target.workspaceFileProjects !== true) {
    return failure(
      request.requestId,
      "project-create-failed",
      "Workspace file projects are disabled in this environment.",
    );
  }
  let projectId =
    request.type === "open-workspace-file"
      ? (dependencies.findWorkspaceFileProject(target.environmentId, request.workspaceFilePath)
          ?.id ?? null)
      : (dependencies.findProject(target.environmentId, request.workspaceRoot)?.id ?? null);
  if (projectId === null) {
    try {
      projectId =
        request.type === "open-workspace-file"
          ? await dependencies.importWorkspaceFile(target.environmentId, request.workspaceFilePath)
          : await dependencies.createProject(target.environmentId, request.workspaceRoot);
      await dependencies.waitForProject({ environmentId: target.environmentId, projectId });
    } catch (error) {
      if (
        fileRequest &&
        isProjectMutationError(error) &&
        error.conflictingProjectId !== undefined
      ) {
        projectId = error.conflictingProjectId;
        try {
          await dependencies.waitForProject({ environmentId: target.environmentId, projectId });
        } catch (waitError) {
          return failure(
            request.requestId,
            "project-create-failed",
            errorMessage(waitError, "T3 Code could not find the imported project."),
          );
        }
      } else {
        return failure(
          request.requestId,
          "project-create-failed",
          errorMessage(error, "T3 Code could not add the project."),
        );
      }
    }
  }

  try {
    const opened = await dependencies.openThread({
      environmentId: target.environmentId,
      projectId,
    });
    if (opened === null) {
      return failure(
        request.requestId,
        "thread-open-failed",
        "T3 Code could not open a new thread for the project.",
      );
    }
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId,
      threadId: opened.threadId,
    };
  } catch (error) {
    return failure(
      request.requestId,
      "thread-open-failed",
      errorMessage(error, "T3 Code could not open a new thread for the project."),
    );
  }
}
