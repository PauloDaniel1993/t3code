import { msg } from "gt-react";
import { m } from "../i18n/messages";
import { ProjectMutationError, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { newProjectId } from "../lib/utils";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { listProjectFolderOverlaps } from "@t3tools/client-runtime/operations/projects";
import { readProjects, waitForProject } from "../state/entities";
import { toastManager } from "../components/ui/toast";

const isProjectMutationError = Schema.is(ProjectMutationError);

export function workspaceFileErrorMessage(error: unknown): string {
  if (isProjectMutationError(error) && error.diagnostic) {
    const diagnostic = error.diagnostic;
    if (diagnostic.line === undefined) return diagnostic.message;
    const { message, line, column } = diagnostic;
    return column === undefined
      ? m(msg("{message} (line {line})", { message, line }))
      : m(msg("{message} (line {line}, column {column})", { message, line, column }));
  }
  return error instanceof Error ? error.message : m(msg("Could not use the workspace file."));
}

export function useImportWorkspaceFile() {
  const importWorkspaceFile = useAtomCommand(projectEnvironment.importWorkspaceFile, {
    reportFailure: false,
  });
  return async (environmentId: EnvironmentId, workspaceFilePath: string) => {
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
    const project = await waitForProject(scopeProjectRef(environmentId, projectId)).catch(() => {
      toastManager.add({
        type: "info",
        title: m(msg("The project is ready on the environment")),
        description: m(msg("It will appear in the sidebar once this client catches up.")),
      });
      return null;
    });
    if (project === null) return null;
    const others = readProjects().filter(
      (candidate) => candidate.environmentId === environmentId && candidate.id !== projectId,
    );
    for (const overlapping of listProjectFolderOverlaps(others, project)) {
      toastManager.add({
        type: "info",
        title: m(
          msg("This folder is also used by {projects}", {
            projects: overlapping.projects.map((candidate) => candidate.title).join(", "),
          }),
        ),
        description: overlapping.path,
      });
    }
    return projectId;
  };
}
