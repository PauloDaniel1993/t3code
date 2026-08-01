import type { EnvironmentId, ThreadId, ThreadTaskStatus, TurnId } from "@t3tools/contracts";

/** The params understood by the existing root `Thread` route. */
export type ThreadRouteParams = Readonly<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}>;

/** A thread identity used when a destination points at an existing thread. */
export type ThreadIdentity = ThreadRouteParams;

/**
 * A task is a thread. Keep its task id required at the input boundary, then
 * translate it to the root navigator's `threadId` param in one place.
 */
export type TaskIdentity = Readonly<{
  readonly environmentId: EnvironmentId;
  readonly taskId: ThreadId;
}>;

export type TaskRowTapMode = "peek" | "push";

export type TaskAgentNavigationConfig = Readonly<{
  /** The one destination selected for the task-row tap everywhere. */
  readonly taskRowTap: TaskRowTapMode;
}>;

/**
 * Provisional default: the mockups lean toward a task-row tap opening a peek
 * sheet, with an explicit "Open thread" affordance for the full view. This
 * remains provisional until both mappings have been tried on a device.
 */
export const DEFAULT_TASK_AGENT_NAVIGATION_CONFIG = {
  taskRowTap: "peek",
} as const satisfies TaskAgentNavigationConfig;

/**
 * These are the contexts in which the surface can expose a task row. They are
 * an inventory for callers and tests, not an input to the resolver: allowing a
 * context to select its own mapping would make peek-vs-push inconsistent.
 */
export const TASK_ROW_CONTEXTS = ["thread-list", "task-peek", "full-task-view"] as const;

export type TaskRowContext = (typeof TASK_ROW_CONTEXTS)[number];

export type TaskDestination =
  | Readonly<{
      readonly kind: "peek";
      readonly presentation: "sheet";
      readonly route: "TaskPeek";
      readonly params: ThreadRouteParams;
    }>
  | Readonly<{
      readonly kind: "thread";
      readonly presentation: "push";
      readonly route: "Thread";
      readonly params: ThreadRouteParams;
    }>;

/** Resolve the single task-row tap mapping; deliberately has no context arg. */
export function resolveTaskRowTapDestination(
  task: TaskIdentity,
  config: TaskAgentNavigationConfig,
): TaskDestination {
  const params: ThreadRouteParams = {
    environmentId: task.environmentId,
    threadId: task.taskId,
  };

  if (config.taskRowTap === "peek") {
    return {
      kind: "peek",
      presentation: "sheet",
      route: "TaskPeek",
      params,
    };
  }

  return {
    kind: "thread",
    presentation: "push",
    route: "Thread",
    params,
  };
}

export type TaskRowAlternativeAffordance = Readonly<{
  readonly kind: "alternative-affordance";
  readonly action: "open-thread" | "peek-task";
  readonly label: "Open thread" | "Peek at task";
  readonly destination: TaskDestination;
}>;

export type TaskRowAffordances = Readonly<{
  /** The destination performed by the row's one primary tap. */
  readonly tap: TaskDestination;
  /** The other destination, exposed through a separately labelled affordance. */
  readonly alternative: TaskRowAlternativeAffordance;
}>;

/**
 * Give every task row both destinations while keeping its primary gesture
 * governed by the same resolver used by every context.
 */
export function resolveTaskRowAffordances(
  task: TaskIdentity,
  config: TaskAgentNavigationConfig,
): TaskRowAffordances {
  const tap = resolveTaskRowTapDestination(task, config);
  const alternativeMode: TaskRowTapMode = config.taskRowTap === "peek" ? "push" : "peek";
  const alternativeDestination = resolveTaskRowTapDestination(task, {
    taskRowTap: alternativeMode,
  });

  return {
    tap,
    alternative:
      alternativeMode === "push"
        ? {
            kind: "alternative-affordance",
            action: "open-thread",
            label: "Open thread",
            destination: alternativeDestination,
          }
        : {
            kind: "alternative-affordance",
            action: "peek-task",
            label: "Peek at task",
            destination: alternativeDestination,
          },
  };
}

/** The subset of a native agent needed to describe its identity. */
export type NativeAgentIdentity = Readonly<{
  /** Provider-native id; this is not a T3 thread id. */
  readonly taskId: string;
  readonly turnId: TurnId | null;
}>;

export type AgentTranscriptLookup = Readonly<{
  readonly owningThread: ThreadIdentity;
  readonly agent: NativeAgentIdentity;
}>;

export type AgentTranscriptDestination = Readonly<{
  readonly kind: "thread-transcript";
  readonly route: "Thread";
  readonly params: ThreadRouteParams;
  /** Focus data a future transcript lookup would have to provide. */
  readonly focus: Readonly<{
    readonly turnId: TurnId;
    readonly transcriptEntryId: string;
  }>;
}>;

export type AgentTranscriptAffordance =
  | Readonly<{
      readonly kind: "available";
      readonly destination: AgentTranscriptDestination;
    }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly reason: string;
    }>;

/**
 * Honest current fallback: no destination. ThreadNativeAgent has no
 * transcript message/card identifier, so routing to the owning thread would
 * not be a route to this agent's exact transcript position.
 */
export const AGENT_TRANSCRIPT_UNAVAILABLE_REASON =
  "The exact transcript location is unavailable: provider-native agents carry no transcript message or card identifier.";

export function resolveAgentTranscriptAffordance(
  lookup: AgentTranscriptLookup,
): AgentTranscriptAffordance {
  // Keep the owning thread and the agent in the API so a future contract-backed
  // lookup can produce the available branch without changing callers.
  void lookup;
  return {
    kind: "unavailable",
    reason: AGENT_TRANSCRIPT_UNAVAILABLE_REASON,
  };
}

export type SteeringSubject =
  | Readonly<{
      readonly kind: "task";
      readonly task: TaskIdentity;
      readonly status: ThreadTaskStatus;
    }>
  | Readonly<{
      readonly kind: "native-agent";
      readonly agent: NativeAgentIdentity;
    }>;

export type SteeringAvailability =
  | Readonly<{ readonly kind: "available" }>
  | Readonly<{
      readonly kind: "unavailable";
      readonly reason: string;
    }>;

/** Exact reason shown for every provider-native non-steerable subject. */
export const NATIVE_AGENT_NOT_STEERABLE_REASON =
  "This provider-native agent runs inside the turn that spawned it and cannot be steered independently; steer that turn instead.";

export function resolveSteeringAvailability(subject: SteeringSubject): SteeringAvailability {
  if (subject.kind === "native-agent") {
    return {
      kind: "unavailable",
      reason: NATIVE_AGENT_NOT_STEERABLE_REASON,
    };
  }

  switch (subject.status) {
    case "running":
    case "finished":
      return { kind: "available" };
    case "queued":
      return {
        kind: "unavailable",
        reason: "This task has not started yet, so there is no active turn to steer.",
      };
    case "failed":
      return {
        kind: "unavailable",
        reason: "This task failed; retry it before sending another instruction.",
      };
    case "cancelled":
      return {
        kind: "unavailable",
        reason: "This task was cancelled; retry it before sending another instruction.",
      };
  }
}
