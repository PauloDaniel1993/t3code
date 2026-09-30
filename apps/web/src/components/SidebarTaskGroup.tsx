import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  formatSidebarTaskElapsed,
  formatSidebarTaskDuration,
  resolveSidebarTaskState,
  sidebarTaskWasReturned,
  sidebarTaskCountLabel,
  sidebarHasUnreadTaskResults,
} from "@t3tools/client-runtime/state/sidebar-task-subthreads";
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2Subagent, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  deriveNativeAgentRollup,
  NATIVE_AGENT_SETTLED_WINDOW,
} from "@t3tools/client-runtime/state/native-agent-rollup";
import {
  useKnownSidebarTaskPresentation,
  useSidebarTaskProjection,
  useRememberSidebarTaskPresentation,
} from "./sidebarTaskPresentation";
import { useUiStateStore } from "../uiStateStore";
import { cn } from "../lib/utils";
import { useSidebarTaskClock } from "./sidebarTaskClock";
import { useSidebarTaskVisibility } from "./sidebarTaskVisibility";
import { SidebarTaskMark } from "./SidebarTaskMark";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { closeSidebarTaskPeek, leaveSidebarTaskPeek, openSidebarTaskPeek } from "./SidebarTaskPeek";

export const EMPTY_SIDEBAR_TASKS: ReadonlyArray<EnvironmentThreadShell> = Object.freeze([]);
type GroupProps = {
  parent: EnvironmentThreadShell;
  tasks: ReadonlyArray<EnvironmentThreadShell>;
  nativeThreads?: ReadonlyArray<EnvironmentThreadShell>;
};

function useTaskGroup({ parent, tasks, nativeThreads = EMPTY_SIDEBAR_TASKS }: GroupProps) {
  const parentRef = useMemo(
    () => scopeThreadRef(parent.environmentId, parent.id),
    [parent.environmentId, parent.id],
  );
  const presentation = useKnownSidebarTaskPresentation(parentRef);
  const { subagents } = presentation;
  const rollup = useMemo(() => deriveNativeAgentRollup(presentation), [presentation]);
  const key = scopedThreadKey(parentRef);
  const override = useUiStateStore((state) => state.sidebarTaskGroupsExpandedById[key]);
  const setExpanded = useUiStateStore((state) => state.setSidebarTaskGroupExpanded);
  const visitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[key]);
  const delivered = Date.parse(parent.source.latestTaskDeliveredAt ?? "");
  const unread =
    sidebarHasUnreadTaskResults(subagents, visitedAt) ||
    (Number.isFinite(delivered) &&
      (!Number.isFinite(Date.parse(visitedAt ?? "")) || delivered > Date.parse(visitedAt!)));
  const defaultOpen =
    unread ||
    tasks.some((thread) => {
      const state = resolveSidebarTaskState(thread);
      return state === "queued" || state === "running";
    }) ||
    rollup.groups.some((group) => group.summary.runningCount > 0) ||
    nativeThreads.some((thread) => resolveSidebarTaskState(thread) === "running");
  // Add shells not yet learned by the bounded detail roster, including while collapsed.
  const knownNativeChildren = new Set(
    subagents
      .filter((agent) => agent.origin === "provider_native")
      .map((agent) => agent.childThreadId),
  );
  const unknown = nativeThreads.filter((thread) => !knownNativeChildren.has(thread.id));
  const liveNativeCount = unknown.filter((thread) => {
    const state = resolveSidebarTaskState(thread);
    return state === "queued" || state === "running";
  }).length;
  const agentCount =
    rollup.agentCount +
    liveNativeCount +
    Math.min(
      Math.max(
        0,
        NATIVE_AGENT_SETTLED_WINDOW -
          (rollup.agentCount -
            rollup.groups.reduce((count, group) => count + group.summary.runningCount, 0)),
      ),
      unknown.length - liveNativeCount,
    );
  return {
    parentRef,
    key,
    subagents,
    rollup,
    agentCount,
    unread,
    expanded: override ?? defaultOpen,
    setExpanded,
  };
}

export const SidebarTaskDisclosure = memo(
  function SidebarTaskDisclosure(props: GroupProps) {
    const { agentCount, expanded, key, setExpanded, unread } = useTaskGroup(props);
    const label = sidebarTaskCountLabel(props.tasks.length, agentCount);
    if (label === "") return null;
    return (
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} ${label}${unread ? ", New task results" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          setExpanded(key, !expanded);
          if (expanded) closeSidebarTaskPeek();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        className="relative z-20 inline-flex shrink-0 items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDownIcon aria-hidden className={cn("size-3", !expanded && "-rotate-90")} />
        {label}
        {unread ? (
          <span
            role="img"
            aria-label="New task results"
            className="size-1.5 rounded-full bg-info-foreground"
          />
        ) : null}
      </button>
    );
  },
  (before, after) =>
    before.parent === after.parent &&
    before.tasks === after.tasks &&
    before.nativeThreads === after.nativeThreads,
);

