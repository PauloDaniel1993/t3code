import type { EditorId, EnvironmentId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { buildRemoteOpenUrl } from "@t3tools/contracts";
import type { EditorWorkspace } from "@t3tools/client-runtime/editor-target";
import { useEffect } from "react";

import { usePreferredEditor } from "../../editorPreferences";
import { isOpenFavoriteEditorShortcut } from "../../keybindings";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { openRemoteEditorUrl, useRemoteCapableEditors, useRemoteOpenState } from "../../remoteOpen";
import { useEditorTarget } from "./useEditorTarget";

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
  const remote = useRemoteOpenState(environmentId);
  const remoteEditors = useRemoteCapableEditors();
  const [preferredEditor] = usePreferredEditor(
    remote.mode === "local-exec" ? availableEditors : remoteEditors,
  );
  const resolveTarget = useEditorTarget(environmentId, editorWorkspace);

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(event, keybindings)) return;
      if (!openInCwd || !preferredEditor) return;

      event.preventDefault();
      void (async () => {
        if (remote.mode === "remote-unavailable") return;
        const target = await resolveTarget(openInCwd, preferredEditor);
        if (target === null) return;
        if (remote.mode === "remote-links") {
          const url = buildRemoteOpenUrl({
            editor: preferredEditor,
            host: remote.host.host,
            absolutePath: target,
          });
          if (url !== undefined) await openRemoteEditorUrl(url);
          return;
        }
        await openInEditorMutation({
          environmentId,
          input: { cwd: target, editor: preferredEditor },
        });
      })();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    enabled,
    environmentId,
    keybindings,
    openInCwd,
    openInEditorMutation,
    preferredEditor,
    remote,
    resolveTarget,
  ]);
}
