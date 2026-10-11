import { resolvePathLinkTarget } from "~/terminal-links";
import { workspaceFileReference, type WorkspaceFileContext } from "../files/workspaceFiles";

/** Keep a choice by folder identity; a removed draft folder returns to the primary. */
export function selectedStarMapFolder(
  workspace: WorkspaceFileContext | undefined,
  folderPath: string | null,
) {
  return (
    workspace?.folders.find((folder) => (folder.folder.path ?? folder.folder.uri) === folderPath) ??
    workspace?.folders[0]
  );
}

/** File tabs use canonical paths and pins; map subscription paths remain relative to their cwd. */
export function starMapFileTarget(
  path: string,
  cwd: string,
  workspace: WorkspaceFileContext | undefined,
) {
  if (!workspace) return { path, folderPath: undefined };
  const reference = workspaceFileReference(workspace, resolvePathLinkTarget(path, cwd));
  return reference ? { path: reference.canonicalPath, folderPath: reference.folderPath } : null;
}

/** Tasks run in the thread's primary cwd, so secondary-folder sources need a concrete path. */
export function starMapTaskSourcePath(
  path: string,
  cwd: string,
  workspace: WorkspaceFileContext | undefined,
) {
  const reference = workspaceFileReference(workspace, resolvePathLinkTarget(path, cwd));
  return reference
    ? reference.folder.isPrimary
      ? reference.relativePath
      : reference.absolutePath!
    : path;
}
