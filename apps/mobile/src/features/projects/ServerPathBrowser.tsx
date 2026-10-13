import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
  resolveFilesystemReadAccess,
} from "@t3tools/client-runtime/state/filesystem";
import { isWindowsPlatform } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import { Platform, View } from "react-native";
import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { environmentSession } from "../../state/session";
import { useEnvironmentPresentation } from "../../state/presentation";
import { SymbolView } from "../../components/AppSymbol";
import { ErrorBanner } from "../../components/ErrorBanner";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { ListRow, ListSection, SectionTitle } from "./AddProjectList";

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
  const environment = useEnvironmentPresentation(props.environment.environmentId);
  const session = useEnvironmentQuery(
    environmentSession.sessionStateAtom(props.environment.environmentId),
  );
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: environment.isReady,
    connection: environment.presentation?.connection ?? null,
    session: session.data,
    sessionError: session.error,
  });
  const browseState = useEnvironmentQuery(
    fileAccess.canReadFiles && browseTarget ? filesystemEnvironment.browse(browseTarget) : null,
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
    <>
      <SectionTitle>
        {props.includeWorkspaceFiles ? "Browse folders and workspace files" : "Browse folders"}
      </SectionTitle>
      {!fileAccess.canReadFiles && !fileAccess.isPending ? (
        <ErrorBanner message={fileAccess.error ?? "This connection cannot browse host folders."} />
      ) : null}
      {browseState.error ? <ErrorBanner message={browseState.error} /> : null}
      <ListSection>
        {fileAccess.isPending || (browseState.isPending && browseState.data === null) ? (
          <View className="items-center py-5">
            <AppActivityIndicator colorClassName="accent-icon-muted" />
          </View>
        ) : null}
        {browsePath.canBrowseUp ? (
          <ListRow
            title=".."
            icon={
              <SymbolView
                name="arrow.turn.left.up"
                size={Platform.OS === "android" ? 24 : 17}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
            }
            isFirst
            right={null}
            disabled={props.disabled || !fileAccess.canReadFiles}
            onPress={() => {
              if (browsePath.parentPath)
                void props.navigateToBrowsePath({ browseDirectoryPath: browsePath.parentPath });
            }}
          />
        ) : null}
        {entries.map((entry, index) => (
          <ListRow
            key={entry.fullPath}
            title={entry.name}
            icon={
              <SymbolView
                name={entry.kind === "workspace-file" ? "doc" : "folder"}
                size={Platform.OS === "android" ? 24 : 17}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
            }
            isFirst={index === 0 && !browsePath.canBrowseUp}
            right={null}
            disabled={props.disabled || !fileAccess.canReadFiles}
            onPress={() => {
              if (entry.kind === "workspace-file") props.setPathInput(entry.fullPath);
              else
                void props.navigateToBrowsePath({
                  browseDirectoryPath: browsePath.directoryPath,
                  selectedDirectoryName: entry.name,
                });
            }}
          />
        ))}
      </ListSection>
    </>
  );
}
