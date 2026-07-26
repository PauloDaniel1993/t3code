import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, LoaderIcon, PlusIcon, XIcon } from "lucide-react";
import {
  memo,
  useMemo,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "../lib/utils";
import { formatTaskElapsedLabel, resolveTaskRowPresentation } from "./SidebarTaskRows.logic";

/**
 * A parent thread's nested task rows plus the hover-visible `+ New task` row.
 *
 * The group is rendered inline in the sidebar list, directly beneath its parent
 * row, so the parent keeps its own sort position. Rows are indented with a
 * guide line and never migrate to the global snoozed/settled shelves.
 */
export const SidebarTaskGroup = memo(function SidebarTaskGroup(props: {
  parentThreadKey: string;
  tasks: ReadonlyArray<EnvironmentThreadShell>;
  expanded: boolean;
  openTaskKey: string | null;
  nowMs: number;
  /** Hovering or focusing a row peeks at it; the row itself navigates. */
  onPeekTask: (threadRef: ScopedThreadRef, anchor: HTMLElement | null) => void;
  onPeekLeave: () => void;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  renamingTaskKey: string | null;
  renamingTitle: string;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  onNewTask: (parentThreadKey: string) => void;
  /** The mini thread window, rendered anchored to whichever row is open. */
  miniWindow: ReactNode;
}) {
  const {
    expanded,
    miniWindow,
    nowMs,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onNewTask,
    onOpenThread,
    onPeekLeave,
    onPeekTask,
    onRenameTitleChange,
    openTaskKey,
    parentThreadKey,
    renamingTaskKey,
    renamingTitle,
    tasks,
  } = props;

  if (!expanded) {
    return null;
  }

  return (
    <li className="list-none" data-thread-selection-safe data-testid="sidebar-task-group">
      <ul role="list" className="group/tasks relative flex flex-col gap-px pl-6">
        {/* Guide line joining the group to its parent row. */}
        <span
          aria-hidden
          className="absolute bottom-2 left-3 top-0 w-px bg-sidebar-border/70 dark:bg-white/10"
        />
        {tasks.map((task) => {
          const taskKey = scopedThreadKey(scopeThreadRef(task.environmentId, task.id));
          const isOpen = openTaskKey === taskKey;
          return (
            <SidebarTaskRow
              key={taskKey}
              task={task}
              nowMs={nowMs}
              isOpen={isOpen}
              onPeekTask={onPeekTask}
              onPeekLeave={onPeekLeave}
              onOpenThread={onOpenThread}
              onContextMenu={onContextMenu}
              isRenaming={renamingTaskKey === taskKey}
              renamingTitle={renamingTaskKey === taskKey ? renamingTitle : ""}
              onRenameTitleChange={onRenameTitleChange}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
            >
              {isOpen ? miniWindow : null}
            </SidebarTaskRow>
          );
        })}
        <li className="list-none">
          <button
            type="button"
            data-testid="sidebar-task-new"
            onClick={() => onNewTask(parentThreadKey)}
            className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-[11px] text-muted-foreground/60 opacity-0 transition-opacity hover:bg-sidebar-accent/50 hover:text-foreground focus-visible:opacity-100 group-hover/tasks:opacity-100"
          >
            <PlusIcon aria-hidden className="size-3" />
            New task
          </button>
        </li>
      </ul>
    </li>
  );
});

const SidebarTaskRow = memo(function SidebarTaskRow(props: {
  task: EnvironmentThreadShell;
  nowMs: number;
  isOpen: boolean;
  onPeekTask: (threadRef: ScopedThreadRef, anchor: HTMLElement | null) => void;
  onPeekLeave: () => void;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  isRenaming: boolean;
  renamingTitle: string;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  children?: ReactNode;
}) {
  const {
    children,
    isOpen,
    isRenaming,
    nowMs,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onOpenThread,
    onPeekLeave,
    onPeekTask,
    onRenameTitleChange,
    renamingTitle,
    task,
  } = props;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const threadRef = useMemo(
    () => scopeThreadRef(task.environmentId, task.id),
    [task.environmentId, task.id],
  );
  const metadata = task.task;
  const presentation = useMemo(
    () => (metadata == null ? null : resolveTaskRowPresentation(metadata)),
    [metadata],
  );
  if (metadata == null || presentation === null) {
    return null;
  }

  const elapsed = formatTaskElapsedLabel({ task: metadata, nowMs });

  // Renaming borrows the row, so peeking must not steal focus back or close
  // the editor out from under the pointer.
  const peek = () => {
    if (!isRenaming) onPeekTask(threadRef, buttonRef.current);
  };

  if (isRenaming) {
    return (
      <li className="relative list-none">
        <div className="flex h-7 w-full items-center gap-2 rounded-md px-2">
          <TaskStatusIcon icon={presentation.icon} label={presentation.iconLabel} />
          <input
            autoFocus
            value={renamingTitle}
            aria-label="Task title"
            onChange={(event) => onRenameTitleChange(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onCommitRename(threadRef, renamingTitle, metadata.title);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onCancelRename();
              }
            }}
            onBlur={() => onCommitRename(threadRef, renamingTitle, metadata.title)}
            className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-xs text-card-foreground outline-none focus:border-foreground"
          />
        </div>
      </li>
    );
  }

  return (
    // The window is a DOM child, so moving onto it never leaves this element —
    // the peek survives reaching for its steer box and its buttons.
    <li
      className="relative list-none"
      onMouseEnter={peek}
      onMouseLeave={onPeekLeave}
      onFocus={peek}
      onBlur={(event: ReactFocusEvent<HTMLLIElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onPeekLeave();
      }}
    >
      {children}
      <button
        ref={buttonRef}
        type="button"
        data-thread-item
        data-testid="sidebar-task-row"
        data-task-status={metadata.status}
        onClick={() => onOpenThread(threadRef)}
        onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => {
          event.preventDefault();
          event.stopPropagation();
          onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
        }}
        className={cn(
          "group/task-row flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-none transition-colors",
          "hover:bg-sidebar-row-hover focus-visible:bg-sidebar-row-hover",
          isOpen && "bg-sidebar-row-hover",
        )}
      >
        <TaskStatusIcon icon={presentation.icon} label={presentation.iconLabel} />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/90">{metadata.title}</span>
        {presentation.returnedToParent ? (
          <span
            aria-label="Returned results to the parent thread"
            title="Returned results — woke the parent thread"
            className="shrink-0 font-mono text-[11px] text-blue-600 dark:text-blue-400"
          >
            ↩
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{elapsed}</span>
      </button>
    </li>
  );
});

function TaskStatusIcon(props: {
  icon: ReturnType<typeof resolveTaskRowPresentation>["icon"];
  label: string;
}) {
  const className = "size-3.5 shrink-0";
  switch (props.icon) {
    case "running":
      return (
        <LoaderIcon
          aria-label={props.label}
          className={cn(
            className,
            "animate-spin text-sky-600 motion-reduce:animate-none dark:text-sky-400",
          )}
        />
      );
    case "done":
      return (
        <CheckIcon
          aria-label={props.label}
          className={cn(className, "text-emerald-600 dark:text-emerald-400")}
        />
      );
    case "failed":
      return (
        <XIcon
          aria-label={props.label}
          className={cn(className, "text-red-600 dark:text-red-400")}
        />
      );
    case "cancelled":
      return (
        <ChevronDownIcon
          aria-label={props.label}
          className={cn(className, "text-muted-foreground/60")}
        />
      );
  }
}
