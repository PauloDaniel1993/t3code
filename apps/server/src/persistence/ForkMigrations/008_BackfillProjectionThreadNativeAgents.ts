import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { deriveNativeAgents, selectVisibleNativeAgents } from "../../orchestration/nativeAgents.ts";

const decodePayloadJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeNativeAgentsJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Rebuild `native_agents_json` from the activities already on disk.
 *
 * The projection folds in-session agents as their activities arrive and never
 * re-reads stored ones, so the column only ever described agents that ran while
 * the feature was live. Everything older stayed invisible even though its
 * `task.*` activities were sitting in `projection_thread_activities` — and
 * migration 007, which cleared the column to drop rows that were never agents,
 * left every thread in exactly that state.
 *
 * This recomputes each thread's set from its own activity history using the same
 * pure derivation the pipeline uses, so a backfilled thread and a live one cannot
 * disagree.
 *
 * Idempotent: it is a pure function of the activities, so re-running it produces
 * the same answer. Threads whose activities yield no agents are set back to NULL
 * rather than an empty array, keeping "never had one" distinct from "had some".
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "native_agents_json")) {
    return;
  }

  // Only threads that actually carry lifecycle activities are worth reading.
  const threadIds = yield* sql<{ readonly threadId: string }>`
    SELECT DISTINCT thread_id AS "threadId"
    FROM projection_thread_activities
    WHERE kind IN ('task.started', 'task.progress', 'task.completed')
  `;

  let backfilled = 0;
  for (const { threadId } of threadIds) {
    const rows = yield* sql<{
      readonly activityId: string;
      readonly turnId: string | null;
      readonly tone: string;
      readonly kind: string;
      readonly summary: string;
      readonly payloadJson: string | null;
      readonly createdAt: string;
      readonly sequence: number | null;
    }>`
      SELECT
        activity_id AS "activityId",
        turn_id AS "turnId",
        tone,
        kind,
        summary,
        payload_json AS "payloadJson",
        created_at AS "createdAt",
        sequence
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
        AND kind IN ('task.started', 'task.progress', 'task.completed')
      ORDER BY sequence ASC, created_at ASC
    `;

    const activities = rows.map((row) => ({
      id: row.activityId,
      tone: row.tone,
      kind: row.kind,
      summary: row.summary,
      // Stored as JSON text; the derivation only ever reads known scalar fields
      // off it and ignores anything it does not recognise.
      payload: row.payloadJson === null ? null : decodePayloadJson(row.payloadJson),
      turnId: row.turnId,
      createdAt: row.createdAt,
      ...(row.sequence === null ? {} : { sequence: row.sequence }),
    }));

    // The ids are branded on the contract but only ever compared and copied
    // here, so the stored strings stand in for them.
    const agents = selectVisibleNativeAgents(
      deriveNativeAgents(activities as unknown as Parameters<typeof deriveNativeAgents>[0]),
    );
    const next = agents.length === 0 ? null : encodeNativeAgentsJson(agents);
    yield* sql`
      UPDATE projection_threads
      SET native_agents_json = ${next}
      WHERE thread_id = ${threadId}
    `;
    if (agents.length > 0) {
      backfilled += 1;
    }
  }

  yield* Effect.log("Backfilled in-session agents from stored activities").pipe(
    Effect.annotateLogs({ threadsScanned: threadIds.length, threadsWithAgents: backfilled }),
  );
});
