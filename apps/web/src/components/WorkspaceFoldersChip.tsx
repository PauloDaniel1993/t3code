import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { ChevronDownIcon, FolderIcon } from "lucide-react";
import { useProject, useThreadProjection } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useDiffPanelStore } from "../diffPanelStore";
import { useRightPanelStore } from "../rightPanelStore";
import { WorkspaceFolderGroups } from "./WorkspaceFolderGroups";
import { workspaceFolderChipCount, workspaceFolderRows } from "./workspaceFolders.logic";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover";

interface WorkspaceFoldersChipProps {
  projectRef: ScopedProjectRef;
  threadRef?: ScopedThreadRef | undefined;
  workspaceFolderCount?: number | undefined;
  onOpenThread?: ((ref: ScopedThreadRef) => void) | undefined;
}

function WorkspaceFoldersChipContents(props: WorkspaceFoldersChipProps) {
  const project = useProject(props.projectRef);
  const detail = useThreadProjection(props.threadRef ?? null)?.projection;
  const config = useAtomValue(serverEnvironment.configValueAtom(props.projectRef.environmentId));
  if (!project || (props.threadRef && !detail))
    return <p className="px-2 py-3 text-xs text-muted-foreground">Loading workspace folders…</p>;
  const rows = workspaceFolderRows(
    project,
    detail?.thread ?? null,
    detail?.runs.at(-1)?.unavailableFolderPaths,
  );
  return (
    <>
      <PopoverTitle>Workspace folders</PopoverTitle>
      <p className="mt-1 text-2xs text-muted-foreground">
        {rows.length} folders · primary folder starts the thread
      </p>
      <WorkspaceFolderGroups
        environmentId={props.projectRef.environmentId}
        rows={rows}
        availableEditors={config?.availableEditors ?? []}
        keybindings={config?.keybindings ?? []}
        onShowChanges={
          props.threadRef
            ? (folder) => {
                const ref = props.threadRef!;
                if (!folder.folder.path) return;
                useDiffPanelStore
                  .getState()
                  .selectWorkspaceFolder(ref, folder.folder.path, folder.label);
                useRightPanelStore.getState().open(ref, "diff");
                props.onOpenThread?.(ref);
              }
            : undefined
        }
      />
    </>
  );
}

export function WorkspaceFoldersChip(props: WorkspaceFoldersChipProps) {
  const [open, setOpen] = useState(false);
  const project = useProject(props.threadRef ? null : props.projectRef);
  const config = useAtomValue(serverEnvironment.configValueAtom(props.projectRef.environmentId));
  const count = workspaceFolderChipCount(props.threadRef ? props : null, project);
  if (count < 2 || config?.workspaceFileProjects !== true) return null;
  return (
    <span
      data-thread-selection-safe
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={`Workspace folders (${count})`}
              className="inline-flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            />
          }
        >
          <FolderIcon aria-hidden className="size-3" />
          <span>{count}</span>
          <ChevronDownIcon aria-hidden className="size-2.5" />
        </PopoverTrigger>
        <PopoverPopup width="md" padding="compact" align="start">
          {open ? <WorkspaceFoldersChipContents {...props} /> : null}
        </PopoverPopup>
      </Popover>
    </span>
  );
}
