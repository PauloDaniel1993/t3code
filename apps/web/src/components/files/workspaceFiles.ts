import type {
  AssetResource,
  ProjectId,
  ThreadId,
  WorkspaceScope,
  WorkspaceScopeFolder,
} from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import {
  owningFolder,
  parseCanonicalPath,
  projectFolders,
  resolveThreadWorkspace,
  toCanonicalPath,
  type WorkspaceProject,
  type WorkspaceThread,
  type ThreadWorkspace,
} from "@t3tools/shared/workspaceFolders";
import { isAbsolutePath, resolvePathLinkTarget } from "~/terminal-links";
import { useMemo } from "react";

export interface WorkspaceFileContext {
  readonly scope: WorkspaceScope;
  readonly folders: ThreadWorkspace["folders"];
}

/** Drafts use current membership; bound threads always use their frozen snapshot. */
export function workspaceFileContext(
  project: WorkspaceProject & {
    readonly id: ProjectId;
    readonly workspaceFile?: string | null | undefined;
  },
  thread: WorkspaceThread | null | undefined,
  threadId: ThreadId | undefined,
  enabled: boolean,
): WorkspaceFileContext | undefined {
  if (
    !enabled ||
    (threadId !== undefined && !thread?.workspaceFolders) ||
    (!thread?.workspaceFolders && !project.workspaceFile)
  )
    return undefined;
  return {
    scope: { projectId: project.id, ...(threadId ? { threadId } : {}) },
    folders: resolveThreadWorkspace({
      project,
      thread: {
        ...thread,
        worktreePath: thread?.worktreePath ?? null,
        workspaceFolders: thread?.workspaceFolders ?? projectFolders(project),
      },
    }).folders,
  };
}

/** Projection events can replace the snapshot object without changing its addresses. */
export function useWorkspaceFileContext(
  project: Parameters<typeof workspaceFileContext>[0] | null | undefined,
  ...input: [
    thread: WorkspaceThread | null | undefined,
    threadId: ThreadId | undefined,
    enabled: boolean,
  ]
) {
  const serialized = JSON.stringify(project ? workspaceFileContext(project, ...input) : undefined);
  return useMemo(
    () => (serialized === undefined ? undefined : (JSON.parse(serialized) as WorkspaceFileContext)),
    [serialized],
  );
}

/** Unpinned opens come from existing primary-relative links; canonical selections carry a pin. */
export function workspaceFileOpenReference(
  context: WorkspaceFileContext | undefined,
  path: string,
  cwd: string,
  folderPath?: string,
) {
  return workspaceFileReference(
    context,
    context && folderPath === undefined && !isAbsolutePath(path)
      ? workspaceMentionPreviewPath(path, cwd)
      : path,
    folderPath,
  );
}

export function workspaceFileScopeKey(cwd: string, scope?: WorkspaceScope): string {
  return scope
    ? JSON.stringify([scope.projectId, scope.threadId ?? null, scope.folderPath ?? null])
    : cwd;
}

export function workspaceFileContextKey(cwd: string, workspace?: WorkspaceFileContext) {
  return workspace
    ? JSON.stringify([
        workspaceFileScopeKey(cwd, workspace.scope),
        workspace.folders.map((folder) => [
          folder.folder.path ?? folder.folder.uri,
          folder.label,
          folder.effectivePath,
        ]),
      ])
    : cwd;
}

/** Keep editor and save sessions stable across unrelated projection updates. */
export function useWorkspaceFileScope(input: WorkspaceScope | undefined) {
  const projectId = input?.projectId;
  const threadId = input?.threadId;
  const folderPath = input?.folderPath;
  return useMemo(
    () =>
      projectId === undefined
        ? undefined
        : { projectId, ...(threadId ? { threadId } : {}), ...(folderPath ? { folderPath } : {}) },
    [projectId, threadId, folderPath],
  );
}

/** Pin the owner in the response table, including nested-folder search results. */
export function workspaceResultFolderPath(path: string, folders: readonly WorkspaceScopeFolder[]) {
  return parseCanonicalPath(path, folders)?.folder.folderPath;
}

export function workspaceFileReference(
  context: WorkspaceFileContext | undefined,
  path: string,
  folderPath?: string,
) {
  if (!context) return null;
  const mapped = context.folders.map((folder) => ({ ...folder, path: folder.effectivePath }));
  const absoluteOwner = isAbsolutePath(path) ? owningFolder(path, mapped) : undefined;
  const parsed = absoluteOwner
    ? {
        folder: absoluteOwner,
        relativePath: path
          .slice(absoluteOwner.path!.replace(/[\\/]+$/, "").length)
          .replace(/^[/\\]/, ""),
      }
    : isAbsolutePath(path)
      ? null
      : parseCanonicalPath(path, mapped);
  if (!parsed) return null;
  const relativePath = /^[a-z]:[/\\]|^\\\\/i.test(path)
    ? parsed.relativePath.replaceAll("\\", "/")
    : parsed.relativePath;
  const identity = parsed.folder.folder.path ?? parsed.folder.folder.uri!;
  // A stale pin never falls through to a new owner of the same label.
  if (folderPath !== undefined && identity !== folderPath) return null;
  const canonicalPath = toCanonicalPath(parsed.folder, relativePath, mapped.length);
  return {
    canonicalPath,
    relativePath,
    folderPath: identity,
    folder: parsed.folder,
    scope: { ...context.scope, folderPath: identity },
    absolutePath:
      parsed.folder.effectivePath === null
        ? null
        : resolvePathLinkTarget(relativePath || ".", parsed.folder.effectivePath),
  };
}

/** Primary links retain their relative destination; other folders use the mapped server path. */
export function workspaceFileMention(
  context: WorkspaceFileContext | undefined,
  path: string,
  folderPath?: string,
) {
  const reference = workspaceFileReference(context, path, folderPath);
  if (!context) return serializeComposerFileLink(path);
  if (!reference || reference.absolutePath === null) return null;
  const destination = reference.folder.isPrimary
    ? reference.relativePath || "."
    : reference.absolutePath;
  return serializeComposerFileLink(destination);
}

/** Mention destinations are primary-relative or absolute, never canonical selections. */
export function workspaceMentionPreviewPath(path: string, cwd: string | null | undefined) {
  return cwd ? resolvePathLinkTarget(path, cwd) : path;
}

export function workspaceFileAsset(
  scope: WorkspaceScope | undefined,
  path: string,
): AssetResource | undefined {
  return scope?.folderPath
    ? { _tag: "workspace-scope-file", scope: { ...scope, folderPath: scope.folderPath }, path }
    : undefined;
}

export function workspaceFolderProblems(folders: readonly WorkspaceScopeFolder[]) {
  return folders
    .filter((folder) => folder.status !== "ok")
    .map(
      (folder) =>
        `${folder.label}: ${folder.status === "unavailable" ? "unavailable" : "file index failed"}`,
    )
    .join(" · ");
}
