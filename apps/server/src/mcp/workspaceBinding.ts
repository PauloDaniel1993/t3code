import type { WorkspaceMcpBinding } from "@t3tools/contracts";
import {
  type ResolvedWorkspaceFolder,
  type WorkspaceProject,
  type WorkspaceThread,
  threadPrimaryPath,
} from "@t3tools/shared/workspaceFolders";

/** Format the folder resolver's current view without changing the thread's stored binding. */
export function workspaceBinding(
  thread: WorkspaceThread,
  project: WorkspaceProject & { readonly workspaceFile?: string | null | undefined },
  folders: ReadonlyArray<ResolvedWorkspaceFolder>,
): WorkspaceMcpBinding {
  return {
    cwd: threadPrimaryPath(thread, project),
    workspaceFile: project.workspaceFile ?? null,
    folders: folders.map(({ folder, label, effectivePath, checkoutRoot }) => ({
      ...folder,
      label,
      ...(checkoutRoot === undefined ? {} : { checkoutRoot }),
      availability: effectivePath === null ? "unavailable" : "available",
      effectivePath,
    })),
    ...(thread.worktrees === undefined ? {} : { worktrees: thread.worktrees }),
  };
}
