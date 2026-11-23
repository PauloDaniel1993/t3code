import { Select as SelectPrimitive } from "@base-ui/react/select";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { cn } from "../lib/utils";
import { namedClipboardTarget, writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { readLocalApi } from "../localApi";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent } from "react";
import { T, msg, useGT, useMessages } from "gt-react";
import { m as resolveMessage } from "../i18n/messages";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";

import { fileBasename } from "@t3tools/shared/path";

const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

interface BranchToolbarEnvModeSelectorProps {
  forceNewWorktree?: boolean;
  displayMode?: "toolbar" | "panel";
  workspaceRoot?: string | null;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel?: string | null;
  previousWorktreeBranch?: string | null;
  onUsePreviousWorktree?: () => void;
  repositoryCount?: number | undefined;
  worktreeDisabledReason?: string | undefined;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  displayMode = "toolbar",
  workspaceRoot,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  previousWorktreeBranch = null,
  onUsePreviousWorktree,
  repositoryCount,
  worktreeDisabledReason,
}: BranchToolbarEnvModeSelectorProps) {
  const gt = useGT();
  const m = useMessages();
  const workspacePath = displayMode === "panel" ? (activeWorktreePath ?? workspaceRoot) : null;
  const workspaceDisplayName = workspacePath ? fileBasename(workspacePath) : null;
  const workspaceKind = activeWorktreePath ? gt("Worktree") : gt("Project folder");
  const groupedLabel =
    repositoryCount === undefined
      ? undefined
      : worktreeDisabledReason &&
          !activeWorktreePath &&
          (effectiveEnvMode === "worktree" || forceNewWorktree)
        ? gt("Worktree unavailable")
        : gt("{workspace} · {count, plural, one {# repo} other {# repos}}", {
            workspace: activeWorktreePath
              ? gt("Worktree")
              : resolveEnvModeLabel(forceNewWorktree ? "worktree" : effectiveEnvMode, m),
            count: repositoryCount,
          });
  const composerFloatingLayerProps = useComposerMenuProps();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.workspace",
  );
  const showPreviousWorktree = Boolean(previousWorktreeLabel && onUsePreviousWorktree);
  const envModeItems = [
    {
      value: "local",
      label:
        groupedLabel && effectiveEnvMode === "local"
          ? groupedLabel
          : (workspaceDisplayName ?? resolveCurrentWorkspaceLabel(activeWorktreePath, m)),
    },
    {
      value: "worktree",
      label:
        groupedLabel && effectiveEnvMode === "worktree"
          ? groupedLabel
          : resolveEnvModeLabel("worktree", m),
    },
    ...(showPreviousWorktree && previousWorktreeLabel
      ? [{ value: PREVIOUS_WORKTREE_SELECT_VALUE, label: previousWorktreeLabel }]
      : []),
  ];

  const handleWorkspaceContextMenu = (event: ReactMouseEvent) => {
    if (!workspacePath || forceNewWorktree) return;
    const api = readLocalApi();
    if (!api) return;
    event.preventDefault();
    event.stopPropagation();
    void api.contextMenu
      .show([{ id: "copy-path", label: resolveMessage(msg("Copy full path")), icon: "copy" }], {
        x: event.clientX,
        y: event.clientY,
      })
      .then((action) => {
        if (action !== "copy-path") return;
        void writeTextToClipboard(workspacePath, namedClipboardTarget("workspace path")).then(
          (didCopy) => {
            if (didCopy) {
              toastManager.add({
                type: "success",
                title: resolveMessage(msg("Path copied")),
                description: workspacePath,
              });
            }
          },
          (error: unknown) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: resolveMessage(msg("Failed to copy path")),
                description:
                  error instanceof Error
                    ? error.message
                    : resolveMessage(msg("An error occurred.")),
              }),
            );
          },
        );
      });
  };

  const stopContextMenuMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0 || event.ctrlKey) {
      event.stopPropagation();
    }
  };

  if (envLocked || forceNewWorktree) {
    const lockedRow = (
      <span
        className={cn(
          "inline-flex h-7 min-w-0 items-center gap-1.5 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-sm sm:h-6 sm:text-xs",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
        onContextMenu={handleWorkspaceContextMenu}
        data-composer-context-control
      >
        {activeWorktreePath ? (
          <FolderGitIcon
            className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
          />
        ) : effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon
            className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
          />
        ) : (
          <FolderIcon
            className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
          />
        )}
        <ComposerContextLabel displayMode={displayMode}>
          {groupedLabel ??
            (forceNewWorktree
              ? resolveEnvModeLabel("worktree", m)
              : (workspaceDisplayName ??
                resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode, m)))}
        </ComposerContextLabel>
        {displayMode === "panel" && repositoryCount === undefined ? (
          <span className="shrink-0 text-3xs font-normal text-muted-foreground/70">
            {forceNewWorktree ? gt("Worktree") : workspaceKind}
          </span>
        ) : null}
      </span>
    );

    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup side={displayMode === "panel" ? "left" : undefined}>
          {forceNewWorktree
            ? gt("Each model starts in its own worktree.")
            : (workspacePath ??
              activeWorktreePath ??
              resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode, m))}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={effectiveEnvMode}
      onValueChange={(value: string | null) => {
        if (value === PREVIOUS_WORKTREE_SELECT_VALUE) {
          onUsePreviousWorktree?.();
          return;
        }
        if (value === "worktree" && worktreeDisabledReason) return;
        onEnvModeChange(value as EnvMode);
      }}
      items={envModeItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            displayMode === "panel" ? (
              <ThreadDetailsControl
                part="select"
                render={<SelectPrimitive.Trigger />}
                aria-label={gt("Workspace")}
                onMouseDownCapture={stopContextMenuMouseDown}
                onContextMenu={handleWorkspaceContextMenu}
              />
            ) : (
              <ComposerSelectControl
                size="xs"
                className="min-w-0 shrink"
                aria-label={gt("Workspace")}
                data-composer-shortcut="composer.workspace"
                data-composer-context-control
                onMouseDownCapture={stopContextMenuMouseDown}
              />
            )
          }
        >
          {effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon
              className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
            />
          ) : activeWorktreePath ? (
            <FolderGitIcon
              className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
            />
          ) : (
            <FolderIcon
              className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
            />
          )}
          <ComposerContextLabel displayMode={displayMode}>
            <SelectValue />
          </ComposerContextLabel>
          {displayMode === "panel" && repositoryCount === undefined ? (
            <span className="shrink-0 text-3xs font-normal text-muted-foreground/70">
              {effectiveEnvMode === "worktree" && !activeWorktreePath
                ? gt("Create")
                : workspaceKind}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side={displayMode === "panel" ? "left" : undefined}>
          {worktreeDisabledReason ??
            workspacePath ??
            (effectiveEnvMode === "worktree"
              ? resolveEnvModeLabel("worktree", m)
              : resolveCurrentWorkspaceLabel(activeWorktreePath, m))}
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup
        alignItemWithTrigger={false}
        {...composerFloatingLayerProps}
        className={showPreviousWorktree ? "w-[min(21rem,calc(100vw-2rem))]" : undefined}
      >
        <SelectGroup>
          <SelectGroupLabel>
            <T>Workspace</T>
          </SelectGroupLabel>
          <SelectItem value="local">
            <span className="inline-flex items-center gap-1.5">
              {activeWorktreePath ? (
                <FolderGitIcon
                  className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
                />
              ) : (
                <FolderIcon
                  className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
                />
              )}
              {resolveCurrentWorkspaceLabel(activeWorktreePath, m)}
            </span>
          </SelectItem>
          <SelectItem value="worktree" disabled={worktreeDisabledReason !== undefined}>
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2Icon
                className={displayMode === "panel" ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3"}
              />
              {resolveEnvModeLabel("worktree", m)}
            </span>
          </SelectItem>
          {worktreeDisabledReason ? (
            <p className="px-3 py-1 text-2xs text-muted-foreground">{worktreeDisabledReason}</p>
          ) : null}
          {showPreviousWorktree && previousWorktreeLabel ? (
            <SelectItem value={PREVIOUS_WORKTREE_SELECT_VALUE}>
              <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
