import {
  hasUnreadTaskResults as sharedHasUnreadTaskResults,
  type TaskLinkedThread,
} from "@t3tools/client-runtime/state/thread-tasks";
import type { ThreadId } from "@t3tools/contracts";

/** The persisted representation used by the task-agent model: a date string. */
export type TaskAgentReadTimestamp = string;

export interface TaskAgentReadState {
  /** Device-owned visit markers; this module does not persist or mutate them. */
  readonly lastVisitedAtByThreadId: ReadonlyMap<ThreadId, TaskAgentReadTimestamp>;
}

/**
 * Cold-start behavior is a product decision, not an accidental consequence of
 * a missing map entry. Keep both branches named so a future policy change is
 * explicit at the call site and covered by the tests.
 */
export const TASK_AGENT_COLD_START_POLICIES = {
  unread: "unread",
  read: "read",
} as const;

export type TaskAgentColdStartPolicy =
  (typeof TASK_AGENT_COLD_START_POLICIES)[keyof typeof TASK_AGENT_COLD_START_POLICIES];

/** A cold start with no evidence of a prior read is intentionally unread. */
export const DEFAULT_TASK_AGENT_COLD_START_POLICY: TaskAgentColdStartPolicy =
  TASK_AGENT_COLD_START_POLICIES.unread;

export interface MarkTaskAgentThreadsVisitedInput {
  readonly parentThreadId: ThreadId;
  readonly taskThreadId: ThreadId;
  /** Runtime validation keeps malformed persisted or boundary input harmless. */
  readonly visitedAt: unknown;
}

export interface TaskAgentUnreadQueryInput {
  readonly taskSummary?: TaskLinkedThread["taskSummary"];
  readonly lastVisitedAt: TaskAgentReadTimestamp | undefined;
  readonly coldStartPolicy?: TaskAgentColdStartPolicy;
}

export interface TaskAgentThreadUnreadQueryInput extends Omit<
  TaskAgentUnreadQueryInput,
  "lastVisitedAt"
> {
  readonly readState: TaskAgentReadState;
  readonly threadId: ThreadId;
}

export function createTaskAgentReadState(): TaskAgentReadState {
  return { lastVisitedAtByThreadId: new Map() };
}

function timestampMilliseconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-")) return null;

  const milliseconds = Date.parse(trimmed);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

function copyReadMarkers(state: TaskAgentReadState): Map<ThreadId, TaskAgentReadTimestamp> {
  return new Map(state.lastVisitedAtByThreadId);
}

/**
 * Record a visit for the task and its parent together. Each marker is
 * monotonic, and the returned map is always a fresh immutable-by-convention
 * value so callers can safely retain the previous state.
 */
export function markTaskAgentThreadsVisited(
  state: TaskAgentReadState,
  input: MarkTaskAgentThreadsVisitedInput,
): TaskAgentReadState {
  const nextMarkers = copyReadMarkers(state);
  const visitedAtMilliseconds = timestampMilliseconds(input.visitedAt);
  if (visitedAtMilliseconds === null) {
    return { ...state, lastVisitedAtByThreadId: nextMarkers };
  }

  const visitedAt = input.visitedAt;
  if (typeof visitedAt !== "string") {
    return { ...state, lastVisitedAtByThreadId: nextMarkers };
  }

  const threadIds =
    input.parentThreadId === input.taskThreadId
      ? [input.parentThreadId]
      : [input.parentThreadId, input.taskThreadId];

  for (const threadId of threadIds) {
    const currentAt = nextMarkers.get(threadId);
    const currentMilliseconds = timestampMilliseconds(currentAt);
    if (currentMilliseconds !== null && currentMilliseconds >= visitedAtMilliseconds) continue;
    nextMarkers.set(threadId, visitedAt);
  }

  return { ...state, lastVisitedAtByThreadId: nextMarkers };
}

/**
 * Apply the named cold-start policy, then delegate every actual unread
 * comparison to the shared client-runtime rule. This wrapper adds policy; it
 * does not create a second timestamp comparison.
 */
export function hasUnreadTaskResults(input: TaskAgentUnreadQueryInput): boolean {
  const coldStartPolicy = input.coldStartPolicy ?? DEFAULT_TASK_AGENT_COLD_START_POLICY;

  if (input.lastVisitedAt === undefined) {
    if (coldStartPolicy === TASK_AGENT_COLD_START_POLICIES.read) return false;
    return sharedHasUnreadTaskResults({
      taskSummary: input.taskSummary,
      lastVisitedAt: undefined,
    });
  }

  return sharedHasUnreadTaskResults({
    taskSummary: input.taskSummary,
    lastVisitedAt: input.lastVisitedAt,
  });
}

/** Query unread state for either the parent or task marker tracked in the map. */
export function hasUnreadTaskResultForThread(input: TaskAgentThreadUnreadQueryInput): boolean {
  return hasUnreadTaskResults({
    taskSummary: input.taskSummary,
    lastVisitedAt: input.readState.lastVisitedAtByThreadId.get(input.threadId),
    coldStartPolicy: input.coldStartPolicy,
  });
}
