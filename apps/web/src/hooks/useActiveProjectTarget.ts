import { useMemo } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadPrimaryPath } from "@t3tools/shared/workspaceFolders";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { workspaceFileContext, type WorkspaceFileContext } from "~/components/files/workspaceFiles";
import { useEnvironment } from "~/state/environments";
import { useThreadProjection } from "~/state/entities";
import { useProjects } from "~/state/entities";

import { useHandleNewThread } from "./useHandleNewThread";

export interface ActiveProjectTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly workspace?: WorkspaceFileContext | undefined;
  readonly projectName: string;
  readonly threadRef: ScopedThreadRef;
}

/**
 * Resolves the project workspace behind the active thread (or draft) so
 * project-scoped surfaces like the file picker and content search know which
 * workspace to query and which thread's right panel opens their results.
 */
export function useActiveProjectTarget(): ActiveProjectTarget | null {
  const { activeDraftThread, activeThread, routeThreadRef } = useHandleNewThread();
  const projects = useProjects();
  const detail = useThreadProjection(routeThreadRef)?.projection.thread;
  const environment = useEnvironment(
    activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null,
  );
  const thread = activeThread ?? activeDraftThread;
  const threadId = activeThread?.id ?? activeDraftThread?.threadId;
  const project = thread
    ? projects.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
      )
    : null;
  const cwd = threadPrimaryPath(detail ?? thread, project);
  const binding = detail ?? activeDraftThread;

  const workspace = useMemo(
    () =>
      project
        ? workspaceFileContext(
            project,
            {
              worktreePath: binding?.worktreePath ?? null,
              workspaceFolders: detail?.workspaceFolders,
              worktrees: detail?.worktrees,
            },
            activeThread?.id,
            environment?.serverConfig?.workspaceFileProjects === true,
          )
        : undefined,
    [
      project,
      binding?.worktreePath,
      detail?.workspaceFolders,
      detail?.worktrees,
      activeThread?.id,
      environment?.serverConfig?.workspaceFileProjects,
    ],
  );
  if (!thread || !threadId || !project || !cwd || (activeThread && !detail)) return null;

  return {
    environmentId: project.environmentId,
    cwd,
    projectName: project.title,
    workspace,
    threadRef: scopeThreadRef(thread.environmentId, threadId),
  };
}
