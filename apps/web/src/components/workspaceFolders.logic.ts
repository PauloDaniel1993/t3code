import type {
  OrchestrationProjectShell,
  OrchestrationV2ProviderSession,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  isSamePath,
  projectFolders,
  resolveThreadWorkspace,
  workspaceAdditionalDirectories,
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
  return workspace.folders.map((resolved) => {
    const facts = factsByLocation.get(
      resolved.folder.path === undefined
        ? resolved.folder.uri
        : normalizeProjectPathForComparison(resolved.folder.path),
    );
    const unavailable =
      resolved.effectivePath === null ||
      facts?.availability === "unavailable" ||
      (facts?.availability === undefined &&
        unavailableFolderPaths.some((path) =>
          resolved.folder.path ? isSamePath(path, resolved.folder.path) : false,
        ));
    const checkoutRoot =
      resolved.checkoutRoot !== undefined
        ? resolved.checkoutRoot
        : facts?.vcs === null
          ? null
          : facts?.vcs?.checkoutRoot;
    const isGit = !unavailable && typeof checkoutRoot === "string";
    const isWorktree =
      resolved.folder.path !== undefined &&
      resolved.effectivePath !== null &&
      !isSamePath(resolved.folder.path, resolved.effectivePath);
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
      isGit,
      isWorktree,
      unavailable,
      reason,
      path: resolved.effectivePath ?? resolved.folder.path ?? resolved.folder.uri ?? "",
    };
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
  session: Pick<OrchestrationV2ProviderSession, "cwd" | "additionalDirectories"> | undefined,
) {
  if (!session || rows.length < 2) return false;
  const primary = rows[0]!;
  if (primary.effectivePath === null) return true;
  const directories = workspaceAdditionalDirectories({
    primaryPath: primary.effectivePath,
    folders: rows,
  });
  const installed = session.additionalDirectories ?? [];
  return (
    !isSamePath(primary.effectivePath, session.cwd) ||
    directories.length !== installed.length ||
    directories.some((path, index) => !installed[index] || !isSamePath(path, installed[index]!))
  );
}

export function workspaceInstalledSession(projection: OrchestrationV2ThreadProjection) {
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  return projection.providerSessions.find(
    (session) => session.id === providerThread?.providerSessionId,
  );
}

/** A shell never borrows changed project membership for an already-bound thread. */
export function workspaceFolderChipCount(
  thread: { readonly workspaceFolderCount?: number | undefined } | null,
  project: WorkspaceFoldersProject | null,
) {
  return thread === null ? (project?.folders?.length ?? 1) : (thread.workspaceFolderCount ?? 1);
}
