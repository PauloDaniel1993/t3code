import type {
  AssetResource,
  EnvironmentId,
  ProjectId,
  ProjectReadFileInput,
  ThreadId,
  WorkspaceScope,
  WorkspaceScopeFolder,
} from "@t3tools/contracts";
import { parseCanonicalPath } from "@t3tools/shared/workspaceFolders";

import { isWindowsAbsolutePath } from "@t3tools/shared/path";

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || isWindowsAbsolutePath(path);
}

/** Scoped inputs are offered only by capable peers and only for workspace-file bindings. */
export function workspaceFileScope(input: {
  readonly enabled: boolean;
  readonly project: { readonly id: ProjectId; readonly workspaceFile?: string | null } | null;
  readonly thread?: {
    readonly id: ThreadId;
    readonly workspaceFolderCount?: number;
    readonly workspacePrimaryPath?: string;
  } | null;
}): WorkspaceScope | null {
  if (
    !input.enabled ||
    input.project === null ||
    (!input.project.workspaceFile &&
      input.thread?.workspaceFolderCount === undefined &&
      input.thread?.workspacePrimaryPath === undefined)
  ) {
    return null;
  }
  return {
    projectId: input.project.id,
    ...(input.thread ? { threadId: input.thread.id } : {}),
  };
}

/** Pin the result's owner, including results remapped out of a containing folder. */
export function pinWorkspaceFileScope(
  scope: WorkspaceScope,
  path: string,
  folders: ReadonlyArray<WorkspaceScopeFolder>,
): WorkspaceScope | null {
  const parsed = parseCanonicalPath(path, folders);
  return parsed === null ? null : { ...scope, folderPath: parsed.folder.folderPath };
}

export function workspaceFileReadInput(
  cwd: string,
  path: string,
  scope: WorkspaceScope | null,
): ProjectReadFileInput {
  // Absolute host files retain their existing read-only route.
  return scope !== null && !isAbsolutePath(path) ? { scope, path } : { cwd, relativePath: path };
}

export function workspaceFileCacheKey(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly scope?: WorkspaceScope | null;
  readonly relativePath?: string | null;
}): string {
  return JSON.stringify([
    input.environmentId,
    input.scope ? [input.scope.projectId, input.scope.threadId, input.scope.folderPath] : input.cwd,
    input.relativePath,
  ]);
}

export function scopedWorkspaceFileResource(
  scope: WorkspaceScope | null,
  path: string,
): Extract<AssetResource, { readonly _tag: "workspace-scope-file" }> | null {
  return scope?.folderPath === undefined || isAbsolutePath(path)
    ? null
    : {
        _tag: "workspace-scope-file",
        scope: { ...scope, folderPath: scope.folderPath },
        path,
      };
}

export function workspaceFolderErrors(folders: ReadonlyArray<WorkspaceScopeFolder>): string | null {
  const failed = folders.filter((folder) => folder.status !== "ok");
  return failed.length === 0
    ? null
    : failed
        .map((folder) =>
          folder.status === "unavailable"
            ? `${folder.label}: folder unavailable`
            : `${folder.label}: file index unavailable`,
        )
        .join(". ");
}
