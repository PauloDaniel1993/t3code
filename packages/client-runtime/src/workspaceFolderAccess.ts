import type {
  ProjectTrackedFolder,
  ProjectWorkspaceFolder,
  ServerProvider,
} from "@t3tools/contracts";
import {
  isPathWithin,
  isSamePath,
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
 * A client's estimate of the grants needed by a thread. Legacy threads use
 * their snapshot when available. Plain threads in a project's own checkout
 * use the project's tracked paths; the server checks their current realpaths
 * and availability, including for worktrees in task folders.
 */
export function workspaceFolderScope(input: {
  readonly thread: WorkspaceThread | null | undefined;
  readonly project:
    | {
        readonly workspaceRoot: string;
        readonly workspaceFile?: string | null | undefined;
        readonly trackedFolders?: ReadonlyArray<ProjectTrackedFolder> | undefined;
        readonly folders?: ReadonlyArray<ProjectWorkspaceFolder> | null | undefined;
      }
    | null
    | undefined;
}): WorkspaceFolderScope {
  const { project } = input;
  const thread: WorkspaceThread = input.thread ?? {
    worktreePath: null,
    workspaceFolders: project?.folders ?? undefined,
  };
  const primaryPath = threadPrimaryPath(thread, project);
  if (primaryPath === null) return { additionalDirectories: [] };

  if (
    project?.trackedFolders !== undefined &&
    project.workspaceFile == null &&
    project.folders == null &&
    thread.workspaceFolders === undefined &&
    thread.workspacePrimaryPath === undefined &&
    thread.worktreePath === null
  ) {
    const additionalDirectories: string[] = [];
    for (const { path } of project.trackedFolders) {
      if (
        !isPathWithin(primaryPath, path) &&
        !additionalDirectories.some((directory) => isSamePath(directory, path))
      ) {
        additionalDirectories.push(path);
      }
    }
    return { additionalDirectories };
  }

  return {
    additionalDirectories: workspaceAdditionalDirectories(
      resolveThreadWorkspace({
        thread,
        project: project ?? { workspaceRoot: primaryPath },
        unavailableFolderPaths: project?.folders?.flatMap((folder) =>
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
