import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { environmentSession } from "../../state/session";
import type { EnvironmentId, WorkspaceScope } from "@t3tools/contracts";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useState } from "react";
import { SheetPane } from "../../components/ui/SheetPane";

import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { FileTreeBrowser } from "./FileTreeBrowser";
import { useFileTreeEntries } from "./useFileTreeEntries";
import { preloadWorkspaceFileContents } from "./preload-workspace-file";
import { WorkspaceFolderPicker } from "./WorkspaceFolderPicker";
import { workspaceFileCacheKey } from "../../lib/workspaceFiles";

export function ThreadFileNavigatorPane(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly scope?: WorkspaceScope | null;
  readonly projectName: string;
  readonly selectedPath: string | null;
  readonly onSelectFile: (path: string, folderPath?: string) => void;
}) {
  const workspaceKey = workspaceFileCacheKey(props);
  // The pane stays mounted across thread switches; a query only filters the workspace it was typed in.
  const [search, setSearch] = useState({ workspaceKey, query: "" });
  const searchQuery = search.workspaceKey === workspaceKey ? search.query : "";
  const setSearchQuery = (query: string) => setSearch({ workspaceKey, query });
  const { themeAppearance: highlightTheme } = useAppearancePreferences();
  const fileAccessSession = useEnvironmentQuery(
    environmentSession.sessionStateAtom(props.environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(props.environmentId);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const { canReadFiles } = fileAccess;
  const entriesQuery = useFileTreeEntries({
    environmentId: props.environmentId,
    cwd: canReadFiles ? props.cwd : null,
    scope: canReadFiles ? (props.scope ?? null) : null,
    searchQuery,
  });
  const handlePreviewFile = (relativePath: string) => {
    const scope = entriesQuery.scopeForPath(relativePath);
    if (props.scope && scope === null) return;
    preloadWorkspaceFileContents({
      cwd: props.cwd,
      environmentId: props.environmentId,
      relativePath,
      scope,
      theme: highlightTheme,
    });
  };
  const fileTree = (
    <FileTreeBrowser
      key={`${workspaceFileCacheKey(props)}:${entriesQuery.rootDirectoryPath}`}
      rootDirectoryPath={entriesQuery.rootDirectoryPath}
      chooseFolder={
        entriesQuery.folders.length > 1 &&
        entriesQuery.selectedFolderPath === null &&
        !searchQuery.trim()
      }
      folderPicker={
        <WorkspaceFolderPicker
          folders={entriesQuery.folders}
          selectedFolderPath={entriesQuery.selectedFolderPath}
          onSelectFolder={entriesQuery.selectFolder}
        />
      }
      revealSelection={entriesQuery.revealSelection}
      expandedPaths={entriesQuery.expandedPaths}
      setExpandedPaths={entriesQuery.setExpandedPaths}
      entries={entriesQuery.entries}
      loadingDirectories={entriesQuery.loadingDirectories}
      onLoadDirectory={entriesQuery.loadDirectory}
      error={
        canReadFiles
          ? entriesQuery.error
          : fileAccess.isPending
            ? null
            : (fileAccess.error ?? "This connection cannot read host files.")
      }
      isPending={fileAccess.isPending || entriesQuery.isPending}
      isRefreshing={entriesQuery.isRefreshing}
      searchQuery={searchQuery}
      searchResultPaths={entriesQuery.searchResultPaths}
      searchTruncated={entriesQuery.searchTruncated}
      selectedPath={props.selectedPath ?? entriesQuery.selectedPath}
      onPreviewFile={handlePreviewFile}
      onRefresh={entriesQuery.refresh}
      onSelectFile={(path) => {
        entriesQuery.selectPath(path);
        props.onSelectFile(path, entriesQuery.scopeForPath(path)?.folderPath);
      }}
    />
  );

  return (
    <SheetPane>
      <AppBar
        title="Files"
        subtitle={props.projectName}
        search={{
          value: searchQuery,
          onChangeText: setSearchQuery,
          placeholder: "Search files",
        }}
        refresh={{ accessibilityLabel: "Refresh files", onPress: entriesQuery.refresh }}
      />
      <ScreenContent insetHorizontal>{fileTree}</ScreenContent>
    </SheetPane>
  );
}
