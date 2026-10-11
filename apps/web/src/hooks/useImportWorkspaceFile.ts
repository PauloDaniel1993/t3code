import { ProjectMutationError, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { newProjectId } from "../lib/utils";
import { useCallback } from "react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { listProjectsUsingFolder } from "@t3tools/client-runtime/operations/projects";
import { readProjects, waitForProject } from "../state/entities";
import { toastManager } from "../components/ui/toast";

const isProjectMutationError = Schema.is(ProjectMutationError);

export function workspaceFileErrorMessage(error: unknown): string {
  if (isProjectMutationError(error) && error.diagnostic) {
    const diagnostic = error.diagnostic;
    return `${diagnostic.message}${diagnostic.line === undefined ? "" : ` (line ${diagnostic.line}${diagnostic.column === undefined ? "" : `, column ${diagnostic.column}`})`}`;
  }
  return error instanceof Error ? error.message : "Could not use the workspace file.";
}

export function useImportWorkspaceFile() {
  const importWorkspaceFile = useAtomCommand(projectEnvironment.importWorkspaceFile, {
    reportFailure: false,
  });
  return useCallback(
    async (environmentId: EnvironmentId, workspaceFilePath: string) => {
      let projectId = newProjectId();
      const result = await importWorkspaceFile({
        environmentId,
        input: { projectId, workspaceFilePath },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        if (
          !isAtomCommandInterrupted(result) &&
          isProjectMutationError(error) &&
          error.diagnostic?.code === "conflict" &&
          error.conflictingProjectId
        ) {
          projectId = error.conflictingProjectId;
        } else {
          throw error;
        }
      }
      const project = await waitForProject(scopeProjectRef(environmentId, projectId));
      const others = readProjects().filter(
        (candidate) => candidate.environmentId === environmentId && candidate.id !== projectId,
      );
      const overlapping = listProjectsUsingFolder(others, project.workspaceRoot);
      if (overlapping.length)
        toastManager.add({
          type: "info",
          title: `This folder is also used by ${overlapping.map((candidate) => candidate.title).join(", ")}`,
          description: project.workspaceRoot,
        });
      return projectId;
    },
    [importWorkspaceFile],
  );
}
