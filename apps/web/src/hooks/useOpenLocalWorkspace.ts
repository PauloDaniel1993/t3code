import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  findProjectByPath,
  findProjectByWorkspaceFile,
  inferProjectTitleFromPath,
} from "@t3tools/client-runtime/state/projects";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";

import { handleDesktopAppActivationRequest } from "../desktopAppActivation";
import { newProjectId } from "../lib/utils";
import { readProjects, waitForProject } from "../state/entities";
import { usePrimaryEnvironment } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentShellHasSnapshot } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { reportProjectFailure } from "./useProjectGroupUpdate";
import { useNewThreadHandler } from "./useHandleNewThread";

/**
 * Opens a local folder or workspace file as a project in the primary environment.
 * Existing projects reopen and unarchive; missing projects are created or imported.
 * `ready` waits for the primary environment's projects to load to avoid duplicates.
 */
export function useOpenLocalWorkspace() {
  const primaryEnvironment = usePrimaryEnvironment();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importWorkspaceFile = useAtomCommand(projectEnvironment.importWorkspaceFile, {
    reportFailure: false,
  });
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    label: "project unarchive",
  });
  const openThread = useNewThreadHandler();
  const shellHasSnapshot = useEnvironmentShellHasSnapshot(
    primaryEnvironment?.environmentId ?? null,
  );
  const ready =
    primaryEnvironment?.connection.phase === "connected" &&
    primaryEnvironment.serverConfig !== null &&
    shellHasSnapshot;

  const open = (request: DesktopAppActivationRequest) =>
    handleDesktopAppActivationRequest(request, {
      getTarget: () => {
        if (
          primaryEnvironment?.connection.phase !== "connected" ||
          primaryEnvironment.serverConfig === null
        ) {
          return null;
        }
        return {
          environmentId: primaryEnvironment.environmentId,
          platform: primaryEnvironment.serverConfig.environment.platform.os,
          workspaceFileProjects: primaryEnvironment.serverConfig.workspaceFileProjects === true,
        };
      },
      findProject: (environmentId, workspaceRoot) =>
        findProjectByPath(
          readProjects().filter((project) => project.environmentId === environmentId),
          workspaceRoot,
        ) ?? null,
      createProject: async (environmentId, workspaceRoot) => {
        const projectId = newProjectId();
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(workspaceRoot),
            workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          throw error instanceof Error ? error : new Error("T3 Code could not add the project.");
        }
        return projectId;
      },
      findWorkspaceFileProject: (environmentId, workspaceFilePath) =>
        findProjectByWorkspaceFile(
          readProjects().filter((project) => project.environmentId === environmentId),
          workspaceFilePath,
        ) ?? null,
      importWorkspaceFile: async (environmentId, workspaceFilePath) => {
        const projectId = newProjectId();
        const result = await importWorkspaceFile({
          environmentId,
          input: { projectId, workspaceFilePath },
        });
        if (result._tag === "Failure") {
          throw squashAtomCommandFailure(result);
        }
        return projectId;
      },
      waitForProject: async (projectRef) => {
        await waitForProject(projectRef);
      },
      openThread: (projectRef) => {
        const project = readProjects().find(
          (candidate) =>
            candidate.environmentId === projectRef.environmentId &&
            candidate.id === projectRef.projectId,
        );
        // Opening an archived project's folder again brings the project back.
        if (project?.archivedAt != null) {
          void updateProject({
            environmentId: projectRef.environmentId,
            input: { projectId: projectRef.projectId, archived: false },
          }).then((result) => reportProjectFailure("Failed to unarchive project", result));
        }
        return openThread(projectRef);
      },
    });

  return { ready, open };
}
