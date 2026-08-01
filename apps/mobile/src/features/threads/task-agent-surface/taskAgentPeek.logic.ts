import type { TaskDestination, TaskRowAffordances, ThreadRouteParams } from "./taskAgentNavigation";
import type {
  TaskAgentRowViewModel,
  TaskAgentSurfaceViewModel,
  TaskAgentTurnRowViewModel,
} from "./taskAgentSurface.logic";

/**
 * The task branch deliberately reuses the existing task destination shape:
 * a task is a thread, so its required threadId is the exact task id.
 */
export type TaskPeekTaskRouteParams = ThreadRouteParams;

/**
 * Native agents need both their owning thread and their provider-native id.
 * Each identity field is required; there is no default subject to fall back to.
 */
export type TaskPeekAgentRouteParams = Readonly<{
  readonly environmentId: ThreadRouteParams["environmentId"];
  readonly threadId: ThreadRouteParams["threadId"];
  readonly agentId: string;
}>;

export type TaskAgentPeekAction = Readonly<{
  readonly kind: "open-task-thread";
  /** Always the exact task destination projected by taskAgentNavigation. */
  readonly destination: Extract<TaskDestination, { readonly kind: "thread" }>;
}>;

export type TaskAgentPeekControl = Readonly<{
  readonly id: "open-task" | "steer" | "show-in-transcript";
  readonly label: string;
  readonly availability:
    | Readonly<{ readonly kind: "action"; readonly action: TaskAgentPeekAction }>
    | Readonly<{ readonly kind: "unavailable"; readonly reason: string }>;
}>;

type TaskPeekResolutionBase = Readonly<{
  readonly row: TaskAgentRowViewModel;
  readonly nativeAgentWindow: TaskAgentSurfaceViewModel["nativeAgentWindow"];
}>;

export type TaskAgentPeekResolution =
  | (TaskPeekResolutionBase &
      Readonly<{
        readonly kind: "task";
        readonly route: TaskPeekTaskRouteParams;
        readonly parentThreadId: TaskPeekTaskRouteParams["threadId"];
        readonly turns: ReadonlyArray<TaskAgentTurnRowViewModel>;
      }>)
  | (TaskPeekResolutionBase &
      Readonly<{
        readonly kind: "native-agent";
        readonly route: TaskPeekAgentRouteParams;
        readonly turns: readonly [TaskAgentTurnRowViewModel];
      }>);

export type TaskAgentPeekLabels = Readonly<{
  readonly title: "Task peek" | "Agent peek";
  readonly closeLabel: "Close task peek" | "Close agent peek";
}>;

export type TaskAgentPeekCloseAction =
  | Readonly<{ readonly kind: "go-back" }>
  | Readonly<{ readonly kind: "navigate"; readonly route: "Home" }>;

/** Choose a close destination without depending on a navigator or renderer. */
export function resolveTaskAgentPeekCloseAction(canGoBack: boolean): TaskAgentPeekCloseAction {
  return canGoBack ? { kind: "go-back" } : { kind: "navigate", route: "Home" };
}

export function taskAgentPeekLabels(kind: TaskAgentPeekResolution["kind"]): TaskAgentPeekLabels {
  return kind === "task"
    ? { title: "Task peek", closeLabel: "Close task peek" }
    : { title: "Agent peek", closeLabel: "Close agent peek" };
}

export type TaskAgentPeekTurnSection = Readonly<{
  readonly title: "Turn agents";
  readonly emptyMessage: string | null;
}>;

const NO_TURN_AGENTS_MESSAGE = "No provider-native agents are available in this bounded window.";

function taskAgentPeekTurnSection(
  turns: ReadonlyArray<TaskAgentTurnRowViewModel>,
): TaskAgentPeekTurnSection {
  return {
    title: "Turn agents",
    emptyMessage: turns.length === 0 ? NO_TURN_AGENTS_MESSAGE : null,
  };
}

export type TaskAgentPeekViewModel = Readonly<{
  readonly kind: TaskAgentPeekResolution["kind"];
  readonly title: TaskAgentPeekLabels["title"];
  readonly closeLabel: TaskAgentPeekLabels["closeLabel"];
  /** The common row is rendered unchanged for task and native-agent peeks. */
  readonly row: TaskAgentRowViewModel;
  /** These are projected turns, not a locally re-derived rollup. */
  readonly turns: ReadonlyArray<TaskAgentTurnRowViewModel>;
  readonly turnAgents: TaskAgentPeekTurnSection;
  /** Makes the bounded native-agent window explicit rather than implying history. */
  readonly nativeAgentWindow: TaskAgentSurfaceViewModel["nativeAgentWindow"];
  readonly controls: ReadonlyArray<TaskAgentPeekControl>;
}>;

function taskAffordances(row: TaskAgentRowViewModel): TaskRowAffordances {
  if ("tap" in row.navigation && "alternative" in row.navigation) {
    return row.navigation;
  }

  throw new Error("Task peek expected task navigation affordances.");
}

function taskThreadDestination(
  affordances: TaskRowAffordances,
): Extract<TaskDestination, { readonly kind: "thread" }> {
  const destination =
    affordances.tap.kind === "thread" ? affordances.tap : affordances.alternative.destination;

  if (destination.kind !== "thread") {
    throw new Error("Task peek expected an exact thread destination for this task.");
  }

  return destination;
}

function unavailableReason(
  availability: TaskAgentRowViewModel["steering"],
  control: string,
): string {
  if (availability.kind === "unavailable") return availability.reason;

  throw new Error(`${control} was unexpectedly available for a provider-native agent.`);
}

