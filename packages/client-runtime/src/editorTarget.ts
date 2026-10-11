import type { EditorId, ThreadId } from "@t3tools/contracts";

const WORKSPACE_FILE_EDITORS = new Set<EditorId>([
  "cursor",
  "trae",
  "kiro",
  "vscode",
  "vscode-insiders",
  "vscodium",
  "antigravity",
]);

/** Context for opening the whole workspace; folder and file opens omit it. */
export interface EditorWorkspace {
  readonly workspaceFile?: string | null | undefined;
  readonly worktreeThreadId?: ThreadId | undefined;
}

/** Worktree targets must be generated on the owning environment before opening, including over SSH. */
export function resolveEditorTarget(
  input: EditorWorkspace & {
    readonly cwd: string;
    readonly editor: EditorId;
  },
): { readonly cwd: string } | { readonly threadId: ThreadId } {
  if (WORKSPACE_FILE_EDITORS.has(input.editor)) {
    if (input.worktreeThreadId !== undefined) return { threadId: input.worktreeThreadId };
    if (input.workspaceFile != null) return { cwd: input.workspaceFile };
  }
  return { cwd: input.cwd };
}
