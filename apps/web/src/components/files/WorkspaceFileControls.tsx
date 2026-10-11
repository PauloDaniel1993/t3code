import type { WorkspaceScopeFolder } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { workspaceFolderProblems, type WorkspaceFileContext } from "./workspaceFiles";

export function WorkspaceFolderPicker(props: {
  readonly workspace?: WorkspaceFileContext | undefined;
  readonly value: string | undefined;
  readonly onChange: (folderPath: string | undefined) => void;
}) {
  if (!props.workspace || props.workspace.folders.length < 2) return null;
  const folders = props.workspace.folders;
  const selected = folders.find(
    (folder) => (folder.folder.path ?? folder.folder.uri) === props.value,
  );
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="xs" aria-label="Search workspace folder" />}
      >
        {selected?.label ?? "All folders"}
      </MenuTrigger>
      <MenuPopup>
        <MenuRadioGroup
          value={props.value ?? ""}
          onValueChange={(value) => props.onChange(value || undefined)}
        >
          <MenuRadioItem value="">All folders</MenuRadioItem>
          {folders.map((folder) => (
            <MenuRadioItem key={folder.label} value={folder.folder.path ?? folder.folder.uri!}>
              {folder.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

export function WorkspaceFolderStatus(props: {
  readonly folders: readonly WorkspaceScopeFolder[];
}) {
  const message = workspaceFolderProblems(props.folders);
  return message ? (
    <p role="status" className="px-3 py-1 text-xs text-warning-foreground">
      {message}
    </p>
  ) : null;
}
