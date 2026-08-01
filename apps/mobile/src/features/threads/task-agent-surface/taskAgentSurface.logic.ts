import type {
  FailedAgentAttribution,
  NativeAgentOutcomeRollup,
  NativeAgentProjection,
  NativeAgentStatusProjection,
  NativeAgentTurnProjection,
  TaskAgentModel,
  TaskAgentThreadSummary,
  TaskProjection,
  TaskStatusProjection,
} from "./taskAgentModel";
import type {
  AgentTranscriptAffordance,
  SteeringAvailability,
  TaskRowAffordances,
} from "./taskAgentNavigation";

/** The status shape shared by task and provider-native agent rows. */
export type TaskAgentRowStatus = TaskStatusProjection | NativeAgentStatusProjection;

export type TaskAgentRowTone = TaskAgentRowStatus["tone"];

export type TaskAgentRowGlyph = "◷" | "✦" | "✓" | "×" | "−" | "?";

/** Navigation is always either actionable or an explicit unavailable reason. */
export type TaskAgentRowNavigation = TaskRowAffordances | AgentTranscriptAffordance;

export type TaskAgentRowFailure =
  | Readonly<{
      readonly kind: "task";
      readonly reason: Extract<TaskStatusProjection, { readonly kind: "failed" }>["reason"];
    }>
  | Readonly<{
      readonly kind: "native-agent";
      readonly attribution: FailedAgentAttribution;
    }>;

/**
 * The turn context an agent row belongs to. Keeping the projected outcome
 * intact means its branch-specific counters and failure tuple remain the
 * render boundary's source of truth.
 */
export type TaskAgentRowTurnContext = Readonly<{
  readonly key: NativeAgentTurnProjection["key"];
  readonly turnId: NativeAgentTurnProjection["turnId"];
  readonly label: string;
  readonly outcome: NativeAgentOutcomeRollup;
}>;

/**
 * One turn row shared by task and thread rollups. Agent rows are nested here,
 * preserving thread → task → turn → agent ownership.
 */
export interface TaskAgentTurnRowViewModel {
  readonly kind: "native-agent-turn";
  readonly key: NativeAgentTurnProjection["key"];
  readonly turnId: NativeAgentTurnProjection["turnId"];
  readonly label: string;
  readonly expandedByDefault: boolean;
  readonly outcome: NativeAgentOutcomeRollup;
  readonly agents: ReadonlyArray<TaskAgentRowViewModel>;
}

/**
 * Common row anatomy for tasks and provider-native in-session agents.
 *
 * Both variants deliberately have the same fields. Provider-specific data is
 * carried in `nativeAgent` rather than by giving agents a second row type.
 * `unread` is a render signal supplied by the projection adapter; this module
 * never persists, mutates, or derives read state.
 */
export interface TaskAgentRowViewModel {
  readonly kind: "task" | "native-agent";
  readonly id: string;
  readonly title: string;
  readonly status: TaskAgentRowStatus;
  readonly statusLabel: string;
  readonly statusLine: string;
  readonly tone: TaskAgentRowTone;
  readonly glyph: TaskAgentRowGlyph;
  readonly elapsedLabel: string | null;
  readonly unread: boolean;
  readonly returnedToParent: boolean;
  readonly failure: TaskAgentRowFailure | null;
  readonly steering: SteeringAvailability;
  readonly navigation: TaskAgentRowNavigation;
  readonly turn: TaskAgentRowTurnContext | null;
  readonly turns: ReadonlyArray<TaskAgentTurnRowViewModel>;
  readonly nativeAgent: NativeAgentProjection | null;
}

export type TaskAgentThreadRowViewModel =
  | Readonly<{
      readonly kind: "plain-thread";
      readonly key: string;
      readonly thread: TaskAgentThreadSummary;
      readonly unread: false;
    }>
  | Readonly<{
      readonly kind: "rollup-thread";
      readonly key: string;
      readonly thread: TaskAgentThreadSummary;
      readonly unread: boolean;
      readonly rollup: Readonly<{
        readonly kind: "rollup";
        readonly taskCount: number;
        readonly nativeAgentCount: number;
        readonly runningTaskCount: number;
        readonly chipLabel: string;
        readonly expandedByDefault: boolean;
        readonly tasks: ReadonlyArray<TaskAgentRowViewModel>;
        readonly nativeAgentTurns: ReadonlyArray<TaskAgentTurnRowViewModel>;
      }>;
    }>;

