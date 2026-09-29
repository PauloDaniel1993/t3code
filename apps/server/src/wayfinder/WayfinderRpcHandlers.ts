import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { WayfinderMapsInput, WayfinderMapsSnapshot } from "@t3tools/contracts";

import * as WayfinderMaps from "./WayfinderMaps.ts";
import { toWayfinderMapsRpcError } from "./WayfinderRpcError.ts";

type WayfinderMapsService = WayfinderMaps.WayfinderMaps["Service"];

/**
 * Bodies of the two Wayfinder RPC handlers. `ws.ts` wraps them in its own authorization and
 * tracing; everything else about the methods lives here, so the shared file only registers them.
 */
export const subscribeWayfinderMaps = (
  wayfinderMaps: WayfinderMapsService,
  input: WayfinderMapsInput,
): Stream.Stream<WayfinderMapsSnapshot, ReturnType<typeof toWayfinderMapsRpcError>> =>
  wayfinderMaps
    .stream(input.cwd, {
      automaticBootstrapProbeInterval: Effect.succeed(
        WayfinderMaps.WAYFINDER_MAPS_DEFAULT_BOOTSTRAP_PROBE_INTERVAL,
      ),
    })
    .pipe(Stream.mapError((cause) => toWayfinderMapsRpcError(input.cwd, cause)));

export const refreshWayfinderMaps = (
  wayfinderMaps: WayfinderMapsService,
  input: WayfinderMapsInput,
) =>
  wayfinderMaps.refresh(input.cwd).pipe(
    Effect.mapError((cause) => toWayfinderMapsRpcError(input.cwd, cause)),
    Effect.as({}),
  );
