import type { FailedAgentAttribution, NativeAgentOutcomeRollup } from "./taskAgentModel";
import type { ThreadRouteParams } from "./taskAgentNavigation";
import { effectiveContrast, WCAG_TEXT_CONTRAST_THRESHOLD } from "./taskAgentContrast";
import type {
  TaskAgentRowViewModel,
  TaskAgentSurfaceViewModel,
  TaskAgentTurnRowViewModel,
} from "./taskAgentSurface.logic";
import { getTaskAgentTheme, type TaskAgentThemeMode } from "./taskAgentTheme";

export const TASK_AGENT_TASK_SURFACE_UNAVAILABLE_REASON =
  "This exact task is not available in the current mobile task projection.";

export const TASK_AGENT_UNAVAILABLE_COMPOSER_ANCESTOR_OPACITIES = [] as const;

export type TaskAgentTaskComposerPresentation =
  | Readonly<{
      readonly kind: "available";
      readonly placeholder: "Steer this task…" | "Message this task…";
    }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly reason: string;
    }>;

export type TaskAgentTaskSurfaceAction =
  | Readonly<{ readonly kind: "compose" }>
  | Readonly<{
      readonly kind: "toggle-turn";
      readonly turnKey: TaskAgentTurnRowViewModel["key"];
    }>;

export type TaskAgentTaskSurfaceActionControl = Readonly<{
  readonly id: string;
  readonly label: string;
  readonly availability: Readonly<{
    readonly kind: "action";
    readonly action: TaskAgentTaskSurfaceAction;
  }>;
}>;

export type TaskAgentTaskSurfaceUnavailableControl = Readonly<{
  readonly id: string;
  readonly label: string;
  readonly availability: Readonly<{
    readonly kind: "unavailable";
    readonly reason: string;
  }>;
}>;

export type TaskAgentTaskSurfaceControl =
  | TaskAgentTaskSurfaceActionControl
  | TaskAgentTaskSurfaceUnavailableControl;

export type TaskAgentTurnFailureAccess =
  | Readonly<{ readonly kind: "none" }>
  | Readonly<{
      readonly kind: "reachable";
      readonly failures: readonly [FailedAgentAttribution, ...FailedAgentAttribution[]];
      readonly through: TaskAgentTaskSurfaceActionControl;
    }>;

export interface TaskAgentTaskTurnViewModel {
  readonly row: TaskAgentTurnRowViewModel;
  readonly disclosure: TaskAgentTaskSurfaceActionControl;
  readonly failureAccess: TaskAgentTurnFailureAccess;
}

export interface TaskAgentTaskSurfaceViewModel {
  readonly kind: "task-thread-surface";
  readonly route: ThreadRouteParams;
  readonly parentThreadId: ThreadRouteParams["threadId"];
  readonly row: TaskAgentRowViewModel;
  readonly turns: ReadonlyArray<TaskAgentTaskTurnViewModel>;
  readonly nativeAgentWindow: TaskAgentSurfaceViewModel["nativeAgentWindow"];
  readonly composer: TaskAgentTaskComposerPresentation;
  readonly controls: ReadonlyArray<TaskAgentTaskSurfaceControl>;
}

export interface TaskAgentTaskSurfaceUnavailableViewModel {
  readonly kind: "task-thread-surface-unavailable";
  readonly route: ThreadRouteParams;
  readonly title: string;
  readonly reason: string;
  readonly composer: Extract<TaskAgentTaskComposerPresentation, { readonly kind: "unavailable" }>;
  readonly controls: readonly [TaskAgentTaskSurfaceControl];
}

export type TaskAgentTaskSurfacePresentation =
  | TaskAgentTaskSurfaceViewModel
  | TaskAgentTaskSurfaceUnavailableViewModel;

function nonEmptyReason(reason: string, context: string): string {
  if (reason.trim().length === 0) {
    throw new Error(`${context} must state a non-empty refusal reason.`);
  }
  return reason;
}

export function resolveTaskAgentComposer(
  row: TaskAgentRowViewModel,
): TaskAgentTaskComposerPresentation {
  if (row.steering.kind === "unavailable") {
    return {
      kind: "unavailable",
      reason: nonEmptyReason(row.steering.reason, `${row.kind} composer`),
    };
  }

  if (row.kind === "native-agent") {
    throw new Error("A provider-native agent cannot expose an independently steerable composer.");
  }

  return {
    kind: "available",
    placeholder: row.status.kind === "running" ? "Steer this task…" : "Message this task…",
  };
}

