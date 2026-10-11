import type { OrchestrationProjectShell } from "@t3tools/contracts";
import {
  isSamePath,
  isPathWithin,
  workspaceGitCheckouts,
  projectFolders,
  resolveThreadWorkspace,
  type WorkspaceThread,
} from "@t3tools/shared/workspaceFolders";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { workspaceCheckoutStatusCwds } from "@t3tools/client-runtime/state/vcs";

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
  const snapshot = thread ?? {
    worktreePath: null,
    workspaceFolders: projectFolders(project).map((folder) => {
      const vcs = factsByLabel.get(folder.label)?.vcs;
      return { ...folder, checkoutRoot: vcs === null ? null : vcs?.checkoutRoot };
    }),
  };
  const workspace = resolveThreadWorkspace({ project, thread: snapshot });
  const rows = workspace.folders.map((resolved) => {
    const facts = factsByLocation.get(
      resolved.folder.path === undefined
        ? resolved.folder.uri
        : normalizeProjectPathForComparison(resolved.folder.path),
    );
    const isWorktree =
      resolved.folder.path !== undefined &&
      resolved.effectivePath !== null &&
      !isSamePath(resolved.folder.path, resolved.effectivePath);
    const availability = resolved.isPrimary && isWorktree ? undefined : facts?.availability;
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
  const checkouts = workspaceGitCheckouts(snapshot, project);
  const cwds = workspaceCheckoutStatusCwds(checkouts, rows);
  return rows.map((row) => {
    const index = checkouts.findIndex(
      (checkout) =>
        row.effectivePath !== null &&
        isPathWithin(checkout.root, row.effectivePath) &&
        (row.label === checkout.label ||
          (typeof row.checkoutRoot === "string" &&
            isSamePath(row.checkoutRoot, checkout.repositoryRoot))),
    );
    const checkout = checkouts[index];
    const member = thread?.worktrees?.find(
      (member) => checkout && isSamePath(member.path, checkout.root),
    );
    return { ...row, branchCwd: member?.path ?? cwds[index] ?? null };
  });
}

export type WorkspaceFolderRow = ReturnType<typeof workspaceFolderRows>[number];

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
