import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Scope from "effect/Scope";
import * as TxRef from "effect/TxRef";

import {
  metricAttributes,
  providerIngestionBackpressureDuration,
  providerIngestionCoalescedTotal,
  providerIngestionOldestEventAge,
  providerIngestionQueueDepth,
  providerIngestionTerminalLatency,
} from "../observability/Metrics.ts";
import type { ProviderEventDeliveryClass } from "./ProviderEventFlowControl.ts";

export interface ScheduledProviderInput<A> {
  readonly value: A;
  readonly laneKey: string;
  readonly provider: string;
  readonly deliveryClass: ProviderEventDeliveryClass;
  readonly replacementKey?: string;
  readonly mergeKey?: string;
  readonly terminal: boolean;
  readonly eventCreatedAtMs: number;
}

interface QueuedProviderInput<A> extends ScheduledProviderInput<A> {
  readonly enqueuedAtMs: number;
}

interface ProviderLane<A> {
  readonly entries: ReadonlyArray<QueuedProviderInput<A>>;
}

interface SchedulerState<A> {
  readonly lanes: ReadonlyMap<string, ProviderLane<A>>;
  readonly readyLaneKeys: ReadonlyArray<string>;
  readonly queuedByMetricKey: ReadonlyMap<string, number>;
  readonly queuedCount: number;
  readonly processingCount: number;
  readonly pendingEnqueueCount: number;
  readonly coalescedCount: number;
  readonly backpressureCount: number;
  readonly closed: boolean;
}

export interface ProviderIngestionSchedulerStats {
  readonly queuedCount: number;
  readonly processingCount: number;
  readonly pendingEnqueueCount: number;
  readonly laneCount: number;
  readonly coalescedCount: number;
  readonly backpressureCount: number;
}

export interface ProviderIngestionScheduler<A> {
  readonly enqueue: (input: ScheduledProviderInput<A>) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
  readonly stats: Effect.Effect<ProviderIngestionSchedulerStats>;
}

export interface ProviderIngestionSchedulerOptions<A> {
  readonly perLaneCapacity: number;
  readonly reservedLosslessCapacity: number;
  readonly merge: (current: A, incoming: A) => A | undefined;
  readonly pressureWarningThresholdMs?: number;
}

type OfferResult =
  | {
      readonly _tag: "accepted";
      readonly coalesced: boolean;
      readonly provider: string;
      readonly deliveryClass: ProviderEventDeliveryClass;
      readonly metricDepth: number;
    }
  | {
      readonly _tag: "blocked";
      readonly provider: string;
      readonly deliveryClass: ProviderEventDeliveryClass;
      readonly metricDepth: number;
    }
  | { readonly _tag: "closed" };

interface TakeResult<A> {
  readonly input: QueuedProviderInput<A>;
  readonly metricDepth: number;
}

const metricKey = (provider: string, deliveryClass: ProviderEventDeliveryClass): string =>
  `${provider}\u0000${deliveryClass}`;

const updateMetricDepth = (
  counts: ReadonlyMap<string, number>,
  input: Pick<ScheduledProviderInput<unknown>, "provider" | "deliveryClass">,
  delta: number,
): { readonly counts: ReadonlyMap<string, number>; readonly depth: number } => {
  const key = metricKey(input.provider, input.deliveryClass);
  const countsNext = new Map(counts);
  const depth = Math.max(0, (counts.get(key) ?? 0) + delta);
  if (depth === 0) {
    countsNext.delete(key);
  } else {
    countsNext.set(key, depth);
  }
  return { counts: countsNext, depth };
};

const replaceAt = <A>(
  entries: ReadonlyArray<QueuedProviderInput<A>>,
  index: number,
  input: QueuedProviderInput<A>,
): ReadonlyArray<QueuedProviderInput<A>> => [
  ...entries.slice(0, index),
  input,
  ...entries.slice(index + 1),
];

