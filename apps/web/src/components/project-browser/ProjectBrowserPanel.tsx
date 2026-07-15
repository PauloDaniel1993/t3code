"use client";

import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { Globe2, PinOff, Plus, X } from "lucide-react";
import {
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";

import { applyPreviewServerSnapshot, useThreadPreviewState } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useThreadShells } from "~/state/entities";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { cn } from "~/lib/utils";
import {
  PROJECT_BROWSER_MAX_WIDTH,
  PROJECT_BROWSER_MIN_WIDTH,
  clampProjectBrowserWidth,
  type ProjectBrowserTabActivity,
  type ProjectBrowserTab,
} from "~/projectBrowserState";
import {
  selectProjectBrowserLayout,
  selectProjectBrowserRuntime,
  useProjectBrowserStore,
} from "~/projectBrowserStore";
import { readActiveBrowserRecordingTabId, stopBrowserRecording } from "~/browser/browserRecording";
import { cancelAndDrainProjectBrowserOperations } from "~/projectBrowserAutomation";
import {
  projectBrowserCloseNeedsConfirmation,
  unpinProjectBrowserTabToOrigin,
} from "~/projectBrowserWorkflows";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { PreviewPanel } from "~/components/preview/PreviewPanel";

interface Props {
  readonly logicalProjectKey: string;
  readonly activeThreadRef: ScopedThreadRef;
  readonly activePhysicalProjectKey: string;
  readonly configuredUrls?: readonly string[] | undefined;
  readonly overlay: boolean;
}

function snapshotTitle(snapshot: PreviewSessionSnapshot | null): string {
  if (!snapshot || snapshot.navStatus._tag === "Idle") return "Browser";
  if (snapshot.navStatus.title.trim()) return snapshot.navStatus.title;
  try {
    return new URL(snapshot.navStatus.url).host || "Browser";
  } catch {
    return "Browser";
  }
}

function TabFavicon({ snapshot }: { readonly snapshot: PreviewSessionSnapshot | null }) {
  const url = snapshot?.navStatus._tag === "Idle" ? null : (snapshot?.navStatus.url ?? null);
  const favicon = faviconUrlForOrigin(url, 32);
  const [failed, setFailed] = useState(false);
  if (!favicon || failed) return <Globe2 className="size-3.5 shrink-0" />;
  return (
    <img
      alt=""
      aria-hidden
      draggable={false}
      src={favicon}
      className="size-3.5 shrink-0 rounded-sm"
      onError={() => setFailed(true)}
    />
  );
}

