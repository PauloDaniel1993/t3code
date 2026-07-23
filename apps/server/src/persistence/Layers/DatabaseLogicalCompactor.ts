import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PROVIDER_EVENT_FLOW_CONTROL } from "../../orchestration/ProviderEventFlowControl.ts";
import {
  compactLegacyToolSummary,
  compactLegacyToolUpdateEventPayload,
  compactLegacyToolUpdateProjectionPayload,
  deriveLegacyToolIdentity,
} from "../DatabaseCompactionPayload.ts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  DatabaseLogicalCompactor,
  type DatabaseLogicalCompactorShape,
} from "../Services/DatabaseLogicalCompactor.ts";

interface EventCompactionRow {
  readonly sequence: number;
  readonly payloadJson: string;
}

interface ProjectionCompactionRow {
  readonly rowId: number;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly activityId: string;
  readonly summary: string;
  readonly payloadJson: string;
  readonly sequence: number | null;
  readonly summaryBytes: number;
}

interface ProjectionRowId {
  readonly rowId: number;
}

const parseJson = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

const normalizeBatchSize = (batchSize: number | undefined): number =>
  Math.max(
    1,
    Math.min(
      Math.floor(batchSize ?? PROVIDER_EVENT_FLOW_CONTROL.logicalCompactionBatchSize),
      PROVIDER_EVENT_FLOW_CONTROL.logicalCompactionBatchSize,
    ),
  );