export type TaskGroupProps = GroupProps & {
  onOpenThread: (ref: ScopedThreadRef) => void;
  onContextMenu: (ref: ScopedThreadRef, position: { x: number; y: number }) => void;
  onCommitRename: (ref: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  onRenameTitleChange: (title: string) => void;
  renamingThreadKey: string | null;
  renamingTitle: string;
  onNewTask: (ref: ScopedThreadRef) => void;
};

export const SidebarTaskGroup = memo(
  function SidebarTaskGroup(props: TaskGroupProps) {
    const { parentRef, subagents, rollup, expanded, agentCount } = useTaskGroup(props);
    const { visible, leased, rowRef } = useSidebarTaskVisibility(
      expanded,
      scopedThreadKey(parentRef),
    );
    const projection = useSidebarTaskProjection(leased ? parentRef : null);
    useRememberSidebarTaskPresentation(parentRef, projection);
    const [turnOverrides, setTurnOverrides] = useState<Record<string, boolean>>({});
    const [openedAt] = useState(() => Date.now());
    const tasksByThreadId = useMemo(
      () =>
        new Map(
          subagents
            .filter((agent) => agent.origin === "app_owned" && agent.childThreadId !== null)
            .map((agent) => [agent.childThreadId, agent]),
        ),
      [subagents],
    );
    const ticking =
      expanded &&
      visible &&
      (rollup.groups.some((group) => group.label.startsWith("Earlier turn")) ||
        props.tasks.some((thread) => {
          const state = resolveSidebarTaskState(thread, tasksByThreadId.get(thread.id));
          return state === "queued" || state === "running";
        }));
    const clock = useSidebarTaskClock(ticking);
    const now = ticking ? clock : openedAt;
    // Keep the component mounted when collapsed so turn overrides survive.
    if (!expanded || (props.tasks.length === 0 && agentCount === 0)) return null;
    return (
      <div
        ref={rowRef}
        className="group/sidebar-task-group relative ml-3 pl-3"
        onPointerDown={(event) => event.stopPropagation()}
        onDragOver={(event) => event.stopPropagation()}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-px bg-sidebar-border"
        />
        <ul
          aria-label={`Tasks for ${props.parent.title}`}
          className="max-h-48 overflow-y-auto overscroll-contain py-1"
        >
          {props.tasks.map((thread) => {
            const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
            return (
              <SidebarTaskRow
                key={key}
                thread={thread}
                task={tasksByThreadId.get(thread.id)}
                animate={visible}
                elapsed={formatSidebarTaskElapsed(thread, tasksByThreadId.get(thread.id), now)}
                onOpenThread={props.onOpenThread}
                onContextMenu={props.onContextMenu}
                onCommitRename={props.onCommitRename}
                onCancelRename={props.onCancelRename}
                onRenameTitleChange={props.onRenameTitleChange}
                isRenaming={props.renamingThreadKey === key}
                renamingTitle={props.renamingThreadKey === key ? props.renamingTitle : ""}
              />
            );
          })}
          {rollup.groups.map((group) => {
            const runId = group.key;
            const turnAgents = group.agents;
            const open = turnOverrides[runId] ?? group.expandedByDefault;
            return (
              <li key={runId} className="list-none">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setTurnOverrides((current) => ({ ...current, [runId]: !open }))}
                  className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronDownIcon aria-hidden className={cn("size-3", !open && "-rotate-90")} />
                  {group.label.replace(
                    "Earlier turn",
                    `${formatSidebarTaskDuration(now - DateTime.toEpochMillis(group.agents[0]!.startedAt ?? group.agents[0]!.updatedAt))} ago`,
                  )}
                  <span className="ml-auto text-3xs">{group.summary.label}</span>
                </button>
                {open ? (
                  <ul aria-label="Provider-owned agents">
                    {turnAgents.map((agent) => (
                      <li key={agent.id} className="list-none">
                        <button
                          type="button"
                          onClick={() =>
                            props.onOpenThread(
                              scopeThreadRef(props.parent.environmentId, props.parent.id),
                            )
                          }
                          onPointerEnter={(event) => {
                            if (event.pointerType !== "touch")
                              openSidebarTaskPeek({
                                anchor: event.currentTarget,
                                thread: props.parent,
                                task: undefined,
                                nativeAgent: agent,
                              });
                          }}
                          onPointerLeave={leaveSidebarTaskPeek}
                          onFocus={(event) =>
                            openSidebarTaskPeek({
                              anchor: event.currentTarget,
                              thread: props.parent,
                              task: undefined,
                              nativeAgent: agent,
                            })
                          }
                          onBlur={leaveSidebarTaskPeek}
                          className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground outline-none hover:bg-sidebar-row-hover focus-visible:bg-sidebar-row-hover"
                        >
                          <SidebarTaskMark
                            animate={visible}
                            state={
                              agent.status === "completed"
                                ? "finished"
                                : agent.status === "failed"
                                  ? "failed"
                                  : agent.status === "cancelled" || agent.status === "interrupted"
                                    ? "cancelled"
                                    : agent.status === "idle"
                                      ? "unavailable"
                                      : "running"
                            }
                          />
                          <span className="truncate">{agent.title ?? "Agent"}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
          {rollup.hiddenSettledCount > 0 ? (
            <li className="px-2 py-1 text-xs text-muted-foreground">
              {rollup.hiddenSettledCount} older inactive agents remain in the transcript
            </li>
          ) : null}
        </ul>
        <button
          type="button"
          onClick={() =>
            props.onNewTask(scopeThreadRef(props.parent.environmentId, props.parent.id))
          }
          className="mb-1 flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground opacity-0 outline-none hover:bg-sidebar-row-hover focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/sidebar-task-group:opacity-100"
        >
          <PlusIcon aria-hidden className="size-3" />
          New task
        </button>
      </div>
    );
  },
  (before, after) =>
    Object.keys(before).every(
      (key) => before[key as keyof TaskGroupProps] === after[key as keyof TaskGroupProps],
    ),
);

const SidebarTaskRow = memo(function SidebarTaskRow(props: {
  thread: EnvironmentThreadShell;
  task: OrchestrationV2Subagent | undefined;
  elapsed: string;
  animate: boolean;
  onOpenThread: TaskGroupProps["onOpenThread"];
  onContextMenu: TaskGroupProps["onContextMenu"];
  onCommitRename: TaskGroupProps["onCommitRename"];
  onCancelRename: TaskGroupProps["onCancelRename"];
  onRenameTitleChange: TaskGroupProps["onRenameTitleChange"];
  isRenaming: boolean;
  renamingTitle: string;
}) {
  const { thread, task } = props;
  const committed = useRef(false);
  useEffect(() => {
    if (props.isRenaming) {
      committed.current = false;
      closeSidebarTaskPeek();
    }
  }, [props.isRenaming]);
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const elapsed = props.elapsed;
  const returned = sidebarTaskWasReturned(task);
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    props.onCommitRename(ref, props.renamingTitle, thread.title);
  };
  if (props.isRenaming)
    return (
      <li className="list-none px-2 py-1">
        <input
          autoFocus
          aria-label="Task title"
          value={props.renamingTitle}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => props.onRenameTitleChange(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              committed.current = true;
              props.onCancelRename();
            }
          }}
          className="w-full rounded-sm border border-input bg-card px-1 py-1 text-sm outline-none focus:border-foreground"
        />
      </li>
    );
  return (
    <li className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]">
      <button
        type="button"
        onClick={() => {
          closeSidebarTaskPeek();
          props.onOpenThread(ref);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          closeSidebarTaskPeek();
          props.onContextMenu(ref, { x: event.clientX, y: event.clientY });
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch")
            openSidebarTaskPeek({ anchor: event.currentTarget, thread, task });
        }}
        onPointerLeave={leaveSidebarTaskPeek}
        onFocus={(event) => openSidebarTaskPeek({ anchor: event.currentTarget, thread, task })}
        onBlur={leaveSidebarTaskPeek}
        className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-sidebar-row-hover focus-visible:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <SidebarTaskMark state={resolveSidebarTaskState(thread, task)} animate={props.animate} />
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        {returned ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  role="img"
                  aria-label="Returned results to the parent thread"
                  className="shrink-0 text-xs text-info-foreground"
                />
              }
            >
              ↩
            </TooltipTrigger>
            <TooltipPopup>Returned results to the parent thread and woke the parent</TooltipPopup>
          </Tooltip>
        ) : null}
        <span className="shrink-0 text-3xs text-muted-foreground tabular-nums">{elapsed}</span>
      </button>
    </li>
  );
});
