import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DatabaseCompactionJournal,
  DatabaseCompactionJournalRepository,
  type DatabaseCompactionJournalRepositoryShape,
  DatabaseCompactionTerminalOutcome,
  GetDatabaseCompactionJournalInput,
} from "../Services/DatabaseCompactionJournal.ts";

const DatabaseCompactionJournalDbRow = DatabaseCompactionJournal.mapFields(
  Struct.assign({
    terminalOutcome: Schema.NullOr(Schema.fromJsonString(DatabaseCompactionTerminalOutcome)),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeDatabaseCompactionJournalRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertJournal = SqlSchema.void({
    Request: DatabaseCompactionJournal,
    execute: (journal) =>
      sql`
        INSERT INTO database_compaction_journal (
          journal_id,
          safety_watermark,
          phase,
          event_batch_cursor,
          projection_batch_cursor,
          eligible_event_count,
          processed_event_count,
          skipped_event_count,
          eligible_projection_count,
          processed_projection_count,
          skipped_projection_count,
          logical_bytes_reclaimed,
          physical_bytes_before,
          physical_bytes_after,
          terminal_outcome_json,
          started_at,
          updated_at
        )
        VALUES (
          ${journal.journalId},
          ${journal.safetyWatermark},
          ${journal.phase},
          ${journal.eventBatchCursor},
          ${journal.projectionBatchCursor},
          ${journal.eligibleEventCount},
          ${journal.processedEventCount},
          ${journal.skippedEventCount},
          ${journal.eligibleProjectionCount},
          ${journal.processedProjectionCount},
          ${journal.skippedProjectionCount},
          ${journal.logicalBytesReclaimed},
          ${journal.physicalBytesBefore},
          ${journal.physicalBytesAfter},
          ${journal.terminalOutcome === null ? null : JSON.stringify(journal.terminalOutcome)},
          ${journal.startedAt},
          ${journal.updatedAt}
        )
        ON CONFLICT (journal_id)
        DO UPDATE SET
          safety_watermark = excluded.safety_watermark,
          phase = excluded.phase,
          event_batch_cursor = excluded.event_batch_cursor,
          projection_batch_cursor = excluded.projection_batch_cursor,
          eligible_event_count = excluded.eligible_event_count,
          processed_event_count = excluded.processed_event_count,
          skipped_event_count = excluded.skipped_event_count,
          eligible_projection_count = excluded.eligible_projection_count,
          processed_projection_count = excluded.processed_projection_count,
          skipped_projection_count = excluded.skipped_projection_count,
          logical_bytes_reclaimed = excluded.logical_bytes_reclaimed,
          physical_bytes_before = excluded.physical_bytes_before,
          physical_bytes_after = excluded.physical_bytes_after,
          terminal_outcome_json = excluded.terminal_outcome_json,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at
      `,
  });

  const getJournal = SqlSchema.findOneOption({
    Request: GetDatabaseCompactionJournalInput,
    Result: DatabaseCompactionJournalDbRow,
    execute: ({ journalId }) =>
      sql`
        SELECT
          journal_id AS "journalId",
          safety_watermark AS "safetyWatermark",
          phase,
          event_batch_cursor AS "eventBatchCursor",
          projection_batch_cursor AS "projectionBatchCursor",
          eligible_event_count AS "eligibleEventCount",
          processed_event_count AS "processedEventCount",
          skipped_event_count AS "skippedEventCount",
          eligible_projection_count AS "eligibleProjectionCount",
          processed_projection_count AS "processedProjectionCount",
          skipped_projection_count AS "skippedProjectionCount",
          logical_bytes_reclaimed AS "logicalBytesReclaimed",
          physical_bytes_before AS "physicalBytesBefore",
          physical_bytes_after AS "physicalBytesAfter",
          terminal_outcome_json AS "terminalOutcome",
          started_at AS "startedAt",
          updated_at AS "updatedAt"
        FROM database_compaction_journal
        WHERE journal_id = ${journalId}
      `,
  });

  const upsert: DatabaseCompactionJournalRepositoryShape["upsert"] = (journal) =>
    upsertJournal(journal).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "DatabaseCompactionJournalRepository.upsert:query",
          "DatabaseCompactionJournalRepository.upsert:encodeRequest",
        ),
      ),
    );

  const get: DatabaseCompactionJournalRepositoryShape["get"] = (input) =>
    getJournal(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "DatabaseCompactionJournalRepository.get:query",
          "DatabaseCompactionJournalRepository.get:decodeRow",
        ),
      ),
    );

  return { upsert, get } satisfies DatabaseCompactionJournalRepositoryShape;
});

export const DatabaseCompactionJournalRepositoryLive = Layer.effect(
  DatabaseCompactionJournalRepository,
  makeDatabaseCompactionJournalRepository,
);