export interface TaskAgentSurfaceViewModel {
  readonly kind: TaskAgentModel["kind"];
  readonly nativeAgentWindow: TaskAgentModel["nativeAgentWindow"];
  readonly threads: ReadonlyArray<TaskAgentThreadRowViewModel>;
}

export type TaskAgentRollupThreadRowViewModel = Extract<
  TaskAgentThreadRowViewModel,
  { readonly kind: "rollup-thread" }
>;

const NATIVE_AGENT_WINDOW_LABEL = "Latest turn plus anything still running";
const NATIVE_AGENT_WINDOW_HINT = "agents from the latest turn plus anything still running";

export interface TaskAgentDisclosureContent {
  /** The projected count label is always shown verbatim in the chip. */
  readonly chipLabel: string;
  /** Visible only beside the expanded nested rows. */
  readonly expandedQualification: string | null;
  /** Keeps the bounded native-agent window available to assistive technology. */
  readonly accessibilityHint: string;
}

/**
 * Resolve disclosure copy without deriving counts at the render boundary.
 * The compact chip remains terse while the expanded surface and accessibility
 * hint preserve the projection's bounded native-agent-window qualification.
 */
export function buildTaskAgentDisclosureContent(
  row: TaskAgentRollupThreadRowViewModel,
  expanded: boolean,
): TaskAgentDisclosureContent {
  const contents: string[] = [];
  if (row.rollup.taskCount > 0) contents.push("this thread's tasks");
  if (row.rollup.nativeAgentCount > 0) contents.push(NATIVE_AGENT_WINDOW_HINT);

  return {
    chipLabel: row.rollup.chipLabel,
    expandedQualification:
      expanded && row.rollup.nativeAgentCount > 0 ? `Agents: ${NATIVE_AGENT_WINDOW_LABEL}` : null,
    accessibilityHint: `${expanded ? "Collapses" : "Shows"} ${contents.join(" and ")}`,
  };
}

/** The UI only changes the established thread-row tree for actual rollups. */
export function shouldIntegrateTaskAgentDisclosure(
  row: TaskAgentThreadRowViewModel | undefined,
): row is TaskAgentRollupThreadRowViewModel {
  return row?.kind === "rollup-thread";
}

export interface TaskAgentListPresentationState {
  readonly row: TaskAgentThreadRowViewModel;
  readonly expanded: boolean;
}

export type TaskAgentListEntry =
  | Readonly<{
      readonly kind: "entity-row";
      readonly key: string;
      readonly nestingLevel: 0 | 1 | 2;
      readonly row: TaskAgentRowViewModel;
    }>
  | Readonly<{
      readonly kind: "turn-row";
      readonly key: string;
      readonly nestingLevel: 0 | 1;
      readonly turn: TaskAgentTurnRowViewModel;
      readonly expanded: boolean;
      readonly unread: boolean;
      readonly returnedToParent: boolean;
    }>;

export type TaskAgentTurnExpansionOverrides = ReadonlyMap<string, boolean>;

export type TaskAgentRowBuildInput = Readonly<{
  readonly projection: TaskProjection;
  /** Explicit render signal; the adapter does not calculate unread state. */
  readonly unread: boolean;
}>;

export type NativeAgentRowBuildInput = Readonly<{
  readonly projection: NativeAgentProjection;
  readonly turn: NativeAgentTurnProjection;
  /** Explicit render signal; native-agent projections do not own read state. */
  readonly unread: boolean;
}>;

function taskFailure(status: TaskStatusProjection): TaskAgentRowFailure | null {
  return status.kind === "failed" ? { kind: "task", reason: status.reason } : null;
}

function nativeAgentFailure(status: NativeAgentStatusProjection): TaskAgentRowFailure | null {
  return status.kind === "failed" ? { kind: "native-agent", attribution: status.failure } : null;
}

