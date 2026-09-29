import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createWayfinderEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    maps: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:wayfinder:maps",
      tag: WS_METHODS.subscribeWayfinderMaps,
    }),
    refreshMaps: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:wayfinder:refresh-maps",
      tag: WS_METHODS.wayfinderRefreshMaps,
    }),
  };
}
