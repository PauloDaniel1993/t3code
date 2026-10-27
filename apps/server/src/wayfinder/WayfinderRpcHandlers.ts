import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { WayfinderMapsInput } from "@t3tools/contracts";

import * as WayfinderMaps from "./WayfinderMaps.ts";
import { toWayfinderMapsRpcError } from "./WayfinderRpcError.ts";

// Build once per connection; ws.ts supplies authorization and tracing.
// The per-connection subscription cap fails immediately, and closing a subscription frees its slot.
export const makeWayfinderRpcHandlers = Effect.gen(function* () {
  const wayfinderMaps = yield* WayfinderMaps.WayfinderMaps;
  const subscriptions = yield* Ref.make(0);

  const takeSlot = Effect.acquireRelease(
    Ref.modify(subscriptions, (count) =>
      count >= WayfinderMaps.WAYFINDER_MAPS_MAX_SUBSCRIPTIONS_PER_CONNECTION
        ? [false, count]
        : [true, count + 1],
    ),
    (taken) => (taken ? Ref.update(subscriptions, (count) => count - 1) : Effect.void),
  ).pipe(
    Effect.flatMap((taken) =>
      taken
        ? Effect.void
        : Effect.fail(
            new WayfinderMaps.WayfinderMapsCapacityError({
              message: `This connection already has ${WayfinderMaps.WAYFINDER_MAPS_MAX_SUBSCRIPTIONS_PER_CONNECTION} maps open. Close some map panels and try again.`,
            }),
          ),
    ),
  );

  const subscribe = (input: WayfinderMapsInput) =>
    Stream.unwrap(takeSlot.pipe(Effect.as(wayfinderMaps.stream(input.cwd)))).pipe(
      Stream.mapError((cause) => toWayfinderMapsRpcError(input.cwd, cause)),
    );

  const refresh = (input: WayfinderMapsInput) =>
    wayfinderMaps.refresh(input.cwd).pipe(
      Effect.mapError((cause) => toWayfinderMapsRpcError(input.cwd, cause)),
      Effect.as({}),
    );

  return { subscribe, refresh };
});
