import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { WayfinderMapsError, WayfinderMapsInput, WayfinderMapsSnapshot } from "./wayfinder.ts";

/** Spread into `WS_METHODS` in `rpc.ts`. */
export const WAYFINDER_WS_METHODS = {
  wayfinderRefreshMaps: "wayfinder.refreshMaps",
  subscribeWayfinderMaps: "subscribeWayfinderMaps",
} as const;

const WsSubscribeWayfinderMapsRpc = Rpc.make(WAYFINDER_WS_METHODS.subscribeWayfinderMaps, {
  payload: WayfinderMapsInput,
  success: WayfinderMapsSnapshot,
  error: Schema.Union([WayfinderMapsError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsWayfinderRefreshMapsRpc = Rpc.make(WAYFINDER_WS_METHODS.wayfinderRefreshMaps, {
  payload: WayfinderMapsInput,
  success: Schema.Struct({}),
  error: Schema.Union([WayfinderMapsError, EnvironmentAuthorizationError]),
});

/** Spread into `WsRpcGroup` in `rpc.ts`. */
export const WayfinderRpcs = [WsSubscribeWayfinderMapsRpc, WsWayfinderRefreshMapsRpc] as const;
