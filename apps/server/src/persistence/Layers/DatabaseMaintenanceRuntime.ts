import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import {
  clearDatabasePreOpenMaintenanceFailure,
  databaseReplacementPendingReadiness,
  DatabasePhysicalMaintenanceError,
  markDatabaseReplacementReady,
  readDatabasePreOpenMaintenanceFailure,
} from "../DatabasePhysicalMaintenance.ts";
import {
  DATABASE_COMPACTION_JOURNAL_ID,
  DatabaseCompactionJournalRepository,
} from "../Services/DatabaseCompactionJournal.ts";
import {
  DatabaseMaintenanceRuntime,
  type DatabaseMaintenanceRuntimeShape,
} from "../Services/DatabaseMaintenanceRuntime.ts";

const failureMessage = (code: string): string => {
  switch (code) {
    case "active-writer":
      return "Database maintenance was deferred because a writer still owned the database.";
    case "insufficient-disk":
      return "Database maintenance was deferred because temporary disk space was insufficient.";
    case "checkpoint-failed":
      return "Database maintenance could not checkpoint the SQLite WAL.";
    case "candidate-corrupt":
    case "invariant-mismatch":
      return "The compact database candidate failed validation; the original database was retained.";
    case "swap-failed":
    case "rollback-failed":
      return "The compact database could not be installed safely; the original database was retained.";
    default:
      return "Database maintenance did not complete; the original database was retained.";
  }
};

const physicalOperation = <A>(operation: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof DatabasePhysicalMaintenanceError
        ? cause
        : new DatabasePhysicalMaintenanceError({
            code: "startup-validation-failed",
            message: `Database maintenance startup operation failed: ${operation}.`,
          }),
  });

const makeDatabaseMaintenanceRuntime = Effect.gen(function* () {
  const { dbPath } = yield* ServerConfig;
  const journalRepository = yield* DatabaseCompactionJournalRepository;

  const finalizeStartup: DatabaseMaintenanceRuntimeShape["finalizeStartup"] = Effect.gen(
    function* () {
      const existing = yield* journalRepository.get({
        journalId: DATABASE_COMPACTION_JOURNAL_ID,
      });
      const journal = Option.getOrUndefined(existing);
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      const failure = yield* physicalOperation("read pre-open result", () =>
        readDatabasePreOpenMaintenanceFailure(dbPath),
      );
      if (failure !== undefined) {
        if (journal !== undefined) {
          yield* journalRepository.upsert({
            ...journal,
            phase: "failed",
            terminalOutcome: {
              code: failure.code,
              phase: "failed",
              message: failureMessage(failure.code),
              ...(failure.requiredBytes === undefined
                ? {}
                : { requiredBytes: failure.requiredBytes }),
              ...(failure.availableBytes === undefined
                ? {}
                : { availableBytes: failure.availableBytes }),
              recoverable: true,
              failedAt: timestamp,
            },
            updatedAt: timestamp,
          });
        }
        yield* physicalOperation("clear pre-open result", () =>
          clearDatabasePreOpenMaintenanceFailure(dbPath),
        );
        return;
      }

      const pending = yield* physicalOperation("read replacement state", () =>
        databaseReplacementPendingReadiness(dbPath),
      );
      if (pending === undefined) {
        return;
      }
      if (journal === undefined) {
        return yield* Effect.fail(
          new DatabasePhysicalMaintenanceError({
            code: "startup-validation-failed",
            message: "The installed compact database is missing its maintenance journal.",
          }),
        );
      }

      yield* journalRepository.upsert({
        ...journal,
        phase: "completed",
        physicalBytesBefore: pending.beforeBytes,
        physicalBytesAfter: pending.afterBytes,
        terminalOutcome: {
          beforeBytes: pending.beforeBytes,
          afterBytes: pending.afterBytes,
          reclaimedBytes: Math.max(0, pending.beforeBytes - pending.afterBytes),
          completedAt: timestamp,
          rollbackRetained: pending.rollbackRetained,
        },
        updatedAt: timestamp,
      });
      yield* physicalOperation("commit startup readiness", () =>
        markDatabaseReplacementReady(dbPath),
      );
    },
  );

  return { finalizeStartup } satisfies DatabaseMaintenanceRuntimeShape;
});

export const DatabaseMaintenanceRuntimeLive = Layer.effect(
  DatabaseMaintenanceRuntime,
  makeDatabaseMaintenanceRuntime,
);