function offerInput<A>(
  state: SchedulerState<A>,
  input: QueuedProviderInput<A>,
  options: ProviderIngestionSchedulerOptions<A>,
): { readonly state: SchedulerState<A>; readonly result: OfferResult } {
  if (state.closed) {
    return { state, result: { _tag: "closed" } };
  }

  const lane = state.lanes.get(input.laneKey) ?? { entries: [] };
  const entries = lane.entries;
  if (input.deliveryClass === "replaceable" && input.replacementKey !== undefined) {
    const existingIndex = entries.findIndex(
      (entry) =>
        entry.deliveryClass === "replaceable" && entry.replacementKey === input.replacementKey,
    );
    if (existingIndex >= 0) {
      const existing = entries[existingIndex]!;
      const lanes = new Map(state.lanes);
      lanes.set(input.laneKey, {
        entries: replaceAt(entries, existingIndex, {
          ...input,
          enqueuedAtMs: existing.enqueuedAtMs,
        }),
      });
      return {
        state: {
          ...state,
          lanes,
          coalescedCount: state.coalescedCount + 1,
        },
        result: {
          _tag: "accepted",
          coalesced: true,
          provider: input.provider,
          deliveryClass: input.deliveryClass,
          metricDepth:
            state.queuedByMetricKey.get(metricKey(input.provider, input.deliveryClass)) ?? 0,
        },
      };
    }
  }

  if (input.deliveryClass === "mergeable" && input.mergeKey !== undefined) {
    const lastIndex = entries.length - 1;
    const last = entries[lastIndex];
    if (
      last !== undefined &&
      last.deliveryClass === "mergeable" &&
      last.mergeKey === input.mergeKey
    ) {
      const merged = options.merge(last.value, input.value);
      if (merged !== undefined) {
        const lanes = new Map(state.lanes);
        lanes.set(input.laneKey, {
          entries: replaceAt(entries, lastIndex, {
            ...last,
            value: merged,
          }),
        });
        return {
          state: {
            ...state,
            lanes,
            coalescedCount: state.coalescedCount + 1,
          },
          result: {
            _tag: "accepted",
            coalesced: true,
            provider: input.provider,
            deliveryClass: input.deliveryClass,
            metricDepth:
              state.queuedByMetricKey.get(metricKey(input.provider, input.deliveryClass)) ?? 0,
          },
        };
      }
    }
  }

  const replaceableCount = entries.filter((entry) => entry.deliveryClass === "replaceable").length;
  const replaceableCapacity = options.perLaneCapacity - options.reservedLosslessCapacity;
  const capacityUnavailable =
    entries.length >= options.perLaneCapacity ||
    (input.deliveryClass === "replaceable" && replaceableCount >= replaceableCapacity);
  if (capacityUnavailable) {
    return {
      state,
      result: {
        _tag: "blocked",
        provider: input.provider,
        deliveryClass: input.deliveryClass,
        metricDepth:
          state.queuedByMetricKey.get(metricKey(input.provider, input.deliveryClass)) ?? 0,
      },
    };
  }

  const lanes = new Map(state.lanes);
  lanes.set(input.laneKey, { entries: [...entries, input] });
  const depthUpdate = updateMetricDepth(state.queuedByMetricKey, input, 1);
  return {
    state: {
      ...state,
      lanes,
      readyLaneKeys:
        entries.length === 0 ? [...state.readyLaneKeys, input.laneKey] : state.readyLaneKeys,
      queuedByMetricKey: depthUpdate.counts,
      queuedCount: state.queuedCount + 1,
    },
    result: {
      _tag: "accepted",
      coalesced: false,
      provider: input.provider,
      deliveryClass: input.deliveryClass,
      metricDepth: depthUpdate.depth,
    },
  };
}

