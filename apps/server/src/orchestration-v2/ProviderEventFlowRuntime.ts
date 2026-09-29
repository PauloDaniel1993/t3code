import type {
  ProviderAdapterV2EventSubscription,
  ProviderAdapterV2SessionRuntime,
} from "./ProviderAdapter.ts";
import { ProviderAdapterEventStreamError } from "./ProviderAdapter.ts";
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

/** One attachment at session creation; raw events never enter an upstream subscriber queue. */
export const attachProviderEventFlow = Effect.fnUntraced(function* (
  runtime: ProviderAdapterV2SessionRuntime,
  decorate: (runtime: ProviderAdapterV2SessionRuntime) => ProviderAdapterV2SessionRuntime,
  scope: Scope.Closeable,
) {
  const stages = new Set<ProviderEventFlowStage>();
  let ended = false;
  let stoppedByProvider = false;
  let failure: Cause.Cause<ProviderAdapterEventStreamError> | undefined;
  const seal = (cause?: Cause.Cause<ProviderAdapterEventStreamError>) =>
    Effect.gen(function* () {
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
    yield* Effect.forEach(stages, (stage) => stage.close, { discard: true });
    stages.clear();
  });
  const subscribeEvents = Effect.gen(function* () {
    const stage = yield* makeProviderEventFlowStage(runtime);
    stages.add(stage);
    if (ended) yield* failure === undefined ? stage.end : stage.fail(failure);
    const unregister = stage.close.pipe(
      Effect.andThen(
        Effect.sync(() => {
          stages.delete(stage);
        }),
      ),
    );
    const subscription = {
      events: stage.events.pipe(Stream.ensuring(unregister)),
      close: unregister,
    };
    subscriptions.set(subscription, stage);
    return subscription;
  });
  const stagedRuntime = {
    ...runtime,
    events: runtime.events.pipe(
      Stream.map((event) => {
        if (event.type === "provider_session.updated" && event.providerSession.status === "stopped")
          stoppedByProvider = true;
        return sanitizeProviderEvent(event);
      }),
      Stream.tap((event) =>
        Effect.forEach(stages, (stage) => stage.offer(event), { discard: true }),
      ),
      Stream.onError((cause) =>
        seal(
          Cause.fail(
            new ProviderAdapterEventStreamError({
              driver: runtime.driver,
              providerSessionId: runtime.providerSessionId,
              cause,
            }),
          ),
        ),
      ),
      Stream.ensuring(
        Effect.suspend(() =>
          ended
            ? Effect.void
            : stoppedByProvider
              ? seal()
              : seal(
                  Cause.fail(
                    new ProviderAdapterEventStreamError({
                      driver: runtime.driver,
                      providerSessionId: runtime.providerSessionId,
                      cause: "Provider stream ended unexpectedly.",
                    }),
                  ),
                ),
        ),
      ),
    ),
  };
  const exposedRuntime = {
    ...decorate(stagedRuntime),
    subscribeEvents,
    events: Stream.unwrap(subscribeEvents.pipe(Effect.map((subscription) => subscription.events))),
  };
  closures.set(exposedRuntime, close);
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
