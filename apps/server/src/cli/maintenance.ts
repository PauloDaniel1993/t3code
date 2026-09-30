// @effect-diagnostics nodeBuiltinImport:off - Synchronous progress must flush before SQLite blocks.
import * as NodeFS from "node:fs";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  compactDatabase,
  databaseMaintenanceStatus,
  estimateDatabaseMaintenance,
  recoverDatabaseMaintenance,
} from "../persistence/DatabasePhysicalMaintenance.ts";
import type { MaintenanceProgress } from "../persistence/DatabaseMaintenanceProgress.ts";

const databaseFlags = {
  database: Flag.String("database").pipe(
    Flag.withDescription(
      "Explicit path to the existing statev2.sqlite file. Stop its T3 server first.",
    ),
  ),
};

const report = (operation: () => unknown) =>
  Effect.try(operation).pipe(
    Effect.flatMap((result) => Console.log(JSON.stringify(result ?? { phase: "none" }, null, 2))),
  );

function printProgress(progress: MaintenanceProgress): void {
  const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(1)}s`;
  const timing =
    progress.state === "started"
      ? progress.estimatedMs === undefined
        ? "duration unknown"
        : `rough estimate ${seconds(progress.estimatedMs)} from source validation`
      : `elapsed ${seconds(progress.elapsedMs)}`;
  const remaining = progress.remainingPhases.length ? progress.remainingPhases.join(", ") : "none";
  NodeFS.writeSync(
    2,
    `${progress.phase}: ${progress.state} (${timing}). Remaining phases: ${remaining}.\n`,
  );
}

export const maintenanceCommand = Command.make("maintenance").pipe(
  Command.withDescription(
    "Inspect or physically compact an existing V2 database without migrating or deleting history.",
  ),
  Command.withSubcommands([
    Command.make("estimate", databaseFlags).pipe(
      Command.withDescription("Report free pages and the conservative temporary disk requirement."),
      Command.withHandler(({ database }) => report(() => estimateDatabaseMaintenance(database))),
    ),
    Command.make("status", databaseFlags).pipe(
      Command.withDescription(
        "Check database identity read-only and report its external maintenance journal.",
      ),
      Command.withHandler(({ database }) => report(() => databaseMaintenanceStatus(database))),
    ),
    Command.make("compact", databaseFlags).pipe(
      Command.withDescription(
        "Retain a fully validated compact snapshot, then reclaim space under an exclusive SQLite lock.",
      ),
      Command.withHandler(({ database }) =>
        report(() => compactDatabase({ databasePath: database }, { onProgress: printProgress })),
      ),
    ),
    Command.make("recover", {
      ...databaseFlags,
      acknowledgeValidationFailure: Flag.Boolean("acknowledge-validation-failure").pipe(
        Flag.withDefault(false),
        Flag.withDescription(
          "After manual inspection, accept current data despite a failed or interrupted final validation. Never restores the saved snapshot.",
        ),
      ),
    }).pipe(
      Command.withDescription(
        "Check interrupted maintenance, keeping current data and all snapshots. Never restore over newer work.",
      ),
      Command.withHandler(({ database, acknowledgeValidationFailure }) =>
        report(() =>
          recoverDatabaseMaintenance(
            { databasePath: database, acknowledgeValidationFailure },
            { onProgress: printProgress },
          ),
        ),
      ),
    ),
  ]),
);
