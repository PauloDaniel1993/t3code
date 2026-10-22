import type { EditorWorkspace } from "@t3tools/client-runtime/editor-target";
import { useEditorTarget } from "./useEditorTarget";
import type { EditorId, EnvironmentId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect } from "react";

import { usePreferredEditor } from "../../editorPreferences";
import { isOpenFavoriteEditorShortcut } from "../../keybindings";
import { useRemoteOpenState } from "../../remoteOpen";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

export function useOpenFavoriteEditorShortcut({
  enabled,
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
  editorWorkspace,
}: {
  enabled: boolean;
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  editorWorkspace?: EditorWorkspace | undefined;
}) {
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const remote = useRemoteOpenState(environmentId);
  const resolveTarget = useEditorTarget(environmentId, editorWorkspace);

  useEffect(() => {
    if (!enabled || remote.mode !== "local-exec") return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !isOpenFavoriteEditorShortcut(event, keybindings)) return;
      if (!openInCwd || !preferredEditor) return;

      event.preventDefault();
      void resolveTarget(openInCwd, preferredEditor).then((target) => {
        if (target === null) return;
        return openInEditorMutation({
          environmentId,
          input: { cwd: target, editor: preferredEditor },
        });
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    enabled,
    environmentId,
    keybindings,
    openInCwd,
    editorWorkspace,
    openInEditorMutation,
    preferredEditor,
    remote.mode,
    resolveTarget,
  ]);
}
