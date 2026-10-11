import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { isSamePath, owningFolder } from "@t3tools/shared/workspaceFolders";
import { useMemo, useState } from "react";
import { FlatList, Platform, Pressable, View } from "react-native";
import { AppText as Text } from "../../../components/AppText";
import { AndroidScreenHeader } from "../../../components/AndroidScreenHeader";
import { useThreadWorkspace, useWorkspaceGitQueries } from "../use-thread-workspace";
import { useEnvironmentQuery } from "../../../state/query";
import { reviewEnvironment } from "../../../state/review";
import { workspaceGitSummary } from "./workspace-git-model";

type ChangedFile = ReturnType<typeof workspaceGitSummary>["files"][number];

/** Patches load only for expanded files, with the environment and checkout in the cache key. */
function ChangedFileRow(props: { readonly target: ScopedThreadRef; readonly file: ChangedFile }) {
  const [expanded, setExpanded] = useState(false);
  const { file } = props;
  const patch = useEnvironmentQuery(
    expanded
      ? reviewEnvironment.diffPreview({
          environmentId: props.target.environmentId,
          input: {
            cwd: file.checkout.cwd,
            file: { path: file.path, previousPath: null, sourceKind: "working-tree" },
          },
        })
      : null,
  );
  const source = patch.data?.sources.find((source) => source.kind === "working-tree");
  return (
    <View className="border-b border-border py-2">
      <Pressable
        className="min-h-12 justify-center"
        accessibilityRole="button"
        accessibilityLabel={`Show diff for ${file.displayPath}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <Text className="font-t3-medium">{file.displayPath}</Text>
        <Text className="text-xs text-foreground-muted">
          +{file.insertions} / −{file.deletions}
          {file.folderLabel === null ? " · Outside workspace folders" : ""}
        </Text>
      </Pressable>
      {expanded ? (
        <Text selectable className="text-xs font-t3-mono">
          {patch.error ?? source?.diff ?? "Loading diff…"}
          {source?.truncated ? "\nPreview exceeds the size limit." : ""}
        </Text>
      ) : null}
    </View>
  );
}

export function WorkspaceChangesSheet({
  route,
}: StaticScreenProps<ScopedThreadRef & { readonly folderPath?: string }>) {
  const navigation = useNavigation();
  const workspace = useThreadWorkspace(route.params);
  const selectedFolder = route.params.folderPath
    ? workspace.rows.find(
        (row) => row.folder.path && isSamePath(row.folder.path, route.params.folderPath!),
      )
    : null;
  const checkouts = useMemo(() => {
    if (!route.params.folderPath) return workspace.checkouts;
    if (!selectedFolder?.isGit || !selectedFolder.effectivePath) return [];
    const checkout = owningFolder(
      selectedFolder.diffPath ?? selectedFolder.effectivePath,
      workspace.checkouts.map((candidate) => ({ ...candidate, path: candidate.root })),
    );
    return checkout ? [checkout] : [];
  }, [route.params.folderPath, selectedFolder, workspace.checkouts]);
  const queries = useWorkspaceGitQueries(route.params, checkouts);
  const statuses = queries.map((query) => query.status);
  const loading = queries.some((query) => !query.error && query.status === null);
  const summary = workspaceGitSummary(checkouts, statuses, workspace.rows, workspace.checkouts);
  const files = selectedFolder
    ? summary.files.filter((file) => file.folderLabel === selectedFolder.label)
    : summary.files;
  return (
    <View className="flex-1 bg-screen">
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={selectedFolder ? `${selectedFolder.folder.name} changes` : "Workspace changes"}
          onBack={() => navigation.goBack()}
        />
      ) : null}
      <FlatList
        data={files}
        keyExtractor={(file) => JSON.stringify([file.checkout.cwd, file.path])}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        renderItem={({ item }) => (
          <ChangedFileRow
            key={JSON.stringify([item.checkout.cwd, item.path])}
            target={route.params}
            file={item}
          />
        )}
        ListEmptyComponent={
          <Text className="p-4 text-foreground-muted">
            {!workspace.thread
              ? "Loading workspace…"
              : loading
                ? "Loading changes…"
                : !summary.known
                  ? "Repository status unavailable. Refresh Version Control and try again."
                  : selectedFolder?.unavailable
                    ? selectedFolder.reason
                    : "No working tree changes"}
          </Text>
        }
      />
    </View>
  );
}
