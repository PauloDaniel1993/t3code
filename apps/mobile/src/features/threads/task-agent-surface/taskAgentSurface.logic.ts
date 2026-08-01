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
    statusLine: projection.status.label,
    tone: projection.status.tone,
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
    statusLine: projection.statusLine,
    tone: projection.status.tone,
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
