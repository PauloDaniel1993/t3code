import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

export interface SnapshotSubscription<A, Snapshot = A, E = never, R = never> {
  readonly latest: Snapshot;
  readonly changes: Stream.Stream<A, E, R>;
}

export const subscribeBeforeSnapshot = Effect.fn("subscribeBeforeSnapshot")(function* <A, E, R>(
  changes: PubSub.PubSub<A>,
  snapshot: Effect.Effect<A, E, R>,
  mutex: Semaphore.Semaphore,
) {
  return yield* mutex.withPermits(1)(
    Effect.gen(function* () {
      const latest = yield* snapshot;
      const subscription = yield* PubSub.subscribe(changes);
      return {
        latest,
        changes: Stream.fromSubscription(subscription),
      } satisfies SnapshotSubscription<A>;
    }),
  );
});

export const subscribeBeforeSnapshotWithoutMutex = Effect.fn("subscribeBeforeSnapshotWithoutMutex")(
  function* <A, E, R>(changes: PubSub.PubSub<A>, snapshot: Effect.Effect<A, E, R>) {
    const subscription = yield* PubSub.subscribe(changes);
    const latest = yield* snapshot;
    return {
      latest,
      changes: Stream.fromSubscription(subscription),
    } satisfies SnapshotSubscription<A>;
  },
);

export const subscribeStreamBeforeSnapshot = Effect.fn("subscribeStreamBeforeSnapshot")(function* <
  A,
  E,
  R,
  Snapshot,
  SnapshotE,
  SnapshotR,
>(changes: Stream.Stream<A, E, R>, snapshot: Effect.Effect<Snapshot, SnapshotE, SnapshotR>) {
  const bufferedChanges = yield* Queue.unbounded<A, E | Cause.Done>();
  yield* Effect.forkScoped(changes.pipe(Stream.runIntoQueue(bufferedChanges)), {
    startImmediately: true,
  });
  const latest = yield* snapshot;
  return {
    latest,
    changes: Stream.fromQueue(bufferedChanges),
  } satisfies SnapshotSubscription<A, Snapshot, Exclude<E, Cause.Done>, never>;
});
