import {
  isSamePath,
  owningFolder,
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
) {
  const rows = workspaceFolderRows(project, thread);
  const row = rows.find(
    (folder) => folder.folder.path && isSamePath(folder.folder.path, folderPath),
  );
  if (!row?.isGit || !row.effectivePath || !row.checkoutRoot) return null;
  return {
    row,
    rows,
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
      workspaceRoot: target.cwd,
      repositoryRoot: target.repositoryRoot,
    }) === null
  )
    return false;
  const absolute = resolvePathLinkTarget(filePath, target.repositoryRoot);
  const owner = owningFolder(
    absolute,
    target.rows.map((row) => ({ path: row.effectivePath, label: row.label })),
  );
  return owner?.label === target.row.label;
}