function rowGlyph(status: TaskAgentRowStatus): TaskAgentRowGlyph {
  switch (status.kind) {
    case "queued":
      return "◷";
    case "running":
      return "✦";
    case "finished":
      return "✓";
    case "failed":
      return "×";
    case "cancelled":
      return "−";
    case "metadata-unavailable":
    case "unavailable":
      return "?";
  }
}

function taskStatusLine(status: TaskStatusProjection): string {
  switch (status.kind) {
    case "failed":
    case "cancelled":
    case "metadata-unavailable":
      return `${status.label} — ${status.reason}`;
    case "queued":
    case "running":
    case "finished":
      return status.label;
  }
}

function nativeAgentStatusLine(projection: NativeAgentProjection): string {
  switch (projection.status.kind) {
    case "failed":
      return `${projection.statusLine} — ${projection.status.failure.reason}`;
    case "unavailable":
      return `${projection.statusLine} — ${projection.status.reason}`;
    case "running":
    case "finished":
      return projection.statusLine;
  }
}

function turnContext(turn: NativeAgentTurnProjection): TaskAgentRowTurnContext {
  return {
    key: turn.key,
    turnId: turn.turnId,
    label: turn.label,
    outcome: turn.outcome,
  };
}

function buildTurnRow(turn: NativeAgentTurnProjection): TaskAgentTurnRowViewModel {
  return {
    kind: "native-agent-turn",
    key: turn.key,
    turnId: turn.turnId,
    label: turn.label,
    expandedByDefault: turn.expandedByDefault,
    outcome: turn.outcome,
    agents: turn.agents.map((agent) =>
      buildNativeAgentRow({ projection: agent, turn, unread: false }),
    ),
  };
}

/** Adapt one projected task into the common render-ready row anatomy. */
export function buildTaskAgentRow(input: TaskAgentRowBuildInput): TaskAgentRowViewModel {
  const { projection } = input;
  return {
    kind: "task",
    id: projection.thread.id,
    title: projection.thread.title,
    status: projection.status,
    statusLabel: projection.status.label,
    statusLine: taskStatusLine(projection.status),
    tone: projection.status.tone,
    glyph: rowGlyph(projection.status),
    elapsedLabel: null,
    unread: input.unread,
    returnedToParent: projection.returnedToParent,
    failure: taskFailure(projection.status),
    steering: projection.steering,
    navigation: projection.navigation,
    turn: null,
    turns: projection.nativeAgentTurns.map(buildTurnRow),
    nativeAgent: null,
  };
}

/** Adapt one projected native agent into the same row anatomy as a task. */
export function buildNativeAgentRow(input: NativeAgentRowBuildInput): TaskAgentRowViewModel {
  const { projection, turn } = input;
  return {
    kind: "native-agent",
    id: projection.id,
    title: projection.description,
    status: projection.status,
    statusLabel: projection.status.label,
    statusLine: nativeAgentStatusLine(projection),
    tone: projection.status.tone,
    glyph: rowGlyph(projection.status),
    elapsedLabel: projection.elapsed === "" ? null : projection.elapsed,
    unread: input.unread,
    returnedToParent: false,
    failure: nativeAgentFailure(projection.status),
    steering: projection.steering,
    navigation: projection.transcript,
    turn: turnContext(turn),
    turns: [],
    nativeAgent: projection,
  };
}

function buildThreadRow(
  projection: TaskAgentModel["threads"][number],
): TaskAgentThreadRowViewModel {
  if (projection.kind === "plain-thread") {
    return {
      kind: "plain-thread",
      key: projection.key,
      thread: projection.thread,
      unread: projection.hasUnreadTaskResults,
    };
  }

  return {
    kind: "rollup-thread",
    key: projection.key,
    thread: projection.thread,
    unread: projection.hasUnreadTaskResults,
    rollup: {
      kind: "rollup",
      taskCount: projection.rollup.taskCount,
      nativeAgentCount: projection.rollup.nativeAgentCount,
      runningTaskCount: projection.rollup.runningTaskCount,
      chipLabel: projection.rollup.chipLabel,
      expandedByDefault: projection.rollup.expandedByDefault,
      tasks: projection.rollup.tasks.map((task) =>
        buildTaskAgentRow({ projection: task, unread: task.hasUnreadTaskResults }),
      ),
      nativeAgentTurns: projection.rollup.nativeAgentTurns.map(buildTurnRow),
    },
  };
}

