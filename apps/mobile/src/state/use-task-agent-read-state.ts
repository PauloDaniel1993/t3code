import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import {
  MobilePreferencesStore,
  normalizeTaskAgentReadMarkers,
  type Preferences,
  type TaskAgentReadMarkers,
} from "../persistence/mobile-preferences";
import * as Runtime from "../lib/runtime";
import {
  createTaskAgentReadState,
  markTaskAgentThreadsVisited,
  type MarkTaskAgentThreadsVisitedInput,
  type TaskAgentReadState,
} from "./task-agent-read-state";

interface PendingVisit {
  readonly version: number;
  readonly input: MarkTaskAgentThreadsVisitedInput;
}

const EMPTY_TASK_AGENT_READ_STATE = createTaskAgentReadState();
const EMPTY_TASK_AGENT_READ_STATE_RESULT_ATOM = Atom.make(
  AsyncResult.success<TaskAgentReadState>(EMPTY_TASK_AGENT_READ_STATE),
).pipe(Atom.keepAlive, Atom.withLabel("mobile:task-agent-read-state:empty"));

export function taskAgentReadStateFromPreferences(preferences: Preferences): TaskAgentReadState {
  const markers = normalizeTaskAgentReadMarkers(preferences.taskAgentReadMarkers);
  return {
    lastVisitedAtByThreadId: new Map(
      Object.entries(markers).map(
        ([rawThreadId, visitedAt]) => [ThreadId.make(rawThreadId), visitedAt] as const,
      ),
    ),
  };
}

function taskAgentReadMarkersFromState(
  readState: TaskAgentReadState,
  prioritizedThreadIds: ReadonlyArray<ThreadId> = [],
): TaskAgentReadMarkers {
  return normalizeTaskAgentReadMarkers(
    Object.fromEntries(readState.lastVisitedAtByThreadId),
    prioritizedThreadIds,
  );
}

function applyVisit(
  readState: TaskAgentReadState,
  input: MarkTaskAgentThreadsVisitedInput,
): TaskAgentReadState {
  const visited = markTaskAgentThreadsVisited(readState, input);
  return taskAgentReadStateFromPreferences({
    taskAgentReadMarkers: taskAgentReadMarkersFromState(visited, [
      input.parentThreadId,
      input.taskThreadId,
    ]),
  });
}

/**
 * Owns one app-lifetime read-state instance. Pending visits are replayed over
 * hydration, while persistence applies the same pure visit transition to the
 * store's latest value under its serialized update lock.
 */
export function createTaskAgentReadStateState(runtime: Atom.AtomRuntime<MobilePreferencesStore>) {
  const storedPreferencesAtom = runtime
    .atom(
      MobilePreferencesStore.pipe(
        Effect.flatMap((store) => store.load),
        Effect.catch((error) =>
          Effect.logWarning("Could not load task-agent read markers.", error).pipe(
            Effect.as<Preferences>({}),
          ),
        ),
      ),
    )
    .pipe(Atom.keepAlive, Atom.withLabel("mobile:task-agent-read-state:stored"));

  const confirmedReadStateAtom = Atom.make<TaskAgentReadState | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile:task-agent-read-state:confirmed"),
  );
  const pendingVisitsAtom = Atom.make<ReadonlyArray<PendingVisit>>([]).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile:task-agent-read-state:pending"),
  );
  let nextVisitVersion = 0;

  const readStateAtom = Atom.make((get) => {
    const stored = get(storedPreferencesAtom);
    const confirmed = get(confirmedReadStateAtom);
    const pendingVisits = get(pendingVisitsAtom);

    if (confirmed !== null || pendingVisits.length > 0) {
      let readState =
        confirmed ??
        (AsyncResult.isSuccess(stored)
          ? taskAgentReadStateFromPreferences(stored.value)
          : createTaskAgentReadState());
      for (const pending of pendingVisits) readState = applyVisit(readState, pending.input);
      return AsyncResult.success(readState);
    }

    return AsyncResult.map(stored, taskAgentReadStateFromPreferences);
  }).pipe(Atom.keepAlive, Atom.withLabel("mobile:task-agent-read-state"));

  const markThreadsVisitedAtom = runtime
    .fn(
      (input: MarkTaskAgentThreadsVisitedInput, get) => {
        const version = ++nextVisitVersion;
        get.set(pendingVisitsAtom, [...get(pendingVisitsAtom), { version, input }]);

        const removePendingVisit = () => {
          get.set(
            pendingVisitsAtom,
            get(pendingVisitsAtom).filter((pending) => pending.version !== version),
          );
        };

        return MobilePreferencesStore.pipe(
          Effect.flatMap((store) =>
            store.update((current) => {
              const next = applyVisit(taskAgentReadStateFromPreferences(current), input);
              return {
                taskAgentReadMarkers: taskAgentReadMarkersFromState(next, [
                  input.parentThreadId,
                  input.taskThreadId,
                ]),
              };
            }),
          ),
          Effect.tap((saved) =>
            Effect.sync(() => {
              get.set(confirmedReadStateAtom, taskAgentReadStateFromPreferences(saved));
              removePendingVisit();
            }),
          ),
          Effect.tapError(() => Effect.sync(removePendingVisit)),
        );
      },
      { concurrent: true },
    )
    .pipe(Atom.keepAlive, Atom.withLabel("mobile:task-agent-read-state:mark-visited"));

  return { readStateAtom, markThreadsVisitedAtom } as const;
}

const taskAgentReadStateRuntime = Atom.runtime(Runtime.runtimeContextLayer);
export const taskAgentReadStateState = createTaskAgentReadStateState(taskAgentReadStateRuntime);
export const taskAgentReadStateAtom = taskAgentReadStateState.readStateAtom;
export const markTaskAgentThreadsVisitedAtom = taskAgentReadStateState.markThreadsVisitedAtom;

export interface UseTaskAgentReadState {
  readonly readState: TaskAgentReadState;
  readonly markThreadsVisited: (input: MarkTaskAgentThreadsVisitedInput) => void;
}

/** Shared read/write entry point for every mobile task-agent surface. */
export function useTaskAgentReadState(): UseTaskAgentReadState {
  return useTaskAgentReadStateWhenEnabled(true);
}

/**
 * Uses inert state outside a task surface so ordinary thread routes do not
 * subscribe to task-agent read state.
 */
export function useTaskAgentReadStateWhenEnabled(enabled: boolean): UseTaskAgentReadState {
  const readStateResult = useAtomValue(
    enabled ? taskAgentReadStateAtom : EMPTY_TASK_AGENT_READ_STATE_RESULT_ATOM,
  );
  const dispatchMarkThreadsVisited = useAtomSet(markTaskAgentThreadsVisitedAtom);
  const markThreadsVisited = useCallback(
    (input: MarkTaskAgentThreadsVisitedInput) => {
      if (enabled) dispatchMarkThreadsVisited(input);
    },
    [dispatchMarkThreadsVisited, enabled],
  );

  return {
    readState: AsyncResult.isSuccess(readStateResult)
      ? readStateResult.value
      : EMPTY_TASK_AGENT_READ_STATE,
    markThreadsVisited,
  };
}