function composerControl(composer: TaskAgentTaskComposerPresentation): TaskAgentTaskSurfaceControl {
  return composer.kind === "available"
    ? {
        id: "composer",
        label: "Send an instruction",
        availability: { kind: "action", action: { kind: "compose" } },
      }
    : {
        id: "composer",
        label: "Composer unavailable",
        availability: {
          kind: "unavailable",
          reason: nonEmptyReason(composer.reason, "Task composer control"),
        },
      };
}

function turnDisclosureControl(turn: TaskAgentTurnRowViewModel): TaskAgentTaskSurfaceActionControl {
  return {
    id: `turn:${turn.key}`,
    label: turn.label,
    availability: {
      kind: "action",
      action: { kind: "toggle-turn", turnKey: turn.key },
    },
  };
}

function nativeAgentSteeringControl(
  turn: TaskAgentTurnRowViewModel,
  agent: TaskAgentRowViewModel,
): TaskAgentTaskSurfaceControl {
  if (agent.kind !== "native-agent" || agent.steering.kind !== "unavailable") {
    throw new Error("A task turn contained a provider-native agent without a steering refusal.");
  }

  return {
    id: `agent-steering:${turn.key}:${agent.id}`,
    label: `Steering unavailable for ${agent.title}`,
    availability: {
      kind: "unavailable",
      reason: nonEmptyReason(agent.steering.reason, "Provider-native agent steering control"),
    },
  };
}

function failedCounter(
  outcome: NativeAgentOutcomeRollup,
): Extract<NativeAgentOutcomeRollup["counters"][number], { readonly kind: "failed" }> | null {
  switch (outcome.kind) {
    case "failure-only":
      return outcome.counter;
    case "mixed":
      return outcome.counters[1];
    case "not-started":
    case "outcome-unavailable":
    case "running":
    case "success-only":
      return null;
  }
}

function taskTurn(turn: TaskAgentTurnRowViewModel): TaskAgentTaskTurnViewModel {
  const disclosure = turnDisclosureControl(turn);
  const failure = failedCounter(turn.outcome);

  return {
    row: turn,
    disclosure,
    failureAccess:
      failure === null
        ? { kind: "none" }
        : {
            kind: "reachable",
            failures: failure.failures,
            through: disclosure,
          },
  };
}

/** Resolve only the environment/thread identity carried by the active Thread route. */
export function resolveTaskAgentTaskSurface(input: {
  readonly surface: TaskAgentSurfaceViewModel;
  readonly route: ThreadRouteParams;
}): TaskAgentTaskSurfaceViewModel | null {
  for (const parent of input.surface.threads) {
    if (
      parent.kind !== "rollup-thread" ||
      parent.thread.environmentId !== input.route.environmentId
    ) {
      continue;
    }

    const row = parent.rollup.tasks.find((task) => task.id === input.route.threadId);
    if (row === undefined) continue;

    const composer = resolveTaskAgentComposer(row);
    const turns = row.turns.map(taskTurn);
    const controls: TaskAgentTaskSurfaceControl[] = [composerControl(composer)];
    for (const turn of turns) {
      controls.push(turn.disclosure);
      for (const agent of turn.row.agents) {
        controls.push(nativeAgentSteeringControl(turn.row, agent));
      }
    }

    return {
      kind: "task-thread-surface",
      route: input.route,
      parentThreadId: parent.thread.id,
      row,
      turns,
      nativeAgentWindow: input.surface.nativeAgentWindow,
      composer,
      controls,
    };
  }

  return null;
}

export function buildUnavailableTaskAgentTaskSurface(input: {
  readonly route: ThreadRouteParams;
  readonly title: string;
}): TaskAgentTaskSurfaceUnavailableViewModel {
  const reason = TASK_AGENT_TASK_SURFACE_UNAVAILABLE_REASON;
  const composer = { kind: "unavailable", reason } as const;
  return {
    kind: "task-thread-surface-unavailable",
    route: input.route,
    title: input.title,
    reason,
    composer,
    controls: [composerControl(composer)],
  };
}

/** The unavailable composer is an opaque card: only foreground-over-surface contrast applies. */
export function taskAgentUnavailableComposerReasonContrast(mode: TaskAgentThemeMode): number {
  const theme = getTaskAgentTheme(mode);
  return effectiveContrast({
    foreground: theme.text.statedReason,
    background: theme.card,
    opacities: TASK_AGENT_UNAVAILABLE_COMPOSER_ANCESTOR_OPACITIES,
  });
}

export function taskAgentUnavailableComposerReasonMeetsContrast(mode: TaskAgentThemeMode): boolean {
  return taskAgentUnavailableComposerReasonContrast(mode) >= WCAG_TEXT_CONTRAST_THRESHOLD;
}
