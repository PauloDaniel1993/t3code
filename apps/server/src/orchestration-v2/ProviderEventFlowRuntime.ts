import type {
  ProviderAdapterV2Error,
  ProviderAdapterV2Event,
  ProviderAdapterV2EventSubscription,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderAdapterEventStreamError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  makeProviderEventFlowStage,
  type ProviderEventFlowStage,
} from "./ProviderEventFlowStage.ts";
import { sanitizeProviderEvent } from "./ProviderEventPayload.ts";
import {
  routeProviderEvent,
  type ProviderEventRouteIdentity,
  type ProviderEventRoutingState,
} from "./RunExecutionService.ts";

const subscriptions = new WeakMap<ProviderAdapterV2EventSubscription, ProviderEventFlowStage>();
const closures = new WeakMap<ProviderAdapterV2SessionRuntime, Effect.Effect<void>>();
const publications = new WeakMap<
  ProviderAdapterV2SessionRuntime,
  (event: ProviderAdapterV2Event) => Effect.Effect<void>
>();
const endings = new WeakMap<
  ProviderAdapterV2SessionRuntime,
  (afterDrain: Effect.Effect<void>) => Effect.Effect<void>
>();
const failures = new WeakMap<
  ProviderAdapterV2SessionRuntime,
  (
    detail: string,
    afterDrain: Effect.Effect<void>,
    cause?: Cause.Cause<ProviderAdapterV2Error>,
  ) => Effect.Effect<void>
>();

/** One attachment at session creation; raw events never enter an upstream subscriber queue. */
export const attachProviderEventFlow = Effect.fnUntraced(function* (
  runtime: ProviderAdapterV2SessionRuntime,
  decorate: (runtime: ProviderAdapterV2SessionRuntime) => ProviderAdapterV2SessionRuntime,
  scope: Scope.Closeable,
) {
  const stages = new Set<ProviderEventFlowStage>();
  const pressure = { items: 0, bytes: 0, warned: false };
  let ended = false;
  let failure: Cause.Cause<ProviderAdapterV2Error> | undefined;
  let releaseCleanup: Effect.Effect<void> | undefined;
  const seal = Effect.fn("ProviderEventFlowRuntime.seal")(function* (
    cause?: Cause.Cause<ProviderAdapterV2Error>,
  ) {
    ended = true;
    failure = cause;
    // Keep the sealed stages alive until each consumer drains and unregisters.
    yield* Effect.forEach(
      stages,
      (stage) => (cause === undefined ? stage.end : stage.fail(cause)),
      { discard: true },
    );
  });
  const close = Effect.gen(function* () {
    ended = true;
    yield* Effect.forEach(stages, (stage) => stage.interrupt, { discard: true });
    stages.clear();
  });
  const subscribeEvents = Effect.gen(function* () {
    const stage = yield* makeProviderEventFlowStage({ ...runtime, pressure });
    stages.add(stage);
    if (ended) yield* failure === undefined ? stage.end : stage.fail(failure);
    let closed = false;
    const unregister = Effect.suspend(() => {
      if (closed) return Effect.void;
      closed = true;
      stages.delete(stage);
      return stage.close.pipe(
        Effect.andThen(
          releaseCleanup === undefined ? Effect.void : Effect.forkDetach(releaseCleanup),
        ),
      );
    });
    const subscription = {
      events: stage.events.pipe(Stream.ensuring(unregister)),
      close: unregister,
    };
    subscriptions.set(subscription, stage);
    return subscription;
  });
  const stagedRuntime = {
    ...runtime,
    get providerSession() {
      return runtime.providerSession;
    },
    events: runtime.events.pipe(Stream.map(sanitizeProviderEvent)),
  };
  const decoratedRuntime = decorate(stagedRuntime);
  const exposedRuntime = {
    ...decoratedRuntime,
    get providerSession() {
      return decoratedRuntime.providerSession;
    },
    subscribeEvents,
    events: Stream.unwrap(subscribeEvents.pipe(Effect.map((subscription) => subscription.events))),
  };
  closures.set(exposedRuntime, close);
  publications.set(exposedRuntime, (event) =>
    Effect.suspend(() => {
      let warning = Effect.void;
      for (const stage of stages) warning = stage.offerUnsafe(event) ?? warning;
      return warning;
    }),
  );
  endings.set(exposedRuntime, (afterDrain) =>
    Effect.suspend(() => {
      releaseCleanup = afterDrain;
      return seal();
    }),
  );
  failures.set(exposedRuntime, (detail, afterDrain, cause) =>
    Effect.suspend(() => {
      releaseCleanup = afterDrain;
      return ended
        ? Effect.void
        : seal(
            cause ??
              Cause.fail(
                new ProviderAdapterEventStreamError({
                  driver: runtime.driver,
                  providerSessionId: runtime.providerSessionId,
                  cause: detail,
                }),
              ),
          );
    }),
  );
  // Non-graceful release is a fence too. Shutdown explicitly closes below.
  yield* Scope.addFinalizer(
    scope,
    Effect.suspend(() =>
      ended
        ? Effect.void
        : seal(
            Cause.fail(
              new ProviderAdapterEventStreamError({
                driver: runtime.driver,
                providerSessionId: runtime.providerSessionId,
                cause: "Provider session released.",
              }),
            ),
          ),
    ),
  );
  return { runtime: stagedRuntime, exposedRuntime };
});

/** Match upstream's explicit shutdown discard; other release paths drain. */
export function closeProviderEventFlow(
  runtime: ProviderAdapterV2SessionRuntime,
): Effect.Effect<void> {
  return closures.get(runtime) ?? Effect.void;
}

/** Seal retained events with upstream's specific session-release reason. */
export function failProviderEventFlow(
  runtime: ProviderAdapterV2SessionRuntime,
  detail: string,
  afterDrain: Effect.Effect<void>,
  cause?: Cause.Cause<ProviderAdapterV2Error>,
): Effect.Effect<void> {
  return failures.get(runtime)?.(detail, afterDrain, cause) ?? Effect.void;
}

/** Publish only after the session manager has normalized retry terminals. */
export function publishProviderEventFlow(
  runtime: ProviderAdapterV2SessionRuntime,
  event: ProviderAdapterV2Event,
): Effect.Effect<void> {
  return publications.get(runtime)?.(event) ?? Effect.void;
}

export function endProviderEventFlow(
  runtime: ProviderAdapterV2SessionRuntime,
  afterDrain: Effect.Effect<void>,
): Effect.Effect<void> {
  return endings.get(runtime)?.(afterDrain) ?? Effect.void;
}

/** Admission and consumption use independent copies of the authoritative V2 router. */
export const configureProviderEventFlow = Effect.fnUntraced(function* (
  subscription: ProviderAdapterV2EventSubscription,
  identity: ProviderEventRouteIdentity,
  routing: Ref.Ref<ProviderEventRoutingState>,
) {
  const stage = subscriptions.get(subscription);
  if (stage === undefined) return;
  let state = yield* Ref.get(routing);
  yield* stage.filter((event) => {
    const [accepted, next] = routeProviderEvent(event, identity, state);
    state = next;
    return accepted;
  });
});
