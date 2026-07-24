import * as Effect from "effect/Effect";
import { Command, GlobalFlag } from "effect/unstable/cli";

import { ServerConfig, type StartupPresentation } from "../config.ts";
import { runServer } from "../server.ts";
import { runPreOpenDatabaseMaintenance } from "../persistence/DatabasePhysicalMaintenance.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    const maintenance = yield* Effect.sync(() => runPreOpenDatabaseMaintenance(config.dbPath));
    if (maintenance._tag === "installed") {
      yield* Effect.logInfo("Installed validated compact database before startup", {
        beforeBytes: maintenance.replacement.beforeBytes,
        afterBytes: maintenance.replacement.afterBytes,
      });
    } else if (maintenance._tag === "failure") {
      yield* Effect.logWarning("Database maintenance was deferred before startup", {
        code: maintenance.code,
        requiredBytes: maintenance.requiredBytes,
        availableBytes: maintenance.availableBytes,
      });
    }
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
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
