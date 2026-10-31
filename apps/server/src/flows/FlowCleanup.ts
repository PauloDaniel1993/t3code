import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const deleteFlowRunsForThread = Effect.fn("FlowCleanup.deleteForThread")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM flow_runs WHERE flow_run_thread_id = ${threadId}`;
});

export const sweepOrphanedFlowRuns = Effect.fn("FlowCleanup.sweepOrphans")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER IF EXISTS flow_thread_deleted`;
  yield* sql`DELETE FROM flow_runs WHERE NOT EXISTS (
    SELECT 1 FROM orchestration_v2_projection_threads t
    WHERE t.thread_id = flow_runs.flow_run_thread_id AND t.deleted_at IS NULL
  )`;
});
