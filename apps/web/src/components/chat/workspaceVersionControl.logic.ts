import type { VcsStatusResult } from "@t3tools/contracts";
import type { WorkspaceThread } from "@t3tools/shared/workspaceFolders";
import { isSamePath, workspaceGitCheckouts } from "@t3tools/shared/workspaceFolders";
import { workspaceFolderDiffTarget, workspaceFolderOwnsDiffPath } from "../../workspaceFolderDiff";
import { resolveDiffPathForWorkspace } from "../../diffFileActions";
import { type WorkspaceFoldersProject, type WorkspaceFolderRow } from "../workspaceFolders.logic";

/** Labels and deepest ownership come from the frozen snapshot, including skipped nested folders. */
export function workspaceChangedFiles(
  project: WorkspaceFoldersProject,
  thread: WorkspaceThread,
  rows: ReadonlyArray<WorkspaceFolderRow>,
  statuses: ReadonlyArray<VcsStatusResult | null>,
) {
  const checkouts = workspaceGitCheckouts(thread, project);
  const targets = rows.flatMap((row) => {
    if (!row.isGit || row.folder.path === undefined) return [];
    const target = workspaceFolderDiffTarget(
      project,
      thread,
      row.folder.path,
      rows
        .filter((folder) => folder.unavailable && folder.folder.path)
        .map((folder) => folder.folder.path!),
    );
    return target === null ? [] : [target];
  });
  return checkouts.flatMap(
    (checkout, index) =>
      statuses[index]?.workingTree.files.flatMap((file) => {
        const target = targets.find(
          (target) =>
            isSamePath(target.repositoryRoot, checkout.root) &&
            workspaceFolderOwnsDiffPath(target, file.path),
        );
        if (!target) return [];
        const path = resolveDiffPathForWorkspace({
          filePath: file.path,
          workspaceRoot: target.workspaceRoot,
          repositoryRoot: checkout.root,
        });
        return path === null
          ? []
          : [
              {
                ...file,
                checkout,
                row: target.row,
                canonicalPath: rows.length > 1 ? `${target.row.label}/${path}` : path,
              },
            ];
      }) ?? [],
  );
}
