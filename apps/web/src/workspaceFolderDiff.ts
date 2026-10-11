import {
  isSamePath,
  owningFolder,
  snapshotFolderCheckoutLocation,
  worktreeSetPath,
  type WorkspaceThread,
} from "@t3tools/shared/workspaceFolders";
import { resolveDiffPathForWorkspace } from "./diffFileActions";
import { resolvePathLinkTarget } from "./terminal-links";
import {
  workspaceFolderRows,
  type WorkspaceFoldersProject,
} from "./components/workspaceFolders.logic";

/** A folder selection pins the original path, never a label that a later file edit can reuse. */
export function workspaceFolderDiffTarget(
  project: WorkspaceFoldersProject,
  thread: WorkspaceThread,
  folderPath: string,
  unavailableFolderPaths?: ReadonlyArray<string> | undefined,
) {
  const rows = workspaceFolderRows(project, thread, unavailableFolderPaths);
  const row = rows.find(
    (folder) => folder.folder.path && isSamePath(folder.folder.path, folderPath),
  );
  if (!row?.isGit || !row.effectivePath || !row.checkoutRoot) return null;
  // Ownership remains frozen even when a nested folder is currently unavailable.
  // Git paths and symlinked folders must meet in the snapshot's real checkout space.
  const owners = (thread.workspaceFolders ?? []).map((folder) => ({
    label: folder.label,
    path:
      folder.path === undefined
        ? null
        : worktreeSetPath(
            snapshotFolderCheckoutLocation(folder) ?? folder.path,
            thread.worktrees ?? [],
          ),
  }));
  const workspaceRoot =
    owners.find((folder) => folder.label === row.label)?.path ?? row.effectivePath;
  return {
    row,
    owners,
    workspaceRoot,
    cwd: row.effectivePath,
    repositoryRoot: worktreeSetPath(row.checkoutRoot, thread.worktrees ?? []),
  };
}

export function workspaceFolderOwnsDiffPath(
  target: NonNullable<ReturnType<typeof workspaceFolderDiffTarget>>,
  filePath: string,
) {
  if (
    resolveDiffPathForWorkspace({
      filePath,
      workspaceRoot: target.workspaceRoot,
      repositoryRoot: target.repositoryRoot,
    }) === null
  )
    return false;
  const absolute = resolvePathLinkTarget(filePath, target.repositoryRoot);
  const owner = owningFolder(absolute, target.owners);
  return owner?.label === target.row.label;
}
