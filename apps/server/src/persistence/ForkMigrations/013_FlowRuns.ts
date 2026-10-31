import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS flow_runs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, flow_id TEXT NOT NULL,
    flow_run_thread_id TEXT NOT NULL UNIQUE, definition_snapshot TEXT NOT NULL,
    inputs TEXT NOT NULL, base_ref TEXT, workspace TEXT NOT NULL,
    status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL,
    started_at TEXT, finished_at TEXT, scheduled_task_id TEXT, summary_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS flow_runs_project ON flow_runs(project_id, created_at)`;
  yield* sql`CREATE TABLE IF NOT EXISTS flow_step_runs (
    id TEXT PRIMARY KEY, flow_run_id TEXT NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
    step_path TEXT NOT NULL, iteration INTEGER, item_index INTEGER, attempt INTEGER NOT NULL,
    status TEXT NOT NULL, thread_id TEXT, output TEXT, error TEXT,
    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, state_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS flow_steps_run ON flow_step_runs(flow_run_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS flow_approvals (
    step_run_id TEXT PRIMARY KEY REFERENCES flow_step_runs(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL, decision TEXT, comment TEXT, answered_by TEXT, answered_at TEXT
  )`;
  // Thread deletion is a tombstone update; projection rebuilds must not erase flow history.
  yield* sql`CREATE TRIGGER IF NOT EXISTS flow_thread_deleted
    AFTER UPDATE OF deleted_at ON orchestration_v2_projection_threads
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
    BEGIN DELETE FROM flow_runs WHERE flow_run_thread_id = NEW.thread_id; END`;
});