function takeNext<A>(
  state: SchedulerState<A>,
): { readonly state: SchedulerState<A>; readonly result: TakeResult<A> } | undefined {
  const laneKey = state.readyLaneKeys[0];
  if (laneKey === undefined) {
    return undefined;
  }
  const lane = state.lanes.get(laneKey);
  const input = lane?.entries[0];
  if (lane === undefined || input === undefined) {
    return undefined;
  }

  const remainingEntries = lane.entries.slice(1);
  const lanes = new Map(state.lanes);
  if (remainingEntries.length === 0) {
    lanes.delete(laneKey);
  } else {
    lanes.set(laneKey, { entries: remainingEntries });
  }
  const depthUpdate = updateMetricDepth(state.queuedByMetricKey, input, -1);
  return {
    state: {
      ...state,
      lanes,
      readyLaneKeys:
        remainingEntries.length === 0
          ? state.readyLaneKeys.slice(1)
          : [...state.readyLaneKeys.slice(1), laneKey],
      queuedByMetricKey: depthUpdate.counts,
      queuedCount: state.queuedCount - 1,
      processingCount: state.processingCount + 1,
    },
    result: {
      input,
      metricDepth: depthUpdate.depth,
    },
  };
}

const schedulerStats = <A>(state: SchedulerState<A>): ProviderIngestionSchedulerStats => ({
  queuedCount: state.queuedCount,
  processingCount: state.processingCount,
  pendingEnqueueCount: state.pendingEnqueueCount,
  laneCount: state.lanes.size,
  coalescedCount: state.coalescedCount,
  backpressureCount: state.backpressureCount,
});

const metricLabels = (
  provider: string,
  deliveryClass: ProviderEventDeliveryClass,
): ReadonlyArray<[string, string]> =>
  metricAttributes({
    provider,
    eventClass: deliveryClass,
  });

