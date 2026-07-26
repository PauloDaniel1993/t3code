import * as Equal from "effect/Equal";
import { isTaskResultMessage } from "@t3tools/client-runtime/state/thread-tasks";
import {
  formatDuration,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import {
  type MessageId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@t3tools/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;
export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;
export const TIMELINE_ACTIVITY_ACTIVATION_OFFSET = 12;
export const TIMELINE_ACTIVITY_CYCLE_HYSTERESIS = 12;
export const TIMELINE_RUNNING_ACTIVITY_LEADING_ALLOWANCE = 20;

export interface TimelineActivityCycle {
  /** Stable cycle identity. A user message starts a new message cycle. */
  readonly id: string;
  /** Row whose top edge is compared with the viewport activation line. */
  readonly startRowIndex: number;
  /** Most recent turn in this cycle that has meaningful workflow activity. */
  readonly activityTurnId: TurnId | null;
}

interface TimelineActivityPositionState {
  readonly scroll?: number;
  readonly positionAtIndex?: (index: number) => number | undefined;
}

function workflowTurnIdsForRow(row: MessagesTimelineRow): TurnId[] {
  switch (row.kind) {
    case "turn-fold":
      return [row.turnId];
    case "message":
      return row.message.role === "assistant" && row.message.turnId !== null
        ? [row.message.turnId]
        : [];
    case "work":
      return row.groupedEntries.flatMap((entry) => (entry.turnId ? [entry.turnId] : []));
    case "proposed-plan":
      return row.proposedPlan.turnId === null ? [] : [row.proposedPlan.turnId];
    case "work-toggle":
    case "working":
      return [];
  }
}

/**
 * Partition rendered rows into user-message cycles and select the newest
 * activity-bearing canonical turn in each cycle. This deliberately does not
 * merge multiple turn models: a retry/steer can leave more than one turn in a
 * cycle, and the most recent meaningful one owns the sticky surface.
 */
export function deriveTimelineActivityCycles(input: {
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly timelineEntries?: ReadonlyArray<TimelineEntry>;
  readonly activityTurnIds: ReadonlySet<TurnId>;
  readonly runningTurnId: TurnId | null;
}): TimelineActivityCycle[] {
  const activityTurnIdByCycleId = new Map<string, TurnId>();
  let sourceCycleId = "message-cycle:initial";
  for (const entry of input.timelineEntries ?? []) {
    if (entry.kind === "message" && entry.message.role === "user") {
      sourceCycleId = `message-cycle:${entry.message.id}`;
      continue;
    }
    const turnId =
      entry.kind === "message"
        ? entry.message.role === "assistant"
          ? entry.message.turnId
          : null
        : entry.kind === "work"
          ? (entry.entry.turnId ?? null)
          : entry.proposedPlan.turnId;
    if (turnId !== null && input.activityTurnIds.has(turnId)) {
      activityTurnIdByCycleId.set(sourceCycleId, turnId);
    }
  }

  const cycles: Array<{
    id: string;
    startRowIndex: number;
    activityTurnId: TurnId | null;
  }> = [];
  let currentCycle: (typeof cycles)[number] | null = null;

  for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1) {
    const row = input.rows[rowIndex];
    if (!row) continue;

    if (row.kind === "message" && row.message.role === "user") {
      const id = `message-cycle:${row.message.id}`;
      currentCycle = {
        id,
        startRowIndex: rowIndex,
        activityTurnId: activityTurnIdByCycleId.get(id) ?? null,
      };
      cycles.push(currentCycle);
      continue;
    }

    if (currentCycle === null) {
      currentCycle = {
        id: "message-cycle:initial",
        startRowIndex: rowIndex,
        activityTurnId: activityTurnIdByCycleId.get("message-cycle:initial") ?? null,
      };
      cycles.push(currentCycle);
    }

    if (!activityTurnIdByCycleId.has(currentCycle.id)) {
      for (const turnId of workflowTurnIdsForRow(row)) {
        if (!input.activityTurnIds.has(turnId)) continue;
        currentCycle.activityTurnId = turnId;
      }
    }
  }

  const lastCycle = cycles.at(-1);
  if (lastCycle && input.runningTurnId !== null && input.activityTurnIds.has(input.runningTurnId)) {
    lastCycle.activityTurnId = input.runningTurnId;
  }

  return cycles;
}

/**
 * Resolve the message cycle at a fixed line below the viewport top. Adjacent
 * transitions use a small symmetric dead-band to avoid flicker around a user
 * message boundary; non-adjacent jumps (minimap, keyboard, programmatic
 * navigation, or a fast wheel gesture) resolve their destination directly.
 */
export function resolveActiveTimelineActivityCycle(input: {
  readonly cycles: ReadonlyArray<TimelineActivityCycle>;
  readonly state: TimelineActivityPositionState;
  readonly currentCycleId: string | null;
  readonly leadingCycleId?: string | null;
  readonly activationOffset?: number;
  readonly hysteresis?: number;
  readonly leadingAllowance?: number;
}): TimelineActivityCycle | null {
  if (input.cycles.length === 0) return null;

  const scroll = input.state.scroll;
  const activationLine =
    (typeof scroll === "number" && Number.isFinite(scroll) ? scroll : 0) +
    (input.activationOffset ?? TIMELINE_ACTIVITY_ACTIVATION_OFFSET);
  const cycleTops = input.cycles.map((cycle) => {
    const top = input.state.positionAtIndex?.(cycle.startRowIndex);
    return typeof top === "number" && Number.isFinite(top) ? top : null;
  });
  const leadingAllowance = Math.max(
    0,
    input.leadingAllowance ?? TIMELINE_RUNNING_ACTIVITY_LEADING_ALLOWANCE,
  );
  const cycleActivationTops = cycleTops.map((top, index) =>
    top !== null && input.cycles[index]?.id === input.leadingCycleId ? top - leadingAllowance : top,
  );

  let candidateIndex = 0;
  let foundMeasuredCycle = false;
  let foundCycleAtOrAboveLine = false;
  for (let index = 0; index < input.cycles.length; index += 1) {
    const top = cycleActivationTops[index];
    if (top == null) continue;
    foundMeasuredCycle = true;
    if (top <= activationLine) {
      candidateIndex = index;
      foundCycleAtOrAboveLine = true;
    }
    if (top > activationLine) break;
  }

  const currentIndex = input.cycles.findIndex((cycle) => cycle.id === input.currentCycleId);
  if (!foundMeasuredCycle || !foundCycleAtOrAboveLine) {
    return input.cycles[currentIndex >= 0 ? currentIndex : 0] ?? null;
  }
  if (currentIndex < 0 || candidateIndex === currentIndex) {
    return input.cycles[candidateIndex] ?? null;
  }
  if (Math.abs(candidateIndex - currentIndex) > 1) {
    return input.cycles[candidateIndex] ?? null;
  }

  const hysteresis = Math.max(0, input.hysteresis ?? TIMELINE_ACTIVITY_CYCLE_HYSTERESIS);
  if (candidateIndex > currentIndex) {
    const candidateTop = cycleActivationTops[candidateIndex];
    if (candidateTop != null && candidateTop > activationLine - hysteresis) {
      return input.cycles[currentIndex] ?? null;
    }
  } else {
    const currentTop = cycleActivationTops[currentIndex];
    if (currentTop != null && currentTop <= activationLine + hysteresis) {
      return input.cycles[currentIndex] ?? null;
    }
  }

  return input.cycles[candidateIndex] ?? null;
}

/**
 * A sole workflow has no contextual alternative, so keep it selected until
 * the user closes its card. With multiple workflows, keep the running one
 * selected while the timeline is live-following. Overlay and inset
 * measurements can temporarily make LegendList report that it is not at the
 * end; those layout-only events must not switch the sticky workflow surface.
 * A real navigation gesture restores position-based selection when there are
 * multiple workflow-bearing cycles.
 */
export function resolveDisplayedTimelineActivityCycle(input: {
  readonly cycles: ReadonlyArray<TimelineActivityCycle>;
  readonly state: TimelineActivityPositionState;
  readonly currentCycleId: string | null;
  readonly runningCycle: TimelineActivityCycle | null;
  readonly isAtEnd: boolean | undefined;
  readonly userNavigated: boolean;
}): TimelineActivityCycle | null {
  const activityCycles = input.cycles.filter((cycle) => cycle.activityTurnId !== null);
  if (activityCycles.length === 1) {
    return activityCycles[0] ?? null;
  }

  if (input.runningCycle !== null && (input.isAtEnd === true || !input.userNavigated)) {
    return input.runningCycle;
  }

  return resolveActiveTimelineActivityCycle({
    cycles: input.cycles,
    state: input.state,
    currentCycleId: input.currentCycleId,
    leadingCycleId: input.runningCycle?.id ?? null,
  });
}

/**
 * The pinned surface is chosen from the scroll offset, and the card it renders
 * is an overlay whose measured height becomes part of the list's bottom inset.
 * Letting a scroll offset drop the pin therefore unmounts the card, shrinks the
 * inset, and moves the very offset that chose the cycle — the list flickers as
 * the card opens and closes. So a cycle that carries no workflow of its own
 * keeps the last workflow surface pinned; only another workflow-bearing cycle
 * takes over, and only the thread's own data (or an explicit close) clears it.
 */
export function resolveStickyWorkflowActivityTurnId(input: {
  readonly resolvedCycle: TimelineActivityCycle | null;
  readonly currentTurnId: TurnId | null;
  readonly cycles: ReadonlyArray<TimelineActivityCycle>;
}): TurnId | null {
  const resolvedTurnId = input.resolvedCycle?.activityTurnId ?? null;
  if (resolvedTurnId !== null) {
    return resolvedTurnId;
  }
  if (input.currentTurnId === null) {
    return null;
  }
  // A pin whose turn no longer appears in the timeline is stale, not sticky.
  return input.cycles.some((cycle) => cycle.activityTurnId === input.currentTurnId)
    ? input.currentTurnId
    : null;
}

export interface TimelineExtentState {
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/**
 * Whether the list is resting on its last pixel. LegendList's own `isAtEnd`
 * carries a tolerance, so it still answers "yes" a notch or two above the
 * bottom; re-arming end-following on that answer would undo the reader's
 * scroll. This measures the extent instead.
 */
export function resolveTimelineIsAtExactEnd(
  state: TimelineExtentState | undefined,
): boolean | undefined {
  const contentLength = state?.contentLength;
  const scroll = state?.scroll;
  const scrollLength = state?.scrollLength;
  if (
    typeof contentLength !== "number" ||
    typeof scroll !== "number" ||
    typeof scrollLength !== "number" ||
    !Number.isFinite(contentLength) ||
    !Number.isFinite(scroll) ||
    !Number.isFinite(scrollLength)
  ) {
    return undefined;
  }
  return scroll + scrollLength >= contentLength - 2;
}

/**
 * Whether LegendList should keep re-anchoring the list to its end.
 *
 * LegendList maintains the end for any layout change while the offset is
 * within its near-end threshold, so a reader who has nudged up a notch is
 * still "at the end" to it — and the next bottom-inset change (a pinned card
 * mounting, an approval card growing the composer) drags them back down. A
 * manual gesture therefore drops end-following outright, and only a scroll
 * that lands exactly on the end re-arms it.
 */
export function resolveTimelineEndFollowing(input: {
  readonly current: boolean;
  readonly manualNavigation: boolean;
  readonly isAtExactEnd: boolean | undefined;
}): boolean {
  if (input.manualNavigation) {
    return false;
  }
  if (input.isAtExactEnd === true) {
    return true;
  }
  return input.current;
}

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
}

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  return state?.isNearEnd ?? state?.isAtEnd;
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

export const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom or a
 * narrow pane. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      onlyToolEntries: boolean;
      onlyTaskEntries: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: TurnId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

// ---------------------------------------------------------------------------
// Task (subagent/workflow) entries — distinct card path and transcript
// visibility gating. Task entries bypass neutral-status filtering because
// `workLogEntryIsToolLike` (session-logic) already excludes them.
// ---------------------------------------------------------------------------

/** True when a work entry carries subagent/workflow task identity and must render as a task card. */
export function workLogEntryIsTaskLike(entry: Pick<WorkLogEntry, "taskId">): boolean {
  return entry.taskId !== undefined && entry.taskId.length > 0;
}

/** Activity kinds whose content is projected into the workflow activity panel only — never timeline rows. */
const PANEL_ONLY_WORK_ACTIVITY_KINDS: ReadonlySet<OrchestrationThreadActivity["kind"]> = new Set([
  "tool.progress",
  "turn.reasoning.summary",
]);

/**
 * Timeline visibility gate. `skipTranscript` tasks stay in the workflow
 * activity panel but are removed from the transcript before grouping, hidden
 * counts, toggle construction, stable row creation, and rendering; panel-only
 * activity projections never become timeline rows.
 */
export function workEntryIsTranscriptVisible(entry: WorkLogEntry): boolean {
  if (entry.skipTranscript === true) {
    return false;
  }
  if (
    entry.sourceActivityKind !== undefined &&
    PANEL_ONLY_WORK_ACTIVITY_KINDS.has(entry.sourceActivityKind)
  ) {
    return false;
  }
  return true;
}

/**
 * A finished thread task wakes its parent by injecting its results as a `user`
 * message — that is what makes the provider act on them. Nobody typed it, so
 * the transcript must not show it as a user bubble; the `task.finished`
 * lifecycle row carries the wake-up instead, with the text behind a disclosure.
 */
export function messageEntryIsTranscriptVisible(
  message: Pick<ChatMessage, "role" | "source">,
): boolean {
  return !isTaskResultMessage(message);
}

/**
 * Task lifecycle rows belong to the thread-tasks beta, so they disappear with
 * it. The wake-up message stays suppressed either way — a message nobody typed
 * must never render as a user bubble, whatever the beta is set to.
 */
export function threadTaskEntryIsTranscriptVisible(
  entry: Pick<WorkLogEntry, "threadTask">,
  threadTasksEnabled: boolean,
): boolean {
  return threadTasksEnabled || entry.threadTask === undefined;
}

export function formatTaskTokenCount(totalTokens: number): string {
  return `${totalTokens.toLocaleString("en-US")} ${totalTokens === 1 ? "token" : "tokens"}`;
}

export function formatTaskToolUseCount(toolUses: number): string {
  return `${toolUses.toLocaleString("en-US")} ${toolUses === 1 ? "tool" : "tools"}`;
}

/**
 * Compact metric fragments for a task card (tokens, tool count, duration,
 * last tool). Only values the provider actually supplied are included — no
 * placeholders that imply measured values.
 */
export function deriveTaskCardMetricParts(
  entry: Pick<WorkLogEntry, "usage" | "lastToolName">,
): string[] {
  const parts: string[] = [];
  const usage = entry.usage;
  if (usage?.totalTokens !== undefined) {
    parts.push(formatTaskTokenCount(usage.totalTokens));
  }
  if (usage?.toolUses !== undefined) {
    parts.push(formatTaskToolUseCount(usage.toolUses));
  }
  if (usage?.durationMs !== undefined) {
    parts.push(formatDuration(usage.durationMs));
  }
  const lastToolName = entry.lastToolName?.trim();
  if (lastToolName) {
    parts.push(`last: ${lastToolName}`);
  }
  return parts;
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

/**
 * Accessibility contract for interactive task-card expansion. The native
 * button supplies click and Enter/Space behavior; these attributes keep its
 * expanded state linked to the always-mounted detail region. A card without
 * expandable detail exposes no disclosure attributes.
 */
export function resolveTaskCardExpansionA11y(input: {
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly detailRegionId: string;
}): {
  readonly "aria-expanded"?: boolean;
  readonly "aria-controls"?: string;
} {
  if (!input.expandable) {
    return {};
  }
  return {
    "aria-expanded": input.expanded,
    "aria-controls": input.detailRegionId,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface TurnFold {
  turnId: TurnId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

/**
 * The session's running turn is authoritative when latestTurn briefly lags or
 * regresses behind it. Otherwise, the latest turn counts as unsettled while it
 * is still running (or has not recorded a completion). This is deliberately
 * keyed on turn lifecycle rather than transient working state: right after the
 * user sends a message, the previous turn is still the "active" one until the
 * server creates the new turn, and folding must not flicker through that window.
 */
function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

/**
 * Settled turns fold their commentary and tool activity behind a
 * "Worked for ..." row anchored at the turn's first foldable entry; the
 * terminal assistant message stays visible below the fold.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
}): ReadonlyMap<string, TurnFold> {
  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * The user message that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>();

  let pendingUserBoundary: string | null = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId =
      entry.kind === "message" && entry.message.role === "assistant"
        ? (entry.message.turnId ?? null)
        : entry.kind === "work"
          ? (entry.entry.turnId ?? null)
          : null;
    if (!turnId) {
      continue;
    }
    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [turnId, group] of groupsByTurnId) {
    if (turnId === input.unsettledTurnId) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    for (const entry of group.entries) {
      if (entry.id !== group.terminalEntry?.id) {
        hiddenEntryIds.add(entry.id);
      }
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      input.latestTurn?.turnId === turnId &&
      input.latestTurn.startedAt &&
      input.latestTurn.completedAt
        ? computeElapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorEntryId.set(firstEntry.id, {
      turnId,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorEntryId;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn?: TimelineLatestTurn | null;
  runningTurnId?: TurnId | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
  /**
   * Thread-tasks beta. Defaults off, matching the setting, so a caller that
   * predates the beta cannot surface its rows by omission.
   */
  threadTasksEnabled?: boolean;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  // Remove transcript-hidden tasks, panel-only activity projections, and
  // task-result wake-ups up front so they cannot leak into folds, grouping,
  // hidden counts, toggle labels, stable rows, or rendering downstream.
  const timelineEntries = input.timelineEntries.filter((entry) =>
    entry.kind === "work"
      ? workEntryIsTranscriptVisible(entry.entry) &&
        threadTaskEntryIsTranscriptVisible(entry.entry, input.threadTasksEnabled === true)
      : entry.kind === "message"
        ? messageEntryIsTranscriptVisible(entry.message)
        : true,
  );
  const durationStartByMessageId = computeMessageDurationStart(
    timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(timelineEntries);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
  });
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedTurnIds?.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.turnId}`,
        createdAt: turnFold.createdAt,
        turnId: turnFold.turnId,
        label: turnFold.label,
        expanded: input.expandedTurnIds?.has(turnFold.turnId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < timelineEntries.length) {
        const nextEntry = timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter(
        (entry) => !workEntryIndicatesToolNeutralStatus(entry),
      );
      if (visibleGroupedEntries.length > 0) {
        if (visibleGroupedEntries.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
          });
        } else {
          const groupId = `work-group:${timelineEntry.id}`;
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const hiddenEntries = visibleGroupedEntries.slice(0, -MAX_VISIBLE_WORK_LOG_ENTRIES);
          const visibleEntries = visibleGroupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES);
          const renderedEntries = expanded ? [...hiddenEntries, ...visibleEntries] : visibleEntries;

          for (const workEntry of renderedEntries) {
            nextRows.push({
              kind: "work",
              id: workEntry.id,
              createdAt: workEntry.createdAt,
              groupedEntries: [workEntry],
            });
          }

          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            groupId,
            hiddenCount: hiddenEntries.length,
            expanded,
            onlyToolEntries: visibleGroupedEntries.every((entry) => workLogEntryIsToolLike(entry)),
            onlyTaskEntries: visibleGroupedEntries.every((entry) => workLogEntryIsTaskLike(entry)),
          });
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      unsettledTurnId !== null &&
      timelineEntry.message.turnId === unsettledTurnId;

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantTurnStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "turn-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "work":
      return Equal.equals(a.groupedEntries, (b as typeof a).groupedEntries);

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.onlyToolEntries === bw.onlyToolEntries &&
        a.onlyTaskEntries === bw.onlyTaskEntries
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
