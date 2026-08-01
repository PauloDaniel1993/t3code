import type { ThreadNativeAgent } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, LoaderIcon, XIcon } from "lucide-react";
import { memo, useMemo, useRef, type FocusEvent as ReactFocusEvent, type ReactNode } from "react";

import { cn } from "../lib/utils";
import {
  formatNativeAgentElapsed,
  formatNativeAgentGroupLabel,
  groupNativeAgentsByTurn,
  nativeAgentGroupStartsExpanded,
  type NativeAgentTurnGroup,
} from "@t3tools/client-runtime/state/native-agents";

/**
 * In-session agents nested under the parent's task rows, grouped per turn to
 * mirror the transcript's workflow card one to one.
 *
 * The rows are deliberately less capable than task rows: they cannot be
 * renamed, have no context menu, and clicking one locates the run in the
 * transcript rather than opening a thread — there is no thread to open.
 */
export const SidebarNativeAgentGroups = memo(function SidebarNativeAgentGroups(props: {
  parentThreadKey: string;
  nativeAgents: ReadonlyArray<ThreadNativeAgent>;
  nowMs: number;
  openAgentKey: string | null;
  /**
   * Per-group user toggles, keyed by the group's stable key. Owned by the
   * caller (which stays mounted while the parent group collapses) so a toggle
   * outranks the starts-expanded rule for the whole session.
   */
  expandedOverrides: ReadonlyMap<string, boolean>;
  onToggleGroup: (groupKey: string, expanded: boolean) => void;
  /** Hovering or focusing a row peeks at it; clicking it jumps to the transcript. */
  onPeekAgent: (taskId: string, anchor: HTMLElement | null) => void;
  onPeekLeave: () => void;
  onAgentClick: (agent: ThreadNativeAgent) => void;
  /** The native peek window, rendered anchored to whichever row is open. */
  miniWindow: ReactNode;
}) {
  const {
    expandedOverrides,
    miniWindow,
    nativeAgents,
    nowMs,
    onAgentClick,
    onPeekAgent,
    onPeekLeave,
    onToggleGroup,
    openAgentKey,
  } = props;
  const groups = useMemo(() => groupNativeAgentsByTurn(nativeAgents), [nativeAgents]);

  if (groups.length === 0) {
    return null;
  }

  return (
    <ul role="list" data-testid="sidebar-native-agent-groups" className="flex flex-col gap-px">
      {groups.map((group) => {
        const expanded = expandedOverrides.get(group.key) ?? nativeAgentGroupStartsExpanded(group);
        return (
          <NativeAgentTurnGroupSection
            key={group.key}
            group={group}
            expanded={expanded}
            nowMs={nowMs}
            openAgentKey={openAgentKey}
            parentThreadKey={props.parentThreadKey}
            onToggle={() => onToggleGroup(group.key, !expanded)}
            onPeekAgent={onPeekAgent}
            onPeekLeave={onPeekLeave}
            onAgentClick={onAgentClick}
            miniWindow={miniWindow}
          />
        );
      })}
    </ul>
  );
});

