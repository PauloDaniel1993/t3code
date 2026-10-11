import type { OrchestrationProjectShell } from "@t3tools/contracts";
import {
  isSamePath,
  projectFolders,
  resolveThreadWorkspace,
  workspaceGitCheckouts,
  snapshotFolderCheckoutLocation,
  worktreeSetPath,
  type WorkspaceThread,
} from "@t3tools/shared/workspaceFolders";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

export type WorkspaceFoldersProject = Pick<
  OrchestrationProjectShell,
  "id" | "workspaceRoot" | "folders" | "workspaceFile" | "workspaceFileStatus"
>;

/** Drafts follow the project; bound threads always use their frozen folders. */
export function workspaceFolderRows(
  project: WorkspaceFoldersProject,
  thread: WorkspaceThread | null,
  unavailableFolderPaths: ReadonlyArray<string> = [],
) {
  const factsByLocation = new Map(
    project.folders?.map((folder) => [
      folder.path === undefined ? folder.uri : normalizeProjectPathForComparison(folder.path),
      folder,
    ]),
  );
  const factsByLabel = new Map(project.folders?.map((folder) => [folder.label, folder]));
  const workspace = resolveThreadWorkspace({
    project,
    thread: thread ?? {
      worktreePath: null,
      workspaceFolders: projectFolders(project).map((folder) => {
        const vcs = factsByLabel.get(folder.label)?.vcs;
        return { ...folder, checkoutRoot: vcs === null ? null : vcs?.checkoutRoot };
      }),
    },
  });
  return workspace.folders.map((resolved, index) => {
    const frozen = thread?.workspaceFolders?.[index];
    const checkoutLocation = frozen ? snapshotFolderCheckoutLocation(frozen) : undefined;
    const diffPath =
      resolved.isPrimary && thread?.worktreePath
        ? thread.worktreePath
        : checkoutLocation !== undefined
          ? worktreeSetPath(checkoutLocation, thread?.worktrees ?? [])
          : resolved.effectivePath;
    const facts = factsByLocation.get(
      resolved.folder.path === undefined
        ? resolved.folder.uri
        : normalizeProjectPathForComparison(resolved.folder.path),
    );
    const isWorktree =
      resolved.folder.path !== undefined &&
      resolved.effectivePath !== null &&
      !isSamePath(resolved.folder.path, resolved.effectivePath);
    const availability = isWorktree && resolved.isPrimary ? undefined : facts?.availability;
    const unavailable =
      resolved.effectivePath === null ||
      availability === "unavailable" ||
      (availability === undefined &&
        unavailableFolderPaths.some((path) =>
          resolved.folder.path ? isSamePath(path, resolved.folder.path) : false,
        ));
    const checkoutRoot =
      thread?.workspaceFolders !== undefined || resolved.checkoutRoot !== undefined
        ? resolved.checkoutRoot
        : facts?.vcs === null
          ? null
          : facts?.vcs?.checkoutRoot;
    const isGit = !unavailable && typeof checkoutRoot === "string";
    const reason = !unavailable
      ? null
      : resolved.folder.uri !== undefined || facts?.unavailableReason === "remote"
        ? `Remote${facts?.remoteDescription ? ` (${facts.remoteDescription})` : ""}, not available here`
        : facts?.unavailableReason === "not-directory"
          ? "Not a directory"
          : facts?.unavailableReason === "inaccessible"
            ? "Inaccessible"
            : "Missing on disk";
    return {
      ...resolved,
      diffPath,
      effectivePath: unavailable ? null : resolved.effectivePath,
      checkoutRoot,
      vcsKnown: thread?.workspaceFolders !== undefined || facts?.vcs !== undefined,
      isGit,
      isWorktree,
      unavailable,
      reason,
      path: resolved.effectivePath ?? resolved.folder.path ?? resolved.folder.uri ?? "",
    };
  });
}

export type WorkspaceFolderRow = ReturnType<typeof workspaceFolderRows>[number];

/** A missing folder cannot own a status lease or a per-repository action. */
export function availableWorkspaceGitCheckouts(
  project: WorkspaceFoldersProject,
  thread: WorkspaceThread,
  rows: ReadonlyArray<WorkspaceFolderRow>,
) {
  return workspaceGitCheckouts(thread, project).flatMap((checkout) => {
    if (!thread.workspaceFolders) return [checkout];
    const folder = rows.find(
      (row) =>
        row.isGit &&
        row.effectivePath !== null &&
        ((typeof row.checkoutRoot === "string" &&
          isSamePath(row.checkoutRoot, checkout.repositoryRoot)) ||
          (row.isPrimary && isSamePath(row.effectivePath, checkout.cwd))),
    );
    if (!folder) return [];
    const originalAvailable = rows.some(
      (row) =>
        row.isGit && row.effectivePath !== null && isSamePath(row.effectivePath, checkout.cwd),
    );
    // GitWorkflowService falls back to the checkout root when its first folder is gone.
    return [{ ...checkout, cwd: originalAvailable ? checkout.cwd : checkout.root }];
  });
}

export function workspaceRepositoryCount(rows: ReadonlyArray<WorkspaceFolderRow>) {
  const roots = new Set<string>();
  for (const row of rows) {
    if (row.isGit && typeof row.checkoutRoot === "string")
      roots.add(normalizeProjectPathForComparison(row.checkoutRoot));
  }
  return roots.size;
}

export function workspaceSnapshotChanged(
  project: WorkspaceFoldersProject,
  thread: WorkspaceThread,
) {
  if (!thread.workspaceFolders) return false;
  const current = projectFolders(project);
  return (
    current.length !== thread.workspaceFolders.length ||
    current.some((folder, index) => {
      const frozen = thread.workspaceFolders?.[index];
      return (
        frozen === undefined ||
        folder.name !== frozen.name ||
        (folder.path && frozen.path
          ? !isSamePath(folder.path, frozen.path)
          : folder.path !== frozen.path || folder.uri !== frozen.uri)
      );
    })
  );
}

export function workspaceAvailabilityPending(
  rows: ReadonlyArray<WorkspaceFolderRow>,
  lastRunUnavailableFolderPaths: ReadonlyArray<string> | undefined,
) {
  if (!lastRunUnavailableFolderPaths || rows[0]?.unavailable) return false;
  return rows.some(
    (row) =>
      !row.isPrimary &&
      row.folder.path !== undefined &&
      row.unavailable !==
        lastRunUnavailableFolderPaths.some((path) => isSamePath(path, row.folder.path!)),
  );
}

/** A shell never borrows changed project membership for an already-bound thread. */
export function workspaceFolderChipCount(
  thread: { readonly workspaceFolderCount?: number | undefined } | null,
  project: WorkspaceFoldersProject | null,
) {
  return thread === null ? (project?.folders?.length ?? 1) : (thread.workspaceFolderCount ?? 1);
}
