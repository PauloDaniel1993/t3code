import type { ProjectWorkspaceFolder, ServerProvider } from "@t3tools/contracts";
import {
  resolveThreadWorkspace,
  threadPrimaryPath,
  workspaceAdditionalDirectories,
  type WorkspaceThread,
} from "@t3tools/shared/workspaceFolders";

/** The folders a thread would hand its provider beyond its working directory. */
export interface WorkspaceFolderScope {
  readonly additionalDirectories: ReadonlyArray<string>;
}

/**
 * A thread's folder scope as a client knows it before a run: a bound thread's
 * snapshot, or for a new thread (`thread: null`) its project's folders. Folders
 * the server last reported unavailable are left out, as the next run's
 * admission would. A shell carries no snapshot, so it counts as one folder.
 */
export function workspaceFolderScope(input: {
  readonly thread: WorkspaceThread | null | undefined;
  readonly project:
    | {
        readonly workspaceRoot: string;
        readonly folders?: ReadonlyArray<ProjectWorkspaceFolder> | null | undefined;
      }
    | null
    | undefined;
}): WorkspaceFolderScope {
  const thread = input.thread ?? {
    worktreePath: null,
    workspaceFolders: input.project?.folders ?? undefined,
  };
  const primaryPath = threadPrimaryPath(thread, input.project);
  if (primaryPath === null) return { additionalDirectories: [] };
  return {
    additionalDirectories: workspaceAdditionalDirectories(
      resolveThreadWorkspace({
        thread,
        project: input.project ?? { workspaceRoot: primaryPath },
        unavailableFolderPaths: input.project?.folders?.flatMap((folder) =>
          folder.availability === "unavailable" && folder.path !== undefined ? [folder.path] : [],
        ),
      }),
    ),
  };
}

/**
 * Whether a provider may run this scope: only one whose workspace-folder
 * access is "supported" gets folders beyond its working directory. The server
 * enforces the same rule.
 */
export function isProviderEligibleForScope(
  provider: Pick<ServerProvider, "workspaceFolderAccess"> | null | undefined,
  scope: WorkspaceFolderScope,
): boolean {
  return (
    scope.additionalDirectories.length === 0 || provider?.workspaceFolderAccess === "supported"
  );
}
