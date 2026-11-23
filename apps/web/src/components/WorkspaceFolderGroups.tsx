import type { EditorId, EnvironmentId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useState } from "react";
import { T, useGT } from "gt-react";
import {
  ChevronRightIcon,
  CopyIcon,
  EllipsisIcon,
  FileDiffIcon,
  FolderIcon,
  GitBranchIcon,
  TerminalIcon,
} from "lucide-react";
import { namedClipboardTarget, useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { cn } from "../lib/utils";
import { OpenInPicker } from "./chat/OpenInPicker";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { type WorkspaceFolderRow, workspaceRepositoryCount } from "./workspaceFolders.logic";

interface WorkspaceFolderGroupsProps {
  environmentId: EnvironmentId;
  rows: ReadonlyArray<WorkspaceFolderRow>;
  availableEditors: ReadonlyArray<EditorId>;
  keybindings: ResolvedKeybindingsConfig;
  onShowChanges?: ((folder: WorkspaceFolderRow) => void) | undefined;
  onOpenTerminalHere?: ((folderPath: string) => void) | undefined;
}

function WorkspaceFolderRowView({
  row,
  ...props
}: Omit<WorkspaceFolderGroupsProps, "rows"> & { row: WorkspaceFolderRow }) {
  const gt = useGT();
  const status = useEnvironmentQuery(
    row.isGit && row.branchCwd
      ? vcsEnvironment.branchStatus({
          environmentId: props.environmentId,
          input: { cwd: row.branchCwd },
        })
      : null,
  );
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget("workspace folder path"),
  });
  const subline = row.unavailable
    ? row.isPrimary
      ? gt("{reason} · blocks this thread", { reason: String(row.reason) })
      : gt("{reason} · skipped", { reason: String(row.reason) })
    : row.isGit
      ? gt("{branch} · {checkout}", {
          branch:
            status.data?.refName ??
            (status.error
              ? gt("Status unavailable")
              : status.data
                ? gt("Detached HEAD")
                : gt("Loading branch…")),
          checkout: row.isWorktree ? gt("Worktree") : gt("Current checkout"),
        })
      : !row.vcsKnown
        ? gt("Folder status not available")
        : gt("Shared · not checkpointed");
  return (
    <div className="ml-3 flex min-w-0 items-center gap-2 border-l border-border/60 py-1.5 pl-3">
      <Tooltip>
        <TooltipTrigger render={<div className="min-w-0 flex-1" />}>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-medium">{row.folder.name}</span>
            {row.isPrimary ? (
              <span className="shrink-0 rounded bg-muted px-1 text-3xs text-muted-foreground">
                <T context="adjective, describes the primary workspace folder">Primary</T>
              </span>
            ) : null}
          </div>
          <p
            className={cn(
              "truncate text-2xs",
              row.unavailable ? "text-warning" : "text-muted-foreground",
            )}
          >
            {subline}
          </p>
        </TooltipTrigger>
        <TooltipPopup>{row.path}</TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={gt("Actions for {folder}", { folder: row.folder.name })}
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup>
          {row.unavailable ? (
            <MenuItem disabled>
              <T>Open in…</T>
            </MenuItem>
          ) : (
            <OpenInPicker
              environmentId={props.environmentId}
              availableEditors={props.availableEditors}
              keybindings={props.keybindings}
              openInCwd={row.effectivePath}
              presentation="menu"
              enableShortcut={false}
            />
          )}
          <MenuItem onClick={() => copyToClipboard(row.path, undefined)}>
            <CopyIcon className="size-4" />
            {isCopied ? gt("Path copied") : gt("Copy path")}
          </MenuItem>
          <MenuItem
            disabled={!row.isGit || !props.onShowChanges}
            onClick={() => props.onShowChanges?.(row)}
          >
            <FileDiffIcon className="size-4" />
            <T>Show changes for this folder</T>
          </MenuItem>
          {props.onOpenTerminalHere ? (
            <MenuItem
              disabled={row.unavailable || !row.folder.path}
              onClick={() => {
                if (row.folder.path) props.onOpenTerminalHere?.(row.folder.path);
              }}
            >
              <TerminalIcon className="size-4" />
              <T>Open terminal here</T>
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
}

function WorkspaceFolderGroup({
  isGit,
  count,
  rows,
  ...props
}: WorkspaceFolderGroupsProps & { isGit: boolean; count: number }) {
  const gt = useGT();
  const [open, setOpen] = useState(true);
  if (rows.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-2 text-left text-2xs font-medium text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon className={cn("size-3", open && "rotate-90")} />
        {isGit ? <GitBranchIcon className="size-3" /> : <FolderIcon className="size-3" />}
        {isGit
          ? gt("Git repositories · {count}", { count })
          : gt("Other folders · {count}", { count })}
      </button>
      {open
        ? rows.map((row) => <WorkspaceFolderRowView key={row.label} row={row} {...props} />)
        : null}
    </div>
  );
}

/** Mounted only by an open chip or visible details card; collapsed rows release VCS leases. */
export function WorkspaceFolderGroups(props: WorkspaceFolderGroupsProps) {
  const git = props.rows.filter((row) => row.isGit);
  const other = props.rows.filter((row) => !row.isGit);
  return (
    <div className="px-2 py-1">
      <WorkspaceFolderGroup {...props} rows={git} isGit count={workspaceRepositoryCount(git)} />
      <WorkspaceFolderGroup {...props} rows={other} isGit={false} count={other.length} />
    </div>
  );
}
