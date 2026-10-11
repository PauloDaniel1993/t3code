import { listProjectsUsingFolder } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, Project } from "@t3tools/contracts";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useProjects } from "../../state/entities";

export function WorkspaceProjectFolders(props: {
  readonly project: Project | EnvironmentProject;
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
}) {
  const projects = useProjects();
  const status = props.project.workspaceFileStatus;
  const others = projects.filter(
    (project) => project.environmentId === props.environmentId && project.id !== props.project.id,
  );
  return (
    <View className="gap-3">
      <Text selectable className="text-sm text-foreground-muted">
        {props.project.workspaceFile}
      </Text>
      <Text accessibilityRole="text" className="text-sm text-foreground-muted">
        {!props.enabled
          ? "Workspace-file support is disabled on this environment."
          : status
            ? status.state === "ok"
              ? "Up to date"
              : `Workspace file ${status.state}`
            : "Checking workspace file…"}
        {status?.liveDetection === false
          ? " · Live detection unavailable. Refresh to check for changes."
          : ""}
      </Text>
      {status?.diagnostics.map((diagnostic) => (
        <Text
          key={`${diagnostic.code}:${diagnostic.entryIndex ?? ""}:${diagnostic.path ?? ""}:${diagnostic.message}`}
          className="text-sm text-danger-foreground"
        >
          {diagnostic.message}
        </Text>
      ))}
      {status && status.state !== "ok" ? (
        <Text className="text-sm text-foreground-muted">
          New threads are blocked until the file recovers. Refresh, relink, or unlink to recover.
        </Text>
      ) : null}
      {props.project.folders?.map((folder, index) => {
        const overlaps = folder.path ? listProjectsUsingFolder(others, folder.path) : [];
        return (
          <View key={folder.path ?? folder.uri} className="gap-1">
            <Text className="font-t3-medium">
              {folder.name}
              {index === 0 ? " · Primary" : ""}
            </Text>
            <Text selectable className="text-sm text-foreground-muted">
              {folder.path ?? folder.uri}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {!props.enabled
                ? "Availability checks are disabled"
                : folder.uri
                  ? `Remote (${folder.remoteDescription ?? "remote folder"}), not available here`
                  : folder.availability === "unavailable"
                    ? index === 0
                      ? "Primary folder unavailable"
                      : folder.unavailableReason === "missing"
                        ? "Missing on disk"
                        : folder.unavailableReason === "not-directory"
                          ? "Not a folder on disk"
                          : "Unavailable"
                    : folder.availability === "available"
                      ? "Available"
                      : "Checking availability…"}
            </Text>
            {overlaps.length ? (
              <Text className="text-sm text-foreground-muted">
                This folder is also used by {overlaps.map((project) => project.title).join(", ")}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
