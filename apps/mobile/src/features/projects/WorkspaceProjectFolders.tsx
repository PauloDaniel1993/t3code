import { listProjectsUsingFolder } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, Project } from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useProjects } from "../../state/entities";

export function WorkspaceProjectFolders(props: {
  readonly project: Project | EnvironmentProject;
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
}) {
  const gt = useGT();
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
          ? gt("Workspace-file support is disabled on this environment.")
          : status
            ? status.state === "ok"
              ? gt("Up to date")
              : gt("Workspace file {state}", { state: status.state })
            : gt("Checking workspace file…")}
        {status?.liveDetection === false
          ? gt(" · Live detection unavailable. Refresh to check for changes.")
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
          <T>
            New threads are blocked until the file recovers. Refresh, relink, or unlink to recover.
          </T>
        </Text>
      ) : null}
      {props.project.folders?.map((folder, index) => {
        const overlaps = folder.path ? listProjectsUsingFolder(others, folder.path) : [];
        return (
          <View key={folder.path ?? folder.uri} className="gap-1">
            <Text className="font-t3-medium">
              {folder.name}
              {index === 0 ? gt(" · Primary") : ""}
            </Text>
            <Text selectable className="text-sm text-foreground-muted">
              {folder.path ?? folder.uri}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {!props.enabled
                ? gt("Availability checks are disabled")
                : folder.uri
                  ? gt("Remote ({description}), not available here", {
                      description: folder.remoteDescription ?? gt("remote folder"),
                    })
                  : folder.availability === "unavailable"
                    ? index === 0
                      ? gt("Primary folder unavailable")
                      : folder.unavailableReason === "missing"
                        ? gt("Missing on disk")
                        : folder.unavailableReason === "not-directory"
                          ? gt("Not a folder on disk")
                          : gt("Unavailable")
                    : folder.availability === "available"
                      ? gt("Available")
                      : gt("Checking availability…")}
            </Text>
            {overlaps.length ? (
              <Text className="text-sm text-foreground-muted">
                {gt("This folder is also used by {projects}", {
                  projects: overlaps.map((project) => project.title).join(", "),
                })}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