const makeDatabaseLogicalCompactor = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const compactEventBatch: DatabaseLogicalCompactorShape["compactEventBatch"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const safetyWatermark = Math.max(0, Math.floor(input.safetyWatermark));
          const cursor = Math.max(0, Math.floor(input.cursor));
          const batchSize = normalizeBatchSize(input.batchSize);
          const rows = yield* sql<EventCompactionRow>`
            SELECT
              sequence,
              payload_json AS "payloadJson"
            FROM orchestration_events
            WHERE sequence > ${cursor}
              AND sequence <= ${safetyWatermark}
              AND event_type = 'thread.activity-appended'
            ORDER BY sequence ASC
            LIMIT ${batchSize}
          `;

          let rewrittenRows = 0;
          let skippedRows = 0;
          let reclaimedBytes = 0;
          for (const row of rows) {
            const candidate = compactLegacyToolUpdateEventPayload(row.payloadJson);
            if (candidate._tag === "eligible") {
              yield* sql`
                UPDATE orchestration_events
                SET payload_json = ${candidate.compactedPayloadJson}
                WHERE sequence = ${row.sequence}
                  AND payload_json = ${row.payloadJson}
              `;
              rewrittenRows += 1;
              reclaimedBytes += candidate.reclaimedBytes;
            } else if (candidate._tag === "skipped") {
              skippedRows += 1;
            }
          }

          return {
            cursor: rows.at(-1)?.sequence ?? cursor,
            scannedRows: rows.length,
            rewrittenRows,
            skippedRows,
            reclaimedBytes,
            done: rows.length < batchSize,
          };
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("DatabaseLogicalCompactor.compactEventBatch:query")),
      );

  const compactProjectionBatch: DatabaseLogicalCompactorShape["compactProjectionBatch"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const safetyWatermark = Math.max(0, Math.floor(input.safetyWatermark));
          const cursor = Math.max(0, Math.floor(input.cursor));
          const batchSize = normalizeBatchSize(input.batchSize);
          const rows = yield* sql<ProjectionCompactionRow>`
            SELECT
              rowid AS "rowId",
              thread_id AS "threadId",
              turn_id AS "turnId",
              activity_id AS "activityId",
              summary,
              payload_json AS "payloadJson",
              sequence,
              length(CAST(summary AS BLOB)) AS "summaryBytes"
            FROM projection_thread_activities
            WHERE rowid > ${cursor}
              AND kind = 'tool.updated'
            ORDER BY rowid ASC
            LIMIT ${batchSize}
          `;

          let deletedRows = 0;
          let skippedRows = 0;
          let reclaimedBytes = 0;
          for (const row of rows) {
            if (row.turnId === null || row.sequence === null || row.sequence > safetyWatermark) {
              skippedRows += 1;
              continue;
            }
            const payload = parseJson(row.payloadJson);
            const identity = deriveLegacyToolIdentity(payload);
            if (identity._tag === "skipped") {
              skippedRows += 1;
              continue;
            }
            const [retained] = yield* sql<ProjectionRowId>`
              SELECT rowid AS "rowId"
              FROM projection_thread_activities
              WHERE thread_id = ${row.threadId}
                AND turn_id = ${row.turnId}
                AND kind = 'tool.updated'
                AND sequence IS NOT NULL
                AND sequence <= ${safetyWatermark}
                AND (
                  CASE
                    WHEN json_valid(payload_json)
                    THEN COALESCE(
                      NULLIF(TRIM(json_extract(payload_json, '$.toolUseId')), ''),
                      NULLIF(TRIM(json_extract(payload_json, '$.itemId')), ''),
                      NULLIF(TRIM(json_extract(payload_json, '$.taskId')), '')
                    )
                    ELSE NULL
                  END
                ) = ${identity.toolId}
                AND (
                  CASE
                    WHEN json_valid(payload_json)
                    THEN COALESCE(NULLIF(TRIM(json_extract(payload_json, '$.toolUseId')), ''), ${identity.toolId})
                    ELSE NULL
                  END
                ) = ${identity.toolId}
                AND (
                  CASE
                    WHEN json_valid(payload_json)
                    THEN COALESCE(NULLIF(TRIM(json_extract(payload_json, '$.itemId')), ''), ${identity.toolId})
                    ELSE NULL
                  END
                ) = ${identity.toolId}
                AND (
                  CASE
                    WHEN json_valid(payload_json)
                    THEN COALESCE(NULLIF(TRIM(json_extract(payload_json, '$.taskId')), ''), ${identity.toolId})
                    ELSE NULL
                  END
                ) = ${identity.toolId}
                AND (
                  CASE
                    WHEN json_valid(payload_json)
                    THEN COALESCE(
                      NULLIF(TRIM(json_extract(payload_json, '$.providerInstanceId')), ''),
                      NULLIF(TRIM(json_extract(payload_json, '$.provider')), ''),
                      ''
                    )
                    ELSE ''
                  END
                ) = ${identity.providerIdentity ?? ""}
              ORDER BY
                CASE
                    WHEN json_valid(payload_json)
                    AND LOWER(json_extract(payload_json, '$.status')) IN (
                      'completed', 'failed', 'error', 'cancelled', 'canceled', 'aborted',
                      'declined', 'interrupted', 'stopped'
                    )
                  THEN 1
                  ELSE 0
                END DESC,
                sequence DESC,
                created_at DESC,
                activity_id DESC
              LIMIT 1
            `;
            if (retained === undefined || retained.rowId === row.rowId) {
              const compacted = compactLegacyToolUpdateProjectionPayload({
                threadId: row.threadId,
                turnId: row.turnId,
                payloadJson: row.payloadJson,
              });
              if (compacted._tag === "skipped") {
                skippedRows += 1;
                continue;
              }
              const compactedSummary = compactLegacyToolSummary(row.summary);
              yield* sql`
                UPDATE OR REPLACE projection_thread_activities
                SET
                  activity_id = ${compacted.stableActivityId},
                  summary = ${compactedSummary},
                  payload_json = ${compacted.payloadJson}
                WHERE rowid = ${row.rowId}
              `;
              reclaimedBytes +=
                compacted.reclaimedBytes +
                Math.max(
                  0,
                  Buffer.byteLength(row.summary, "utf8") -
                    Buffer.byteLength(compactedSummary, "utf8"),
                );
              continue;
            }
            yield* sql`
              DELETE FROM projection_thread_activities
              WHERE rowid = ${row.rowId}
            `;
            deletedRows += 1;
            reclaimedBytes += Buffer.byteLength(row.payloadJson, "utf8") + row.summaryBytes;
          }

          return {
            cursor: rows.at(-1)?.rowId ?? cursor,
            scannedRows: rows.length,
            deletedRows,
            skippedRows,
            reclaimedBytes,
            done: rows.length < batchSize,
          };
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("DatabaseLogicalCompactor.compactProjectionBatch:query"),
        ),
      );

  return { compactEventBatch, compactProjectionBatch } satisfies DatabaseLogicalCompactorShape;
});

export const DatabaseLogicalCompactorLive = Layer.effect(
  DatabaseLogicalCompactor,
  makeDatabaseLogicalCompactor,
);
