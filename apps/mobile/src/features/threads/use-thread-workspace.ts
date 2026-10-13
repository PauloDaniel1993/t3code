import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { workspaceGitCheckouts } from "@t3tools/shared/workspaceFolders";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { useMemo } from "react";
import { useProject, useThreadShell } from "../../state/entities";
import { useAppThread } from "../../state/use-thread-detail";
import { environmentThreadDetails } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import { availableWorkspaceGitCheckouts, workspaceFolderRows } from "./workspace-folders-model";
import { deriveLatestThreadRun } from "@t3tools/client-runtime/state/thread-execution";

/** Mounted only by folder/details screens, never by a collapsed list row. */
export function useThreadWorkspace(target: ScopedThreadRef) {
  const { environmentId, threadId } = target;
  const shell = useThreadShell(target);
  const thread = useAppThread(target);
  const project = useProject(
    shell ? { environmentId: target.environmentId, projectId: shell.projectId } : null,
  );
  const unavailableFolderPaths = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) => {
          const detail = get(environmentThreadDetails.threadAtom({ environmentId, threadId }));
          const latestRunId = detail ? deriveLatestThreadRun(detail.projection)?.runId : null;
          return detail?.projection.runs.find((run) => run.id === latestRunId)
            ?.unavailableFolderPaths;
        }),
      [environmentId, threadId],
    ),
  );
  const rows = useMemo(
    () => (project && thread ? workspaceFolderRows(project, thread, unavailableFolderPaths) : []),
    [project, thread, unavailableFolderPaths],
  );
  const checkouts = useMemo(
    () => (project && thread ? availableWorkspaceGitCheckouts(project, thread, rows) : []),
    [project, thread, rows],
  );
  return {
    shell,
    project,
    thread,
    rows,
    checkouts,
    unavailableFolderPaths,
  };
}

export function useWorkspaceGitQueries(
  target: ScopedThreadRef,
  checkouts: ReturnType<typeof workspaceGitCheckouts>,
) {
  return useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          checkouts.map((checkout) => {
            const result = get(
              vcsEnvironment.status({
                environmentId: target.environmentId,
                input: { cwd: checkout.cwd },
              }),
            );
            return {
              status: Option.getOrNull(AsyncResult.value(result)),
              error: result._tag === "Failure",
            };
          }),
        ),
      [checkouts, target.environmentId],
    ),
  );
}
