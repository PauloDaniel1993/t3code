import {
  DatabaseMaintenanceCompletion,
  DatabaseMaintenanceFailure,
  DatabaseMaintenancePhase,
  DatabaseMaintenanceProgress,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const DATABASE_COMPACTION_JOURNAL_ID = "database-state-compaction-v1";

export const DatabaseCompactionTerminalOutcome = Schema.Union([
  DatabaseMaintenanceCompletion,
  DatabaseMaintenanceFailure,
]);
export type DatabaseCompactionTerminalOutcome = typeof DatabaseCompactionTerminalOutcome.Type;

export const DatabaseCompactionJournal = Schema.Struct({
  journalId: TrimmedNonEmptyString,
  safetyWatermark: NonNegativeInt,
  phase: DatabaseMaintenancePhase,
  eventBatchCursor: NonNegativeInt,
  projectionBatchCursor: NonNegativeInt,
  eligibleEventCount: NonNegativeInt,
  processedEventCount: NonNegativeInt,
  skippedEventCount: NonNegativeInt,
  eligibleProjectionCount: NonNegativeInt,
  processedProjectionCount: NonNegativeInt,
  skippedProjectionCount: NonNegativeInt,
  logicalBytesReclaimed: NonNegativeInt,
  physicalBytesBefore: Schema.NullOr(NonNegativeInt),
  physicalBytesAfter: Schema.NullOr(NonNegativeInt),
  terminalOutcome: Schema.NullOr(DatabaseCompactionTerminalOutcome),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DatabaseCompactionJournal = typeof DatabaseCompactionJournal.Type;

export const databaseMaintenanceProgressFromJournal = (
  journal: DatabaseCompactionJournal,
): DatabaseMaintenanceProgress => ({
  phase: journal.phase,
  processedRows: journal.processedEventCount + journal.processedProjectionCount,
  totalRows: journal.eligibleEventCount + journal.eligibleProjectionCount,
  logicalBytesReclaimed: journal.logicalBytesReclaimed,
  ...(journal.physicalBytesBefore === null
    ? {}
    : { physicalBytesBefore: journal.physicalBytesBefore }),
  ...(journal.physicalBytesAfter === null
    ? {}
    : { physicalBytesAfter: journal.physicalBytesAfter }),
  startedAt: journal.startedAt,
  updatedAt: journal.updatedAt,
});

export const GetDatabaseCompactionJournalInput = Schema.Struct({
  journalId: TrimmedNonEmptyString,
});
export type GetDatabaseCompactionJournalInput = typeof GetDatabaseCompactionJournalInput.Type;

export interface DatabaseCompactionJournalRepositoryShape {
  readonly upsert: (
    journal: DatabaseCompactionJournal,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly get: (
    input: GetDatabaseCompactionJournalInput,
  ) => Effect.Effect<Option.Option<DatabaseCompactionJournal>, ProjectionRepositoryError>;
}

export class DatabaseCompactionJournalRepository extends Context.Service<
  DatabaseCompactionJournalRepository,
  DatabaseCompactionJournalRepositoryShape
>()("t3/persistence/Services/DatabaseCompactionJournal/DatabaseCompactionJournalRepository") {}
