import type { WorkspaceScopeFolder } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

export function WorkspaceFolderPicker(props: {
  readonly folders: ReadonlyArray<WorkspaceScopeFolder>;
  readonly selectedFolderPath: string | null;
  readonly onSelectFolder: (folderPath: string | null) => void;
}) {
  if (props.folders.length <= 1) return null;
  return (
    <View className="mx-3 mb-2 gap-1 border-b border-border pb-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: props.selectedFolderPath === null }}
        className="min-h-11 justify-center rounded-xl px-2 active:bg-subtle"
        onPress={() => props.onSelectFolder(null)}
      >
        <Text className="text-sm font-t3-medium text-foreground">Search all folders</Text>
      </Pressable>
      {props.folders.map((folder) => (
        <Pressable
          key={folder.folderPath}
          accessibilityRole="button"
          accessibilityLabel={`${folder.label}, ${folder.folderPath}`}
          accessibilityState={{
            selected: props.selectedFolderPath === folder.folderPath,
            disabled: folder.status === "unavailable",
          }}
          disabled={folder.status === "unavailable"}
          className="min-h-11 flex-row items-center gap-2 rounded-xl px-2 active:bg-subtle"
          onPress={() => props.onSelectFolder(folder.folderPath)}
        >
          <SymbolView name="folder" size={16} tintColorClassName="accent-icon-muted" />
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
              {folder.label}
            </Text>
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {folder.status === "ok"
                ? folder.folderPath
                : folder.status === "unavailable"
                  ? "Folder unavailable"
                  : "File index unavailable"}
            </Text>
          </View>
          {props.selectedFolderPath === folder.folderPath ? (
            <SymbolView name="checkmark" size={14} tintColorClassName="accent-icon-muted" />
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}