/**
 * Adapt the landed task/turn/agent projection without recomputing any
 * lifecycle count or reading the clock. The projection's plain/rollup union
 * and bounded-window wording are retained at the render boundary.
 */
export function buildTaskAgentSurfaceViewModel(
  projection: TaskAgentModel,
): TaskAgentSurfaceViewModel {
  return {
    kind: projection.kind,
    nativeAgentWindow: projection.nativeAgentWindow,
    threads: projection.threads.map(buildThreadRow),
  };
}

/** Alias for callers that name the result after its row collection. */
export const buildTaskAgentSurfaceRows = buildTaskAgentSurfaceViewModel;

function turnExpanded(
  turn: TaskAgentTurnRowViewModel,
  overrides: TaskAgentTurnExpansionOverrides,
): boolean {
  return overrides.get(turn.key) ?? turn.expandedByDefault;
}

function appendTurnEntries(
  entries: TaskAgentListEntry[],
  turn: TaskAgentTurnRowViewModel,
  nestingLevel: 0 | 1,
  owner: TaskAgentRowViewModel | null,
  overrides: TaskAgentTurnExpansionOverrides,
): void {
  const expanded = turnExpanded(turn, overrides);
  entries.push({
    kind: "turn-row",
    key: `turn:${turn.key}`,
    nestingLevel,
    turn,
    expanded,
    unread: owner?.unread ?? false,
    returnedToParent: owner?.returnedToParent ?? false,
  });

  if (!expanded) return;
  const agentNestingLevel = (nestingLevel + 1) as 1 | 2;
  for (const agent of turn.agents) {
    entries.push({
      kind: "entity-row",
      key: `agent:${turn.key}:${agent.id}`,
      nestingLevel: agentNestingLevel,
      row: agent,
    });
  }
}

/**
 * Flatten one expanded thread into stable render entries without deriving any
 * count. Tasks and native agents deliberately share the same entity-row shape;
 * turn rows retain the projected outcome union and its legal counters.
 */
export function buildTaskAgentListEntries(
  row: TaskAgentRollupThreadRowViewModel,
  overrides: TaskAgentTurnExpansionOverrides = new Map(),
): ReadonlyArray<TaskAgentListEntry> {
  const entries: TaskAgentListEntry[] = [];

  for (const task of row.rollup.tasks) {
    entries.push({
      kind: "entity-row",
      key: `task:${task.id}`,
      nestingLevel: 0,
      row: task,
    });
    for (const turn of task.turns) {
      appendTurnEntries(entries, turn, 1, task, overrides);
    }
  }

  for (const turn of row.rollup.nativeAgentTurns) {
    appendTurnEntries(entries, turn, 0, null, overrides);
  }

  return entries;
}

/** Render equality used by memoized list rows; arrays are immutable outputs. */
export function taskAgentThreadRowsRenderEqual(
  previous: TaskAgentThreadRowViewModel,
  next: TaskAgentThreadRowViewModel,
): boolean {
  if (Object.is(previous, next)) return true;
  if (previous.kind !== next.kind || previous.key !== next.key || previous.unread !== next.unread) {
    return false;
  }
  if (previous.kind === "plain-thread" || next.kind === "plain-thread") return true;

  return (
    previous.rollup.chipLabel === next.rollup.chipLabel &&
    previous.rollup.taskCount === next.rollup.taskCount &&
    previous.rollup.nativeAgentCount === next.rollup.nativeAgentCount &&
    previous.rollup.runningTaskCount === next.rollup.runningTaskCount &&
    previous.rollup.expandedByDefault === next.rollup.expandedByDefault &&
    previous.rollup.tasks === next.rollup.tasks &&
    previous.rollup.nativeAgentTurns === next.rollup.nativeAgentTurns
  );
}

/** The task-specific portion of the outer thread-row memo comparator. */
export function taskAgentListPresentationStateEqual(
  previous: TaskAgentListPresentationState,
  next: TaskAgentListPresentationState,
): boolean {
  return (
    previous.expanded === next.expanded && taskAgentThreadRowsRenderEqual(previous.row, next.row)
  );
}
