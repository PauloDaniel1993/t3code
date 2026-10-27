import { resolveEditorTarget, type EditorWorkspace } from "@t3tools/client-runtime/editor-target";
import type { EditorId, EnvironmentId } from "@t3tools/contracts";

import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

export function useEditorTarget(environmentId: EnvironmentId, workspace?: EditorWorkspace) {
  const generateWorkspace = useAtomCommand(
    shellEnvironment.editorWorkspaceFile,
    "prepare editor workspace",
  );
  const workspaceFile = workspace?.workspaceFile;
  const worktreePath = workspace?.worktreePath;
  const worktreeThreadId = workspace?.worktreeThreadId;

  return async (cwd: string, editor: EditorId) => {
    const target = resolveEditorTarget({
      cwd,
      editor,
      workspaceFile,
      worktreePath,
      worktreeThreadId,
    });
    if ("cwd" in target) return target.cwd;
    const result = await generateWorkspace({ environmentId, input: target });
    return result._tag === "Success" ? result.value : null;
  };
}
