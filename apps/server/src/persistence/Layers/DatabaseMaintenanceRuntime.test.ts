import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import {
  databasePhysicalMaintenancePaths,
  runPreOpenDatabaseMaintenance,
  scheduleDatabasePhysicalMaintenance,
} from "../DatabasePhysicalMaintenance.ts";
import {
  DATABASE_COMPACTION_JOURNAL_ID,
  DatabaseCompactionJournalRepository,
} from "../Services/DatabaseCompactionJournal.ts";
import { DatabaseMaintenanceRuntime } from "../Services/DatabaseMaintenanceRuntime.ts";
import { DatabaseCompactionJournalRepositoryLive } from "./DatabaseCompactionJournal.ts";
import { DatabaseMaintenanceRuntimeLive } from "./DatabaseMaintenanceRuntime.ts";
import { makeSqlitePersistenceLive } from "./Sqlite.ts";

const initialJournal = {
  journalId: DATABASE_COMPACTION_JOURNAL_ID,
  safetyWatermark: 0,
  phase: "awaiting-restart" as const,
  eventBatchCursor: 0,
  projectionBatchCursor: 0,
  eligibleEventCount: 0,
  processedEventCount: 0,
  skippedEventCount: 0,
  eligibleProjectionCount: 0,
  processedProjectionCount: 0,
  skippedProjectionCount: 0,
  logicalBytesReclaimed: 0,
  physicalBytesBefore: 0,
  physicalBytesAfter: null,
  terminalOutcome: null,
  startedAt: "2026-07-23T10:00:00.000Z",
  updatedAt: "2026-07-23T10:00:00.000Z",
};

it.effect("finalizes a validated pre-open replacement after startup readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-maintenance-runtime-",
      });
      const dbPath = `${directory}/state.sqlite`;
      const config = { dbPath } as ServerConfig.ServerConfig["Service"];

      const initializePersistence = makeSqlitePersistenceLive(dbPath);
      const initializeLayer = Layer.mergeAll(
        initializePersistence,
        DatabaseCompactionJournalRepositoryLive.pipe(Layer.provideMerge(initializePersistence)),
      );
      yield* Effect.gen(function* () {
        const repository = yield* DatabaseCompactionJournalRepository;
        yield* repository.upsert(initialJournal);
      }).pipe(Effect.provide(initializeLayer));

      yield* Effect.sync(() => scheduleDatabasePhysicalMaintenance(dbPath));
      const preOpen = yield* Effect.sync(() => runPreOpenDatabaseMaintenance(dbPath));
      assert.strictEqual(preOpen._tag, "installed");
      const paths = databasePhysicalMaintenancePaths(dbPath);
      assert.isTrue(yield* fileSystem.exists(paths.rollbackPath));
      assert.isTrue(yield* fileSystem.exists(paths.statePath));

      const restartedPersistence = makeSqlitePersistenceLive(dbPath);
      const restartedRepository = DatabaseCompactionJournalRepositoryLive.pipe(
        Layer.provideMerge(restartedPersistence),
      );
      const runtimeLayer = Layer.mergeAll(
        restartedPersistence,
        restartedRepository,
        DatabaseMaintenanceRuntimeLive.pipe(
          Layer.provideMerge(restartedRepository),
          Layer.provide(ServerConfig.layer(config)),
        ),
      );
      const completed = yield* Effect.gen(function* () {
        const runtime = yield* DatabaseMaintenanceRuntime;
        const repository = yield* DatabaseCompactionJournalRepository;
        yield* runtime.finalizeStartup;
        return Option.getOrThrow(
          yield* repository.get({ journalId: DATABASE_COMPACTION_JOURNAL_ID }),
        );
      }).pipe(Effect.provide(runtimeLayer));

      assert.strictEqual(completed.phase, "completed");
      assert.isNotNull(completed.physicalBytesAfter);
      assert.strictEqual(completed.terminalOutcome !== null, true);
      assert.isFalse(yield* fileSystem.exists(paths.rollbackPath));
      assert.isFalse(yield* fileSystem.exists(paths.statePath));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
