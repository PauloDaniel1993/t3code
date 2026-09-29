import type { KimiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const KIMI_CODE_HOME_ENV = "KIMI_CODE_HOME";
export const KIMI_CODE_NO_AUTO_UPDATE_ENV = "KIMI_CODE_NO_AUTO_UPDATE";

export const resolveKimiHomePath = Effect.fn("resolveKimiHomePath")(function* (
  config: Pick<KimiSettings, "homePath">,
): Effect.fn.Return<string | undefined, never, Path.Path> {
  const homePath = config.homePath.trim();
  if (homePath.length === 0) {
    return undefined;
  }
  const path = yield* Path.Path;
  return path.resolve(expandHomePath(homePath));
});

/** Build the environment shared by every T3-managed Kimi child process. */
export const makeKimiEnvironment = Effect.fn("makeKimiEnvironment")(function* (
  config: Pick<KimiSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = yield* resolveKimiHomePath(config);
  return {
    ...resolvedBaseEnv,
    ...(homePath ? { [KIMI_CODE_HOME_ENV]: homePath } : {}),
    // Keep the executable stable for the full lifetime of T3-managed probes
    // and ACP sessions. Updates are coordinated through provider maintenance.
    [KIMI_CODE_NO_AUTO_UPDATE_ENV]: "1",
  };
});
