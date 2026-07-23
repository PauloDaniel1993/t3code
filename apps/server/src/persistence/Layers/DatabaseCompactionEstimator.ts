import type { DatabaseMaintenanceEstimate } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DATABASE_MAINTENANCE_SAFETY_MARGIN_BYTES } from "../DatabasePhysicalMaintenance.ts";
import {
  compactLegacyToolUpdateEventPayload,
  deriveLegacyToolIdentity,
  isTerminalLegacyToolStatus,
} from "../DatabaseCompactionPayload.ts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  DatabaseCompactionEstimator,
  type DatabaseCompactionEstimatorShape,
} from "../Services/DatabaseCompactionEstimator.ts";

const ESTIMATE_BATCH_SIZE = 50;
const RECOMMENDED_RECLAIMABLE_BYTES = 64 * 1024 * 1024;
const RECOMMENDED_FREE_PAGE_RATIO = 0.2;

interface PragmaSizeRow {
  readonly pageCount: number;
  readonly pageSize: number;
  readonly freePageCount: number;
}

interface EventCandidateRow {
  readonly sequence: number;
  readonly payloadJson: string;
}

interface ProjectionCandidateRow {
  readonly rowId: number;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly activityId: string;
  readonly payloadJson: string;
  readonly summaryBytes: number;
  readonly sequence: number | null;
  readonly createdAt: string;
}

interface CountRow {
  readonly count: number;
}

interface WatermarkRow {
  readonly safetyWatermark: number | null;
}

type RetainedProjectionCandidate = {
  readonly bytes: number;
  readonly terminal: boolean;
  readonly sequence: number | null;
  readonly createdAt: string;
  readonly activityId: string;
};

const projectionOrder = (
  left: RetainedProjectionCandidate,
  right: RetainedProjectionCandidate,
): number =>
  Number(left.terminal) - Number(right.terminal) ||
  (left.sequence ?? -1) - (right.sequence ?? -1) ||
  left.createdAt.localeCompare(right.createdAt) ||
  left.activityId.localeCompare(right.activityId);

const parseJson = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