function ProjectBrowserTabButton(props: {
  readonly tab: ProjectBrowserTab;
  readonly active: boolean;
  readonly activity: ProjectBrowserTabActivity | null;
  readonly onSelect: () => void;
  readonly onUnpin: () => void;
  readonly onClose: () => void;
  readonly onDragStart: (event: DragEvent) => void;
  readonly onDrop: (event: DragEvent) => void;
}) {
  const preview = useThreadPreviewState(props.tab.backingThreadRef);
  const snapshot = preview.sessions[props.tab.tabId] ?? null;
  const title = snapshotTitle(snapshot);
  return (
    <div
      draggable
      onDragStart={props.onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={props.onDrop}
      className={cn(
        "group flex h-7 min-w-28 max-w-48 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm",
        props.active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
      data-active-project-browser-tab={props.active ? "true" : "false"}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5"
        onClick={props.onSelect}
      >
        <TabFavicon snapshot={snapshot} />
        <span className="truncate">{title}</span>
        {props.activity ? (
          <span
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
            title={`${props.activity.operation} by thread ${props.activity.controllerThreadRef.threadId}`}
            aria-label={`${props.activity.operation} controlled by thread ${props.activity.controllerThreadRef.threadId}`}
          />
        ) : null}
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-muted focus:opacity-100 group-hover:opacity-100"
              aria-label={`Unpin ${title} to origin thread`}
              onClick={props.onUnpin}
            >
              <PinOff className="size-3" />
            </button>
          }
        />
        <TooltipPopup>Return to origin thread</TooltipPopup>
      </Tooltip>
      <button
        type="button"
        className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-muted focus:opacity-100 group-hover:opacity-100"
        aria-label={`Close ${title}`}
        onClick={props.onClose}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

export function ProjectBrowserPanel(props: Props) {
  const runtime = useProjectBrowserStore((state) =>
    selectProjectBrowserRuntime(state.runtimeByProjectKey, props.logicalProjectKey),
  );
  const layout = useProjectBrowserStore((state) =>
    selectProjectBrowserLayout(state.layoutByProjectKey, props.logicalProjectKey),
  );
  const activityByTabId = useProjectBrowserStore((state) => state.activityByTabId);
  const threads = useThreadShells();
  const openPreview = useAtomCommand(previewEnvironment.open, "create project browser tab");
  const closePreview = useAtomCommand(previewEnvironment.close, "close project browser tab");
  const activeTab = runtime.tabs.find((tab) => tab.tabId === runtime.activeTabId) ?? null;
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [liveWidth, setLiveWidth] = useState(layout.width);
  const resizeRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startWidth: number;
    readonly target: HTMLElement;
  } | null>(null);
  const width = clampProjectBrowserWidth(layout.width === liveWidth ? layout.width : liveWidth);

  const resizeHandlers = useMemo(
    () => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        resizeRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: layout.width,
          target: event.currentTarget,
        };
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const resize = resizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        setLiveWidth(
          Math.min(
            PROJECT_BROWSER_MAX_WIDTH,
            Math.max(PROJECT_BROWSER_MIN_WIDTH, resize.startWidth + resize.startX - event.clientX),
          ),
        );
      },
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
        const resize = resizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        const finalWidth = Math.min(
          PROJECT_BROWSER_MAX_WIDTH,
          Math.max(PROJECT_BROWSER_MIN_WIDTH, resize.startWidth + resize.startX - event.clientX),
        );
        resizeRef.current = null;
        resize.target.releasePointerCapture(event.pointerId);
        setLiveWidth(finalWidth);
        useProjectBrowserStore.getState().setWidth(props.logicalProjectKey, finalWidth);
      },
      onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => {
        const resize = resizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        resizeRef.current = null;
        setLiveWidth(layout.width);
      },
    }),
    [layout.width, props.logicalProjectKey],
  );

  const createTab = useCallback(async () => {
    const result = await openPreview({
      environmentId: props.activeThreadRef.environmentId,
      input: { threadId: props.activeThreadRef.threadId },
    });
    if (result._tag === "Failure") return;
    applyPreviewServerSnapshot(props.activeThreadRef, result.value);
    useProjectBrowserStore.getState().promote(props.logicalProjectKey, {
      tabId: result.value.tabId,
      originThreadRef: props.activeThreadRef,
      backingThreadRef: props.activeThreadRef,
      physicalProjectKey: props.activePhysicalProjectKey,
    });
  }, [openPreview, props.activePhysicalProjectKey, props.activeThreadRef, props.logicalProjectKey]);

  const closeTab = useCallback(
    async (tab: ProjectBrowserTab) => {
      const activity = useProjectBrowserStore.getState().activityByTabId[tab.tabId];
      const recording = readActiveBrowserRecordingTabId() === tab.tabId;
      if (
        projectBrowserCloseNeedsConfirmation({ activity, recording }) &&
        !window.confirm(
          activity
            ? `This tab is being controlled by another thread (${activity.operation}). Close it?`
            : "This tab is being recorded. Stop recording and close it?",
        )
      ) {
        return;
      }
      if (recording) await stopBrowserRecording(tab.tabId).catch(() => null);
      await cancelAndDrainProjectBrowserOperations(tab.tabId);
      const result = await closePreview({
        environmentId: tab.backingThreadRef.environmentId,
        input: { threadId: tab.backingThreadRef.threadId, tabId: tab.tabId },
      });
      if (result._tag === "Failure") return;
      useProjectBrowserStore.getState().remove(tab.tabId);
    },
    [closePreview],
  );

  const unpinTab = useCallback(
    async (tab: ProjectBrowserTab) => {
      const originExists = threads.some(
        (thread) =>
          thread.environmentId === tab.originThreadRef.environmentId &&
          thread.id === tab.originThreadRef.threadId,
      );
      if (!originExists) {
        if (!window.confirm("The origin thread no longer exists. Close this browser tab?")) return;
        await closeTab(tab);
        return;
      }
      unpinProjectBrowserTabToOrigin(tab.tabId);
    },
    [closeTab, threads],
  );

  return (
    <aside
      className={cn(
        "relative z-30 flex h-full min-h-0 min-w-0 shrink-0 flex-col border-l border-border bg-background",
        props.overlay && "absolute inset-y-0 right-0 z-40 max-w-[88vw] shadow-2xl",
      )}
      style={{
        width: `${width}px`,
        maxWidth: props.overlay ? "88vw" : `${PROJECT_BROWSER_MAX_WIDTH}px`,
      }}
      aria-label="Project Browser"
      data-project-browser-panel
    >
      <div
        role="separator"
        aria-label="Resize Project Browser"
        aria-orientation="vertical"
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize"
        {...resizeHandlers}
      />
      <div
        className="workspace-topbar flex gap-1 pl-2 pr-36 wco:pr-[calc(var(--workspace-native-controls-inset)+9rem)]"
        data-project-browser-tabbar
      >
        <ScrollArea hideScrollbars scrollFade className="min-w-0 flex-1 rounded-none">
          <div className="flex h-full w-max min-w-full items-center gap-1">
            {runtime.tabs.map((tab, index) => (
              <ProjectBrowserTabButton
                key={tab.tabId}
                tab={tab}
                active={runtime.activeTabId === tab.tabId}
                activity={activityByTabId[tab.tabId] ?? null}
                onSelect={() =>
                  useProjectBrowserStore.getState().select(props.logicalProjectKey, tab.tabId)
                }
                onUnpin={() => void unpinTab(tab)}
                onClose={() => void closeTab(tab)}
                onDragStart={() => setDraggedTabId(tab.tabId)}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggedTabId) {
                    useProjectBrowserStore
                      .getState()
                      .reorder(props.logicalProjectKey, draggedTabId, index);
                  }
                  setDraggedTabId(null);
                }}
              />
            ))}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label="New project browser tab"
                    onClick={() => void createTab()}
                  >
                    <Plus className="size-4" />
                  </button>
                }
              />
              <TooltipPopup>New project browser tab</TooltipPopup>
            </Tooltip>
          </div>
        </ScrollArea>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {activeTab ? (
          <PreviewPanel
            mode="embedded"
            threadRef={activeTab.backingThreadRef}
            tabId={activeTab.tabId}
            configuredUrls={props.configuredUrls}
            visible
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <Globe2 className="size-7 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">No project browser tabs</p>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                Create a tab here or pin one from a thread's right panel.
              </p>
            </div>
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
              onClick={() => void createTab()}
            >
              New browser tab
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
