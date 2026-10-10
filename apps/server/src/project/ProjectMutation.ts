import {
  type ProjectId,
  type ProjectMutation,
  type WorkspaceFileDiagnostic,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { type ProjectService, type ProjectServiceError } from "./ProjectService.ts";

type ProjectMutations = Pick<
  ProjectService["Service"],
  "create" | "delete" | "importWorkspaceFile" | "update"
>;

export const projectMutationOperation = Effect.fn("projectMutationOperation")(function* (
  projects: ProjectMutations,
  mutation: ProjectMutation,
) {
  switch (mutation.type) {
    case "project.create":
      return yield* projects.create({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        title: mutation.title,
        workspaceRoot: mutation.workspaceRoot,
        ...(mutation.createWorkspaceRootIfMissing === undefined
          ? {}
          : { createWorkspaceRootIfMissing: mutation.createWorkspaceRootIfMissing }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });

    case "project.import-workspace-file":
      return yield* projects.importWorkspaceFile({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        workspaceFilePath: mutation.workspaceFilePath,
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
      });

    case "project.update":
      return yield* projects.update({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
        ...(mutation.workspaceRoot === undefined ? {} : { workspaceRoot: mutation.workspaceRoot }),
        ...(mutation.workspaceFilePath === undefined
          ? {}
          : { workspaceFilePath: mutation.workspaceFilePath }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.autoPull === undefined ? {} : { autoPull: mutation.autoPull }),
        ...(mutation.projectIcon === undefined ? {} : { projectIcon: mutation.projectIcon }),
        ...(mutation.faviconPath === undefined ? {} : { faviconPath: mutation.faviconPath }),
        ...(mutation.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: mutation.defaultThreadEnvMode }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });

    case "project.delete":
      return yield* projects.delete({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.force === undefined ? {} : { force: mutation.force }),
      });
  }
});

/**
 * What a client should see when a mutation is refused for a reason it can act
 * on: the message, the workspace file's diagnostic, and the project that
 * already holds the file or folder. Undefined for operational failures.
 */
export function expectedProjectMutationFailure(error: ProjectServiceError):
  | {
      readonly message: string;
      readonly diagnostic?: WorkspaceFileDiagnostic;
      readonly conflictingProjectId?: ProjectId;
    }
  | undefined {
  switch (error._tag) {
    case "ProjectOperationError":
      return undefined;
    case "WorkspaceFileUnavailableError":
      return { message: error.message, diagnostic: error.diagnostic };
    case "ProjectFileConflictError":
      return {
        message: error.message,
        diagnostic: { code: "conflict", message: error.message, path: error.workspaceFile },
        conflictingProjectId: error.conflictingProjectId,
      };
    case "ProjectConflictError":
      return { message: error.message, conflictingProjectId: error.conflictingProjectId };
    default:
      return { message: error.message };
  }
}
