import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, GlobalFlag } from "effect/unstable/cli";

import * as ServerConfig from "../config.ts";
import { scheduleDatabasePhysicalMaintenance } from "../persistence/DatabasePhysicalMaintenance.ts";
import { DatabaseCompactionJournalRepositoryLive } from "../persistence/Layers/DatabaseCompactionJournal.ts";
import { DatabaseCompactionEstimatorLive } from "../persistence/Layers/DatabaseCompactionEstimator.ts";
import { DatabaseLogicalCompactionLive } from "../persistence/Layers/DatabaseLogicalCompaction.ts";
import { DatabaseLogicalCompactorLive } from "../persistence/Layers/DatabaseLogicalCompactor.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import {
  DATABASE_COMPACTION_JOURNAL_ID,
  DatabaseCompactionJournalRepository,
  databaseMaintenanceProgressFromJournal,
} from "../persistence/Services/DatabaseCompactionJournal.ts";
import { DatabaseCompactionEstimator } from "../persistence/Services/DatabaseCompactionEstimator.ts";
import { DatabaseLogicalCompaction } from "../persistence/Services/DatabaseLogicalCompaction.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";

export class DatabaseMaintenanceActiveWorkError extends Schema.TaggedErrorClass<DatabaseMaintenanceActiveWorkError>()(
  "DatabaseMaintenanceActiveWorkError",
  {
    blockers: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Database maintenance cannot start while work is active (${this.blockers.join(", ")}).`;
  }
}

export class DatabaseMaintenanceScheduleError extends Schema.TaggedErrorClass<DatabaseMaintenanceScheduleError>()(
  "DatabaseMaintenanceScheduleError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not schedule database maintenance.";
  }
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
};

const makeMaintenanceLayer = (config: ServerConfig.ServerConfig["Service"]) => {
  const persistence = makeSqlitePersistenceLive(config.dbPath);
  const dependencies = Layer.mergeAll(
    DatabaseCompactionJournalRepositoryLive,
    DatabaseCompactionEstimatorLive,
    DatabaseLogicalCompactorLive,
  ).pipe(Layer.provideMerge(persistence));
  return Layer.mergeAll(
    dependencies,
    DatabaseLogicalCompactionLive.pipe(Layer.provideMerge(dependencies)),
  );
};

const withMaintenanceRuntime = <A, E, R>(
  flags: Parameters<typeof resolveCliAuthConfig>[0],
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    return yield* effect.pipe(
      Effect.provide(Layer.mergeAll(makeMaintenanceLayer(config), ServerConfig.layer(config))),
    );
  });

const printEstimate = Effect.fn("databaseMaintenance.printEstimate")(function* () {
  const estimator = yield* DatabaseCompactionEstimator;
  const estimate = yield* estimator.estimate();
  yield* Console.log(`Database size: ${formatBytes(estimate.databaseBytes)}`);
  yield* Console.log(`Estimated reclaimable: ${formatBytes(estimate.estimatedReclaimableBytes)}`);
  yield* Console.log(
    `Eligible history: ${estimate.eligibleEventCount} events, ${estimate.eligibleProjectionCount} projection rows`,
  );
  yield* Console.log(`Safety watermark: ${estimate.safetyWatermark}`);
  if (estimate.activeWorkBlockers.length > 0) {
    yield* Console.log(`Blocked by: ${estimate.activeWorkBlockers.join(", ")}`);
  }
  return estimate;
});

const ensureServerStopped = Effect.fn("databaseMaintenance.ensureServerStopped")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return;
  }
  const isRunning = yield* Effect.sync(() => {
    try {
      process.kill(runtimeState.value.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  if (isRunning) {
    return yield* new DatabaseMaintenanceActiveWorkError({
      blockers: ["server-process-active"],
    });
  }
});

const maintenanceEstimateCommand = Command.make("estimate", {
  ...authLocationFlags,
}).pipe(
  Command.withDescription("Estimate safe logical and physical database compaction savings."),
  Command.withHandler((flags) => withMaintenanceRuntime(flags, printEstimate())),
);

const maintenanceCompactCommand = Command.make("compact", {
  ...authLocationFlags,
}).pipe(
  Command.withDescription(
    "With the T3 server stopped, compact replaceable history and schedule validated physical reclamation for the next restart.",
  ),
  Command.withHandler((flags) =>
    withMaintenanceRuntime(
      flags,
      Effect.gen(function* () {
        yield* ensureServerStopped();
        const estimate = yield* printEstimate();
        if (estimate.activeWorkBlockers.length > 0) {
          return yield* new DatabaseMaintenanceActiveWorkError({
            blockers: estimate.activeWorkBlockers,
          });
        }

        const logicalCompaction = yield* DatabaseLogicalCompaction;
        let journal = yield* logicalCompaction.runNextBatch();
        while (journal.phase === "logical-compaction") {
          yield* Console.log(
            `Logical compaction: ${journal.processedEventCount + journal.processedProjectionCount} rows processed, ${formatBytes(journal.logicalBytesReclaimed)} reclaimed`,
          );
          journal = yield* logicalCompaction.runNextBatch();
        }
        yield* Console.log(
          `Logical compaction complete: ${formatBytes(journal.logicalBytesReclaimed)} reclaimed`,
        );

        const config = yield* ServerConfig.ServerConfig;
        yield* Effect.try({
          try: () => scheduleDatabasePhysicalMaintenance(config.dbPath),
          catch: (cause) => new DatabaseMaintenanceScheduleError({ cause }),
        });
        yield* Console.log(
          "Physical reclamation is scheduled. Restart T3 Code to install the validated compact database.",
        );
      }),
    ),
  ),
);

const maintenanceStatusCommand = Command.make("status", {
  ...authLocationFlags,
}).pipe(
  Command.withDescription("Show database maintenance progress or the last terminal result."),
  Command.withHandler((flags) =>
    withMaintenanceRuntime(
      flags,
      Effect.gen(function* () {
        const repository = yield* DatabaseCompactionJournalRepository;
        const journal = yield* repository.get({
          journalId: DATABASE_COMPACTION_JOURNAL_ID,
        });
        if (Option.isNone(journal)) {
          yield* Console.log("No database maintenance has been requested.");
          return;
        }
        const progress = databaseMaintenanceProgressFromJournal(journal.value);
        yield* Console.log(`Phase: ${progress.phase}`);
        yield* Console.log(`Processed rows: ${progress.processedRows}/${progress.totalRows}`);
        yield* Console.log(
          `Logical bytes reclaimed: ${formatBytes(progress.logicalBytesReclaimed)}`,
        );
        if (
          progress.physicalBytesBefore !== undefined &&
          progress.physicalBytesAfter !== undefined
        ) {
          yield* Console.log(
            `Physical size: ${formatBytes(progress.physicalBytesBefore)} → ${formatBytes(progress.physicalBytesAfter)}`,
          );
        }
      }),
    ),
  ),
);

export const maintenanceCommand = Command.make("maintenance").pipe(
  Command.withDescription("Inspect and compact the T3 Code state database."),
  Command.withSubcommands([
    maintenanceEstimateCommand,
    maintenanceCompactCommand,
    maintenanceStatusCommand,
  ]),
);
