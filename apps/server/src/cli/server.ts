import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, GlobalFlag } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import * as ServerConfig from "../config.ts";
import { runServer } from "../server.ts";
import * as WorkspaceFiles from "../project/WorkspaceFiles.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

class WorkspaceFileCommandRequiredError extends CliError.UserError {
  override get message() {
    return "Use `t3 app FILE` to open or `t3 project add FILE` to register";
  }
}

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    if (Option.isSome(flags.cwd)) {
      const cwd = flags.cwd.value;
      const projectPath = yield* WorkspaceFiles.WorkspaceFiles.pipe(
        Effect.flatMap((workspaceFiles) => workspaceFiles.resolveProjectPath(cwd)),
        Effect.provide(WorkspaceFiles.layer),
      );
      if (projectPath.kind === "workspace-file") {
        return yield* new WorkspaceFileCommandRequiredError({ cause: projectPath.path });
      }
    }
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    return yield* runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the T3 Code server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