function NativeAgentTurnGroupSection(props: {
  group: NativeAgentTurnGroup;
  expanded: boolean;
  nowMs: number;
  openAgentKey: string | null;
  parentThreadKey: string;
  onToggle: () => void;
  onPeekAgent: (taskId: string, anchor: HTMLElement | null) => void;
  onPeekLeave: () => void;
  onAgentClick: (agent: ThreadNativeAgent) => void;
  miniWindow: ReactNode;
}) {
  const {
    expanded,
    group,
    miniWindow,
    nowMs,
    onAgentClick,
    onPeekAgent,
    onPeekLeave,
    onToggle,
    openAgentKey,
    parentThreadKey,
  } = props;
  return (
    <li className="list-none">
      <button
        type="button"
        aria-expanded={expanded}
        data-testid="sidebar-native-agent-group-toggle"
        onClick={onToggle}
        className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-[11px] text-muted-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate">
          {formatNativeAgentGroupLabel({ group, nowMs })}
        </span>
        <NativeAgentGroupCounts group={group} />
      </button>
      {expanded ? (
        <ul role="list" className="flex flex-col gap-px pl-2">
          {group.agents.map((agent) => {
            const agentKey = `${parentThreadKey}:native:${agent.taskId}`;
            const isOpen = openAgentKey === agentKey;
            return (
              <SidebarNativeAgentRow
                key={agentKey}
                agent={agent}
                nowMs={nowMs}
                isOpen={isOpen}
                onPeekAgent={onPeekAgent}
                onPeekLeave={onPeekLeave}
                onAgentClick={onAgentClick}
              >
                {isOpen ? miniWindow : null}
              </SidebarNativeAgentRow>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

/** Small running/finished/failed tallies; a count that is zero is omitted. */
function NativeAgentGroupCounts({ group }: { group: NativeAgentTurnGroup }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
      {group.runningCount > 0 ? (
        <span
          title={`${group.runningCount} running`}
          className="flex items-center gap-0.5 text-sky-600 dark:text-sky-400"
        >
          <LoaderIcon aria-hidden className="size-2.5 animate-spin motion-reduce:animate-none" />
          {group.runningCount}
        </span>
      ) : null}
      {group.finishedCount > 0 ? (
        <span
          title={`${group.finishedCount} finished`}
          className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400"
        >
          <CheckIcon aria-hidden className="size-2.5" />
          {group.finishedCount}
        </span>
      ) : null}
      {group.failedCount > 0 ? (
        <span
          title={`${group.failedCount} failed`}
          className="flex items-center gap-0.5 text-red-600 dark:text-red-400"
        >
          <XIcon aria-hidden className="size-2.5" />
          {group.failedCount}
        </span>
      ) : null}
    </span>
  );
}

const SidebarNativeAgentRow = memo(function SidebarNativeAgentRow(props: {
  agent: ThreadNativeAgent;
  nowMs: number;
  isOpen: boolean;
  onPeekAgent: (taskId: string, anchor: HTMLElement | null) => void;
  onPeekLeave: () => void;
  onAgentClick: (agent: ThreadNativeAgent) => void;
  children?: ReactNode;
}) {
  const { agent, children, isOpen, nowMs, onAgentClick, onPeekAgent, onPeekLeave } = props;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const peek = () => onPeekAgent(agent.taskId, buttonRef.current);
  const elapsed = formatNativeAgentElapsed({ agent, nowMs });

  return (
    // The window is a React child, so moving onto it never leaves this row —
    // the peek survives reaching for its buttons.
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
        data-testid="sidebar-native-agent-row"
        data-native-agent-status={agent.status}
        title="In-session agent — runs inside the parent session · click to show in transcript"
        onClick={() => onAgentClick(agent)}
        className={cn(
          "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-none transition-colors",
          "hover:bg-sidebar-row-hover focus-visible:bg-sidebar-row-hover",
          isOpen && "bg-sidebar-row-hover",
        )}
      >
        <NativeAgentStatusIcon status={agent.status} />
        {agent.retryOfTaskId !== undefined ? (
          <span
            aria-label="Retry of an earlier run"
            title="Retry of an earlier run"
            className="shrink-0 font-mono text-[11px] text-muted-foreground/70"
          >
            ↺
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/80">
          {agent.description}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{elapsed}</span>
      </button>
    </li>
  );
});

function NativeAgentStatusIcon({ status }: { status: ThreadNativeAgent["status"] }) {
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "running":
      return (
        <LoaderIcon
          aria-label="Running"
          className={cn(
            className,
            "animate-spin text-sky-600 motion-reduce:animate-none dark:text-sky-400",
          )}
        />
      );
    case "finished":
      return (
        <CheckIcon
          aria-label="Finished"
          className={cn(className, "text-emerald-600 dark:text-emerald-400")}
        />
      );
    case "failed":
      return (
        <XIcon aria-label="Failed" className={cn(className, "text-red-600 dark:text-red-400")} />
      );
  }
}