function agentTranscriptReason(row: TaskAgentRowViewModel): string {
  if (
    "kind" in row.navigation &&
    row.navigation.kind === "unavailable" &&
    row.navigation.reason.trim().length > 0
  ) {
    return row.navigation.reason;
  }

  // The current provider contract has no transcript identifier. Refusing to
  // render an imprecise route is preferable to silently opening its owner.
  throw new Error("Task peek expected an explicit unavailable agent transcript affordance.");
}

function taskControls(row: TaskAgentRowViewModel): ReadonlyArray<TaskAgentPeekControl> {
  const destination = taskThreadDestination(taskAffordances(row));
  const openTask: TaskAgentPeekControl = {
    id: "open-task",
    label: "Open task",
    availability: {
      kind: "action",
      action: { kind: "open-task-thread", destination },
    },
  };

  if (row.steering.kind === "unavailable") {
    return [
      openTask,
      {
        id: "steer",
        label: "Steering unavailable",
        availability: { kind: "unavailable", reason: row.steering.reason },
      },
    ];
  }

  // The task row's primary tap already brought the user here. Keep its
  // projected alternative (the full task thread) discoverable as one honest
  // control instead of presenting two labels for the same destination.
  return [openTask];
}

function nativeAgentControls(row: TaskAgentRowViewModel): ReadonlyArray<TaskAgentPeekControl> {
  return [
    {
      id: "steer",
      label: "Steering unavailable",
      availability: {
        kind: "unavailable",
        reason: unavailableReason(row.steering, "Steering"),
      },
    },
    {
      id: "show-in-transcript",
      label: "Transcript location unavailable",
      availability: {
        kind: "unavailable",
        reason: agentTranscriptReason(row),
      },
    },
  ];
}

function resolveUniqueAgentInTurns(
  turns: ReadonlyArray<TaskAgentTurnRowViewModel>,
  agentId: string,
): Readonly<{
  readonly row: TaskAgentRowViewModel;
  readonly turn: TaskAgentTurnRowViewModel;
}> | null {
  let match: Readonly<{
    readonly row: TaskAgentRowViewModel;
    readonly turn: TaskAgentTurnRowViewModel;
  }> | null = null;

  for (const turn of turns) {
    for (const agent of turn.agents) {
      if (agent.id !== agentId) continue;
      // Do not pick an arbitrary match if a provider ever reuses an id.
      if (match !== null) return null;
      match = { row: agent, turn };
    }
  }

  return match;
}

function resolveTaskPeek(
  surface: TaskAgentSurfaceViewModel,
  params: TaskPeekTaskRouteParams,
): TaskAgentPeekResolution | null {
  for (const thread of surface.threads) {
    if (thread.kind !== "rollup-thread" || thread.thread.environmentId !== params.environmentId) {
      continue;
    }

    const row = thread.rollup.tasks.find((task) => task.id === params.threadId);
    if (row === undefined) continue;

    return {
      kind: "task",
      route: params,
      parentThreadId: thread.thread.id,
      row,
      turns: row.turns,
      nativeAgentWindow: surface.nativeAgentWindow,
    };
  }

  return null;
}

function resolveAgentPeek(
  surface: TaskAgentSurfaceViewModel,
  params: TaskPeekAgentRouteParams,
): TaskAgentPeekResolution | null {
  if (params.agentId.length === 0) return null;

  for (const thread of surface.threads) {
    if (thread.kind !== "rollup-thread" || thread.thread.environmentId !== params.environmentId) {
      continue;
    }

    const ownerTurns =
      thread.thread.id === params.threadId
        ? thread.rollup.nativeAgentTurns
        : (thread.rollup.tasks.find((task) => task.id === params.threadId)?.turns ?? []);
    const match = resolveUniqueAgentInTurns(ownerTurns, params.agentId);
    if (match === null) continue;

    return {
      kind: "native-agent",
      route: params,
      row: match.row,
      turns: [match.turn],
      nativeAgentWindow: surface.nativeAgentWindow,
    };
  }

  return null;
}

/**
 * Resolve only the task identity supplied by the TaskPeek route. An absent or
 * stale id has no substitute target, so task B cannot silently render task A.
 */
export function resolveTaskPeekRoute(input: {
  readonly surface: TaskAgentSurfaceViewModel;
  readonly params: TaskPeekTaskRouteParams;
}): TaskAgentPeekResolution | null {
  return resolveTaskPeek(input.surface, input.params);
}

/**
 * Resolve only the native-agent identity supplied by the TaskAgentPeek route.
 * Its required agentId cannot be dropped and reinterpreted as an owning task.
 */
export function resolveTaskAgentPeekRoute(input: {
  readonly surface: TaskAgentSurfaceViewModel;
  readonly params: TaskPeekAgentRouteParams;
}): TaskAgentPeekResolution | null {
  return resolveAgentPeek(input.surface, input.params);
}

/** Build the thin sheet model from the shared row and projected turn anatomy. */
export function buildTaskAgentPeek(resolution: TaskAgentPeekResolution): TaskAgentPeekViewModel {
  const labels = taskAgentPeekLabels(resolution.kind);
  return {
    kind: resolution.kind,
    ...labels,
    row: resolution.row,
    turns: resolution.turns,
    turnAgents: taskAgentPeekTurnSection(resolution.turns),
    nativeAgentWindow: resolution.nativeAgentWindow,
    controls:
      resolution.kind === "task"
        ? taskControls(resolution.row)
        : nativeAgentControls(resolution.row),
  };
}
