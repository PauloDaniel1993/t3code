import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import { isWindowsPlatform } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ErrorBanner } from "../../components/ErrorBanner";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";

/** Browses the selected environment's filesystem; files are selected without navigation. */
export function ServerPathBrowser(props: {
  readonly environment: { readonly environmentId: EnvironmentId; readonly platform: string };
  readonly pathInput: string;
  readonly setPathInput: (path: string) => void;
  readonly navigateToBrowsePath: (input: {
    readonly browseDirectoryPath: string;
    readonly selectedDirectoryName?: string;
  }) => Promise<boolean>;
  readonly pinnedDirectoryName?: string;
  readonly includeWorkspaceFiles?: boolean;
  readonly disabled?: boolean;
}) {
  const browsePath = getFilesystemBrowsePath(props.pathInput, props.environment.platform);
  const browseTarget = useMemo(
    () =>
      browsePath.directoryPath.length > 0
        ? {
            environmentId: props.environment.environmentId,
            input: {
              partialPath: browsePath.directoryPath,
              ...(props.includeWorkspaceFiles ? { includeWorkspaceFiles: true } : {}),
            },
          }
        : null,
    [browsePath.directoryPath, props.environment.environmentId, props.includeWorkspaceFiles],
  );
  const browseState = useEnvironmentQuery(
    browseTarget ? filesystemEnvironment.browse(browseTarget) : null,
  );
  const pinned = props.pinnedDirectoryName ?? "";
  const caseSensitive = !isWindowsPlatform(props.environment.platform);
  const pinnedMatches =
    pinned.length > 0 &&
    (caseSensitive
      ? browsePath.filterQuery === pinned
      : browsePath.filterQuery.toLowerCase() === pinned.toLowerCase());
  const entries = filterFilesystemBrowseEntries(
    browseState.data?.entries ?? [],
    pinnedMatches ? "" : browsePath.filterQuery,
    caseSensitive,
  ).visibleEntries;
  return (
    <View className="gap-3">
      <Text className="text-sm font-t3-medium text-foreground-muted">
        {props.includeWorkspaceFiles ? "Browse folders and workspace files" : "Browse folders"}
      </Text>
      {browseState.error ? <ErrorBanner message={browseState.error} /> : null}
      <View className="overflow-hidden rounded-[24px] bg-grouped-card">
        {browseState.isPending && browseState.data === null ? (
          <ActivityIndicator className="py-5" colorClassName="accent-icon-muted" />
        ) : null}
        {browsePath.canBrowseUp ? (
          <Pressable
            accessibilityRole="button"
            disabled={props.disabled}
            className="px-4 py-4 active:opacity-70"
            onPress={() => {
              if (browsePath.parentPath)
                void props.navigateToBrowsePath({ browseDirectoryPath: browsePath.parentPath });
            }}
          >
            <Text>..</Text>
          </Pressable>
        ) : null}
        {entries.map((entry) => (
          <Pressable
            key={entry.fullPath}
            accessibilityRole="button"
            accessibilityLabel={`${entry.kind === "workspace-file" ? "Select workspace file" : "Browse folder"} ${entry.name}`}
            disabled={props.disabled}
            className="flex-row items-center gap-3 border-t border-border-subtle px-4 py-4 active:opacity-70 disabled:opacity-45"
            onPress={() => {
              if (entry.kind === "workspace-file") props.setPathInput(entry.fullPath);
              else
                void props.navigateToBrowsePath({
                  browseDirectoryPath: browsePath.directoryPath,
                  selectedDirectoryName: entry.name,
                });
            }}
          >
            <SymbolView
              name={entry.kind === "workspace-file" ? "doc" : "folder"}
              size={20}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
            <Text className="min-w-0 flex-1 text-base font-t3-medium">{entry.name}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
