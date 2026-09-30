import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ClaudeExecutableFileCheck,
  isWindowsClaudeLauncherShimPath,
  resolveClaudeSdkExecutablePath,
} from "../../provider/Drivers/ClaudeExecutable.ts";

export class ClaudeSdkExecutableResolutionError extends Schema.TaggedError<ClaudeSdkExecutableResolutionError>()(
  "ClaudeSdkExecutableResolutionError",
  { binaryPath: Schema.String, attemptedPath: Schema.String },
) {
  override get message(): string {
    return `Could not resolve Claude binaryPath setting "${this.binaryPath}" to an executable the Claude Agent SDK can spawn. Tried "${this.attemptedPath}". Check the Claude binary path setting and PATH, or reinstall Claude Code.`;
  }
}

/** Resolve at process start, preserving the shared resolver's platform behavior. */
export const resolveClaudeTurnExecutablePath = Effect.fn("resolveClaudeTurnExecutablePath")(
  function* (binaryPath: string, environment: NodeJS.ProcessEnv) {
    const executablePath = yield* resolveClaudeSdkExecutablePath(binaryPath, environment);
    const platform = yield* HostProcessPlatform;
    if (platform === "win32") {
      const isFile = yield* ClaudeExecutableFileCheck;
      if (isWindowsClaudeLauncherShimPath(executablePath) || !isFile(executablePath)) {
        const resolveExecutable = yield* SpawnExecutableResolution;
        return yield* new ClaudeSdkExecutableResolutionError({
          binaryPath,
          attemptedPath: resolveExecutable(binaryPath, platform, environment) ?? executablePath,
        });
      }
    }
    return executablePath;
  },
);
