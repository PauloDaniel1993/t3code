import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const deleteFlowRunsForThread = Effect.fn("FlowCleanup.deleteForThread")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'flow_runs'`).length)
    return;
  yield* sql`DELETE FROM flow_runs WHERE flow_run_thread_id = ${threadId}`;
});

export const sweepOrphanedFlowRuns = Effect.fn("FlowCleanup.sweepOrphans")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER IF EXISTS flow_thread_deleted`;
  // A run gets its thread during preparation; unprepared runs are failed by recovery, not swept.
  yield* sql`DELETE FROM flow_runs WHERE workspace <> '' AND NOT EXISTS (
    SELECT 1 FROM orchestration_v2_projection_threads t
    WHERE t.thread_id = flow_runs.flow_run_thread_id AND t.deleted_at IS NULL
  )`;
});

export const flowChildThreadIds = Effect.fn("FlowCleanup.childThreads")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'flow_runs'`).length)
    return [];
  const rows = yield* sql<{
    thread_id: ThreadId;
  }>`SELECT DISTINCT s.thread_id FROM flow_step_runs s JOIN flow_runs r ON r.id = s.flow_run_id WHERE r.flow_run_thread_id = ${threadId} AND s.thread_id IS NOT NULL`;
  return rows.map((row) => row.thread_id);
});