const makeDatabaseCompactionEstimator = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const estimate: DatabaseCompactionEstimatorShape["estimate"] = () =>
    Effect.gen(function* () {
      const [sizeRow] = yield* sql<PragmaSizeRow>`
      SELECT
        (SELECT page_count FROM pragma_page_count()) AS "pageCount",
        (SELECT page_size FROM pragma_page_size()) AS "pageSize",
        (SELECT freelist_count FROM pragma_freelist_count()) AS "freePageCount"
    `;
      const [watermarkRow] = yield* sql<WatermarkRow>`
      SELECT MIN(last_applied_sequence) AS "safetyWatermark"
      FROM projection_state
    `;
      const safetyWatermark = watermarkRow?.safetyWatermark ?? 0;

      let eventCursor = 0;
      let eligibleEventCount = 0;
      let reclaimableEventPayloadBytes = 0;
      while (eventCursor < safetyWatermark) {
        const rows = yield* sql<EventCandidateRow>`
        SELECT
          sequence,
          payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE sequence > ${eventCursor}
          AND sequence <= ${safetyWatermark}
          AND event_type = 'thread.activity-appended'
        ORDER BY sequence ASC
        LIMIT ${ESTIMATE_BATCH_SIZE}
      `;
        if (rows.length === 0) {
          break;
        }
        for (const row of rows) {
          eventCursor = row.sequence;
          const candidate = compactLegacyToolUpdateEventPayload(row.payloadJson);
          if (candidate._tag === "eligible") {
            eligibleEventCount += 1;
            reclaimableEventPayloadBytes += candidate.reclaimedBytes;
          }
        }
      }

      let projectionCursor = 0;
      let eligibleProjectionCount = 0;
      let supersededProjectionBytes = 0;
      const retainedByIdentity = new Map<string, RetainedProjectionCandidate>();
      while (true) {
        const rows = yield* sql<ProjectionCandidateRow>`
        SELECT
          rowid AS "rowId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          activity_id AS "activityId",
          payload_json AS "payloadJson",
          length(CAST(summary AS BLOB)) AS "summaryBytes",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE rowid > ${projectionCursor}
          AND kind = 'tool.updated'
          AND sequence IS NOT NULL
          AND sequence <= ${safetyWatermark}
        ORDER BY rowid ASC
        LIMIT ${ESTIMATE_BATCH_SIZE}
      `;
        if (rows.length === 0) {
          break;
        }
        for (const row of rows) {
          projectionCursor = row.rowId;
          if (row.turnId === null) {
            continue;
          }
          const payload = parseJson(row.payloadJson);
          const identity = deriveLegacyToolIdentity(payload);
          if (identity._tag === "skipped") {
            continue;
          }
          const key = `${identity.providerIdentity ?? ""}\u0000${row.threadId}\u0000${row.turnId}\u0000${identity.toolId}`;
          const candidate = {
            bytes: Buffer.byteLength(row.payloadJson, "utf8") + row.summaryBytes,
            terminal: isTerminalLegacyToolStatus(payload),
            sequence: row.sequence,
            createdAt: row.createdAt,
            activityId: row.activityId,
          };
          const retained = retainedByIdentity.get(key);
          if (retained === undefined) {
            retainedByIdentity.set(key, candidate);
            continue;
          }
          eligibleProjectionCount += 1;
          if (projectionOrder(retained, candidate) < 0) {
            supersededProjectionBytes += retained.bytes;
            retainedByIdentity.set(key, candidate);
          } else {
            supersededProjectionBytes += candidate.bytes;
          }
        }
      }

      const [[activeProviderWork], [pendingTurns], [pendingRequests]] = yield* Effect.all(
        [
          sql<CountRow>`
          SELECT COUNT(*) AS "count"
          FROM provider_session_runtime
          WHERE status IN ('starting', 'running')
        `,
          sql<CountRow>`
          SELECT COUNT(*) AS "count"
          FROM projection_turns
          WHERE state = 'running' OR (turn_id IS NULL AND state = 'pending')
        `,
          sql<CountRow>`
          SELECT COUNT(*) AS "count"
          FROM projection_pending_approvals
          WHERE status = 'pending'
        `,
        ],
        { concurrency: "unbounded" },
      );
      const activeWorkBlockers = [
        ...(activeProviderWork !== undefined && activeProviderWork.count > 0
          ? ["provider-work-active"]
          : []),
        ...(pendingTurns !== undefined && pendingTurns.count > 0 ? ["turn-work-active"] : []),
        ...(pendingRequests !== undefined && pendingRequests.count > 0
          ? ["approval-or-input-pending"]
          : []),
      ];

      const pageCount = sizeRow?.pageCount ?? 0;
      const pageSize = sizeRow?.pageSize ?? 0;
      const freePageCount = sizeRow?.freePageCount ?? 0;
      const databaseBytes = pageCount * pageSize;
      const freePageBytes = freePageCount * pageSize;
      const estimatedReclaimableBytes =
        freePageBytes + reclaimableEventPayloadBytes + supersededProjectionBytes;
      const temporaryDiskRequiredBytes = databaseBytes + DATABASE_MAINTENANCE_SAFETY_MARGIN_BYTES;
      const recommended =
        estimatedReclaimableBytes >= RECOMMENDED_RECLAIMABLE_BYTES ||
        (databaseBytes > 0 && freePageBytes / databaseBytes >= RECOMMENDED_FREE_PAGE_RATIO);

      return {
        databaseBytes,
        freePageBytes,
        reclaimableEventPayloadBytes,
        supersededProjectionBytes,
        estimatedReclaimableBytes,
        temporaryDiskRequiredBytes,
        safetyWatermark,
        eligibleEventCount,
        eligibleProjectionCount,
        recommended,
        activeWorkBlockers,
      } satisfies DatabaseMaintenanceEstimate;
    }).pipe(Effect.mapError(toPersistenceSqlError("DatabaseCompactionEstimator.estimate:query")));

  return { estimate } satisfies DatabaseCompactionEstimatorShape;
});

export const DatabaseCompactionEstimatorLive = Layer.effect(
  DatabaseCompactionEstimator,
  makeDatabaseCompactionEstimator,
);
