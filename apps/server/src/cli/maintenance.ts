import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  compactDatabase,
  databaseMaintenanceStatus,
  estimateDatabaseMaintenance,
  recoverDatabaseMaintenance,
} from "../persistence/DatabasePhysicalMaintenance.ts";

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
        report(() => compactDatabase({ databasePath: database })),
      ),
    ),
    Command.make("recover", databaseFlags).pipe(
      Command.withDescription(
        "Check interrupted maintenance, keeping current data and all snapshots. Never restore over newer work.",
      ),
      Command.withHandler(({ database }) =>
        report(() => recoverDatabaseMaintenance({ databasePath: database })),
      ),
    ),
  ]),
);
