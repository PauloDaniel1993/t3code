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
} from "@t3tools/shared/workspaceFolders";
import { isAbsolutePath, resolvePathLinkTarget } from "~/terminal-links";

export interface WorkspaceFileContext {
  readonly scope: WorkspaceScope;
  readonly folders: ReturnType<typeof resolveThreadWorkspace>["folders"];
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
  if (!enabled || (!thread?.workspaceFolders && !project.workspaceFile)) return undefined;
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

export function workspaceFileScopeKey(cwd: string, scope?: WorkspaceScope): string {
  return scope
    ? JSON.stringify([scope.projectId, scope.threadId ?? null, scope.folderPath ?? null])
    : cwd;
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
export function workspaceFileMention(context: WorkspaceFileContext | undefined, path: string) {
  const reference = workspaceFileReference(context, path);
  if (!context) return serializeComposerFileLink(path);
  if (!reference || reference.absolutePath === null) return null;
  const destination = reference.folder.isPrimary
    ? reference.relativePath || "."
    : reference.absolutePath;
  const link = serializeComposerFileLink(destination);
  if (reference.folder.isPrimary) return link;
  const label = reference.canonicalPath
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
  return `[${label}${link.slice(link.indexOf("]("))}`;
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
