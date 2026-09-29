import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  formatSidebarTaskElapsed,
  formatSidebarTaskDuration,
  resolveSidebarTaskState,
  sidebarNativeAgents,
  sidebarTaskCountLabel,
  sidebarHasUnreadTaskResults,
} from "@t3tools/client-runtime/state/sidebar-task-subthreads";
import type { OrchestrationV2Subagent, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import * as DateTime from "effect/DateTime";
import { useThreadProjection } from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { cn } from "../lib/utils";
import { useSidebarTaskClock } from "./sidebarTaskClock";
import { SidebarTaskMark } from "./SidebarTaskMark";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { closeSidebarTaskPeek, leaveSidebarTaskPeek, openSidebarTaskPeek } from "./SidebarTaskPeek";

const EMPTY_AGENTS: ReadonlyArray<OrchestrationV2Subagent> = Object.freeze([]);
export const EMPTY_SIDEBAR_TASKS: ReadonlyArray<EnvironmentThreadShell> = Object.freeze([]);
type GroupProps = {
  parent: EnvironmentThreadShell;
  tasks: ReadonlyArray<EnvironmentThreadShell>;
};

function useTaskGroup({ parent, tasks }: GroupProps) {
  const parentRef = useMemo(
    () => scopeThreadRef(parent.environmentId, parent.id),
    [parent.environmentId, parent.id],
  );
  const subagents = useThreadProjection(parentRef)?.projection.subagents ?? EMPTY_AGENTS;
  const agents = useMemo(() => sidebarNativeAgents(subagents), [subagents]);
  const key = scopedThreadKey(parentRef);
  const override = useUiStateStore((state) => state.sidebarTaskGroupsExpandedById[key]);
  const setExpanded = useUiStateStore((state) => state.setSidebarTaskGroupExpanded);
  const visitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[key]);
  const unread = sidebarHasUnreadTaskResults(subagents, visitedAt);
  const defaultOpen =
    unread ||
    tasks.some((thread) => {
      const state = resolveSidebarTaskState(thread);
      return state === "queued" || state === "running";
    }) ||
    agents.some(
      (agent) =>
        agent.status === "running" || agent.status === "pending" || agent.status === "waiting",
    );
  return { key, subagents, agents, unread, expanded: override ?? defaultOpen, setExpanded };
}

export const SidebarTaskDisclosure = memo(
  function SidebarTaskDisclosure(props: GroupProps) {
    const { agents, expanded, key, setExpanded, unread } = useTaskGroup(props);
    const label = sidebarTaskCountLabel(props.tasks.length, agents.length);
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
  (before, after) => before.parent === after.parent && before.tasks === after.tasks,
);

type TaskGroupProps = GroupProps & {
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
    const { subagents, agents, expanded } = useTaskGroup(props);
    const now = useSidebarTaskClock();
    const [turnOverrides, setTurnOverrides] = useState<Record<string, boolean>>({});
    const turns = useMemo(() => {
      const groups = new Map<string, OrchestrationV2Subagent[]>();
      for (const agent of agents) {
        const key = agent.runId ?? `untracked:${agent.id}`;
        const group = groups.get(key);
        if (group === undefined) groups.set(key, [agent]);
        else group.push(agent);
      }
      return [...groups.entries()];
    }, [agents]);
    const tasksByThreadId = useMemo(
      () =>
        new Map(
          subagents
            .filter((agent) => agent.origin === "app_owned" && agent.childThreadId !== null)
            .map((agent) => [agent.childThreadId, agent]),
        ),
      [subagents],
    );
    // Keep the component mounted when collapsed so turn overrides survive.
    if (!expanded || (props.tasks.length === 0 && agents.length === 0)) return null;
    return (
      <div
        className="group/sidebar-task-group relative ml-3 pl-3"
        onPointerDown={(event) => event.stopPropagation()}
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
                now={now}
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
          {turns.map(([runId, turnAgents], index) => {
            const latest = index === turns.length - 1;
            const running = turnAgents.filter(
              (agent) =>
                agent.status === "pending" ||
                agent.status === "running" ||
                agent.status === "waiting",
            ).length;
            const done = turnAgents.filter((agent) => agent.status === "completed").length;
            const failed = turnAgents.filter((agent) => agent.status === "failed").length;
            const open = turnOverrides[runId] ?? (latest || running > 0);
            const age = formatSidebarTaskDuration(
              now - DateTime.toEpochMillis(turnAgents[0]!.startedAt ?? turnAgents[0]!.updatedAt),
            );
            return (
              <li key={runId} className="list-none">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setTurnOverrides((current) => ({ ...current, [runId]: !open }))}
                  className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronDownIcon aria-hidden className={cn("size-3", !open && "-rotate-90")} />
                  {latest ? "Latest turn" : `${age} ago`} ·{" "}
                  {sidebarTaskCountLabel(0, turnAgents.length)}
                  <span className="ml-auto text-3xs">
                    {running} running · {done} done · {failed} failed
                  </span>
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
  now: number;
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
  const elapsed = formatSidebarTaskElapsed(thread, task, props.now);
  const returned = task?.completionDelivery?.state === "delivered";
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
    <li className="list-none">
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
        <SidebarTaskMark state={resolveSidebarTaskState(thread, task)} />
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