export const makeProviderIngestionScheduler = <A, E, R>(
  options: ProviderIngestionSchedulerOptions<A>,
  process: (input: A) => Effect.Effect<void, E, R>,
): Effect.Effect<ProviderIngestionScheduler<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const initialState: SchedulerState<A> = {
      lanes: new Map(),
      readyLaneKeys: [],
      queuedByMetricKey: new Map(),
      queuedCount: 0,
      processingCount: 0,
      pendingEnqueueCount: 0,
      coalescedCount: 0,
      backpressureCount: 0,
      closed: false,
    };
    const stateRef = yield* TxRef.make(initialState);

    const offerOnce = (input: QueuedProviderInput<A>) =>
      TxRef.modify(stateRef, (state) => {
        const transition = offerInput(state, input, options);
        const nextState =
          transition.result._tag === "blocked"
            ? {
                ...transition.state,
                pendingEnqueueCount: transition.state.pendingEnqueueCount + 1,
                backpressureCount: transition.state.backpressureCount + 1,
              }
            : transition.state;
        return [transition.result, nextState] as const;
      }).pipe(Effect.tx);

    const offerBlocking = (input: QueuedProviderInput<A>) =>
      TxRef.get(stateRef).pipe(
        Effect.flatMap((state) => {
          const transition = offerInput(state, input, options);
          if (transition.result._tag === "blocked") {
            return Effect.txRetry;
          }
          return TxRef.set(stateRef, transition.state).pipe(Effect.as(transition.result));
        }),
        Effect.tx,
      );

    const take = TxRef.get(stateRef).pipe(
      Effect.flatMap((state) => {
        const transition = takeNext(state);
        if (transition === undefined) {
          return Effect.txRetry;
        }
        return TxRef.set(stateRef, transition.state).pipe(Effect.as(transition.result));
      }),
      Effect.tx,
    );

    const complete = TxRef.update(stateRef, (state) => ({
      ...state,
      processingCount: Math.max(0, state.processingCount - 1),
    })).pipe(Effect.tx);

    yield* Effect.gen(function* () {
      const taken = yield* take;
      const labels = metricLabels(taken.input.provider, taken.input.deliveryClass);
      yield* Metric.update(
        Metric.withAttributes(providerIngestionQueueDepth, labels),
        taken.metricDepth,
      );
      const processingStartedAtMs = yield* Clock.currentTimeMillis;
      const queuedAgeMs = Math.max(0, processingStartedAtMs - taken.input.enqueuedAtMs);
      yield* Metric.update(
        Metric.withAttributes(providerIngestionOldestEventAge, labels),
        Duration.millis(queuedAgeMs),
      );
      if (queuedAgeMs >= (options.pressureWarningThresholdMs ?? 1_000)) {
        yield* Effect.logWarning("provider ingestion queue age exceeded threshold", {
          provider: taken.input.provider,
          eventClass: taken.input.deliveryClass,
          queueAgeMs: queuedAgeMs,
        });
      }
      yield* process(taken.input.value).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (taken.input.terminal) {
              const completedAtMs = yield* Clock.currentTimeMillis;
              yield* Metric.update(
                Metric.withAttributes(providerIngestionTerminalLatency, labels),
                Duration.millis(Math.max(0, completedAtMs - taken.input.eventCreatedAtMs)),
              );
            }
            yield* complete;
          }),
        ),
      );
    }).pipe(Effect.forever, Effect.forkScoped);

    yield* Effect.addFinalizer(() =>
      TxRef.update(stateRef, (state) => ({ ...state, closed: true })).pipe(
        Effect.tx,
        Effect.asVoid,
      ),
    );

    const enqueue = (input: ScheduledProviderInput<A>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const enqueuedAtMs = yield* Clock.currentTimeMillis;
        const queuedInput = { ...input, enqueuedAtMs };
        const initial = yield* offerOnce(queuedInput);
        if (initial._tag === "closed") {
          return;
        }
        if (initial._tag === "accepted") {
          const labels = metricLabels(initial.provider, initial.deliveryClass);
          yield* Metric.update(
            Metric.withAttributes(providerIngestionQueueDepth, labels),
            initial.metricDepth,
          );
          if (initial.coalesced) {
            yield* Metric.update(Metric.withAttributes(providerIngestionCoalescedTotal, labels), 1);
          }
          return;
        }

        const backpressureStartedAtMs = yield* Clock.currentTimeMillis;
        const accepted = yield* offerBlocking(queuedInput).pipe(
          Effect.ensuring(
            TxRef.update(stateRef, (state) => ({
              ...state,
              pendingEnqueueCount: Math.max(0, state.pendingEnqueueCount - 1),
            })).pipe(Effect.tx),
          ),
        );
        if (accepted._tag === "closed") {
          return;
        }
        const backpressureEndedAtMs = yield* Clock.currentTimeMillis;
        const backpressureMs = Math.max(0, backpressureEndedAtMs - backpressureStartedAtMs);
        const labels = metricLabels(accepted.provider, accepted.deliveryClass);
        yield* Metric.update(
          Metric.withAttributes(providerIngestionBackpressureDuration, labels),
          Duration.millis(backpressureMs),
        );
        yield* Metric.update(
          Metric.withAttributes(providerIngestionQueueDepth, labels),
          accepted.metricDepth,
        );
        if (backpressureMs >= (options.pressureWarningThresholdMs ?? 1_000)) {
          yield* Effect.logWarning("provider ingestion enqueue applied backpressure", {
            provider: accepted.provider,
            eventClass: accepted.deliveryClass,
            backpressureMs,
          });
        }
      });

    const drain = TxRef.get(stateRef).pipe(
      Effect.flatMap((state) =>
        state.queuedCount === 0 && state.processingCount === 0 && state.pendingEnqueueCount === 0
          ? Effect.void
          : Effect.txRetry,
      ),
      Effect.tx,
    );

    const stats = TxRef.get(stateRef).pipe(Effect.map(schedulerStats), Effect.tx);

    return {
      enqueue,
      drain,
      stats,
    } satisfies ProviderIngestionScheduler<A>;
  });
