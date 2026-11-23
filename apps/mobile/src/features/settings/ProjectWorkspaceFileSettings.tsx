import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
} from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Alert, View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { ServerPathBrowser } from "../projects/ServerPathBrowser";
import { WorkspaceProjectFolders } from "../projects/WorkspaceProjectFolders";
import {
  workspaceFileActionError,
  workspaceFileMutationOutcome,
} from "../projects/workspace-file-projects";
import { resolveAddProjectPath } from "@t3tools/client-runtime/operations/projects";
import type { SettingsTarget } from "./settings-environment-filter";

/** Link controls belong to one physical project, even in a cross-environment group. */
export function ProjectWorkspaceFileSettings(props: {
  readonly project: EnvironmentProject;
  readonly environment: SettingsTarget;
}) {
  const gt = useGT();
  const m = useMessages();
  const { project, environment } = props;
  const enabled = environment.serverConfig.workspaceFileProjects === true;
  const linked = project.workspaceFile != null;
  const platform = environment.serverConfig.environment.platform.os === "windows" ? "Win32" : "";
  const [picking, setPicking] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  if (!linked && !enabled) return null;

  const changeLink = async (workspaceFilePath: string | null) => {
    if (busy || (workspaceFilePath !== null && !enabled)) return;
    setBusy(true);
    setError(null);
    const error = await workspaceFileActionError(async () => {
      const result = await update({
        environmentId: project.environmentId,
        input: { projectId: project.id, workspaceFilePath },
      });
      workspaceFileMutationOutcome(result, false);
      setPicking(false);
    });
    if (error !== null) setError(error);
    setBusy(false);
  };
  const choosePath = () => {
    const resolved = resolveAddProjectPath(
      {
        rawPath: path,
        currentProjectCwd: project.workspaceRoot,
        platform,
      },
      m,
    );
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }
    void changeLink(resolved.path);
  };
  const startPicker = () => {
    setPath(project.workspaceFile ?? ensureBrowseDirectoryPath(project.workspaceRoot));
    setError(null);
    setPicking(true);
  };
  return (
    <View className="gap-3 pt-3">
      {linked ? (
        <WorkspaceProjectFolders
          project={project}
          environmentId={project.environmentId}
          enabled={enabled}
        />
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
      <View className="flex-row flex-wrap gap-2">
        {linked ? (
          <Button
            label={gt("Refresh")}
            disabled={busy || !enabled}
            onPress={() => void changeLink(project.workspaceFile!)}
          />
        ) : null}
        {enabled ? (
          <Button
            label={linked ? gt("Relink…") : gt("Link workspace file…")}
            disabled={busy}
            onPress={startPicker}
          />
        ) : null}
        {linked ? (
          <Button
            label={gt("Unlink workspace file")}
            disabled={busy}
            tone="text"
            onPress={() =>
              Alert.alert(
                gt("Unlink workspace file?"),
                gt(
                  "Future threads use only the primary folder. Existing threads keep their folders, and conversation history is kept.",
                ),
                [
                  { text: gt("Cancel"), style: "cancel" },
                  { text: gt("Unlink"), onPress: () => void changeLink(null) },
                ],
              )
            }
          />
        ) : null}
      </View>
      {busy ? (
        <Text className="text-sm text-foreground-muted">
          <T>Updating workspace file…</T>
        </Text>
      ) : null}
      {picking && enabled ? (
        <View className="gap-3">
          <Text className="text-sm text-foreground-muted">
            {gt("Workspace file path on {environment}", { environment: environment.label })}
          </Text>
          <AppTextInput
            accessibilityLabel={gt("Workspace file path on environment")}
            value={path}
            editable={!busy}
            onChangeText={setPath}
            autoCapitalize="none"
            autoCorrect={false}
            className="min-h-12 rounded-xl bg-card px-3 text-base text-foreground"
            onSubmitEditing={choosePath}
          />
          <ServerPathBrowser
            environment={{ environmentId: project.environmentId, platform }}
            pathInput={path}
            setPathInput={setPath}
            includeWorkspaceFiles
            disabled={busy}
            navigateToBrowsePath={async (input) => {
              setPath(
                input.selectedDirectoryName
                  ? appendBrowsePathSegment(input.browseDirectoryPath, input.selectedDirectoryName)
                  : input.browseDirectoryPath,
              );
              return true;
            }}
          />
          <View className="flex-row gap-2">
            <Button
              label={linked ? gt("Relink workspace file") : gt("Link workspace file")}
              disabled={busy || !path.trim()}
              onPress={choosePath}
            />
            <Button
              label={gt("Cancel")}
              disabled={busy}
              tone="text"
              onPress={() => setPicking(false)}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}
