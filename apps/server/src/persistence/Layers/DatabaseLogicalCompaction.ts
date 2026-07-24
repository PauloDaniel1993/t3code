import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  DATABASE_COMPACTION_JOURNAL_ID,
  type DatabaseCompactionJournal,
  DatabaseCompactionJournalRepository,
} from "../Services/DatabaseCompactionJournal.ts";
import { toPersistenceSqlError } from "../Errors.ts";
import { DatabaseCompactionEstimator } from "../Services/DatabaseCompactionEstimator.ts";
import {
  DatabaseLogicalCompaction,
  type DatabaseLogicalCompactionShape,
} from "../Services/DatabaseLogicalCompaction.ts";
import { DatabaseLogicalCompactor } from "../Services/DatabaseLogicalCompactor.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const makeDatabaseLogicalCompaction = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const journalRepository = yield* DatabaseCompactionJournalRepository;
  const estimator = yield* DatabaseCompactionEstimator;
  const compactor = yield* DatabaseLogicalCompactor;

  const loadOrInitialize = Effect.fn("DatabaseLogicalCompaction.loadOrInitialize")(function* () {
    const existing = yield* journalRepository.get({
      journalId: DATABASE_COMPACTION_JOURNAL_ID,
    });
    if (
      Option.isSome(existing) &&
      existing.value.phase !== "completed" &&
      existing.value.phase !== "failed"
    ) {
      return existing.value;
    }

    const estimate = yield* estimator.estimate();
    const timestamp = yield* nowIso;
    const journal = {
      journalId: DATABASE_COMPACTION_JOURNAL_ID,
      safetyWatermark: estimate.safetyWatermark,
      phase: "logical-compaction",
      eventBatchCursor: 0,
      projectionBatchCursor: 0,
      eligibleEventCount: estimate.eligibleEventCount,
      processedEventCount: 0,
      skippedEventCount: 0,
      eligibleProjectionCount: estimate.eligibleProjectionCount,
      processedProjectionCount: 0,
      skippedProjectionCount: 0,
      logicalBytesReclaimed: 0,
      physicalBytesBefore: estimate.databaseBytes,
      physicalBytesAfter: null,
      terminalOutcome: null,
      startedAt: timestamp,
      updatedAt: timestamp,
    } satisfies DatabaseCompactionJournal;
    yield* journalRepository.upsert(journal);
    return journal;
  });

  const runNextBatch: DatabaseLogicalCompactionShape["runNextBatch"] = (options = {}) =>
    Effect.gen(function* () {
      const journal = yield* loadOrInitialize();
      if (journal.phase !== "logical-compaction") {
        return journal;
      }

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const timestamp = yield* nowIso;
            if (journal.eventBatchCursor < journal.safetyWatermark) {
              const result = yield* compactor.compactEventBatch({
                safetyWatermark: journal.safetyWatermark,
                cursor: journal.eventBatchCursor,
                ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
              });
              const updated = {
                ...journal,
                eventBatchCursor: result.done ? journal.safetyWatermark : result.cursor,
                processedEventCount: journal.processedEventCount + result.scannedRows,
                skippedEventCount: journal.skippedEventCount + result.skippedRows,
                logicalBytesReclaimed: journal.logicalBytesReclaimed + result.reclaimedBytes,
                updatedAt: timestamp,
              } satisfies DatabaseCompactionJournal;
              yield* journalRepository.upsert(updated);
              return updated;
            }

            const result = yield* compactor.compactProjectionBatch({
              safetyWatermark: journal.safetyWatermark,
              cursor: journal.projectionBatchCursor,
              ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
            });
            const updated = {
              ...journal,
              phase: result.done ? "awaiting-restart" : "logical-compaction",
              projectionBatchCursor: result.cursor,
              processedProjectionCount: journal.processedProjectionCount + result.scannedRows,
              skippedProjectionCount: journal.skippedProjectionCount + result.skippedRows,
              logicalBytesReclaimed: journal.logicalBytesReclaimed + result.reclaimedBytes,
              updatedAt: timestamp,
            } satisfies DatabaseCompactionJournal;
            yield* journalRepository.upsert(updated);
            return updated;
          }),
        )
        .pipe(
          Effect.mapError(
            toPersistenceSqlError("DatabaseLogicalCompaction.runNextBatch:transaction"),
          ),
        );
    });

  const run: DatabaseLogicalCompactionShape["run"] = () =>
    Effect.gen(function* () {
      let journal = yield* runNextBatch();
      while (journal.phase === "logical-compaction") {
        journal = yield* runNextBatch();
      }
      return journal;
    });

  return { runNextBatch, run } satisfies DatabaseLogicalCompactionShape;
});

export const DatabaseLogicalCompactionLive = Layer.effect(
  DatabaseLogicalCompaction,
  makeDatabaseLogicalCompaction,
);
