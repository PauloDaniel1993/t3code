import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { FlowStepRunId } from "@t3tools/contracts";
import FlowMigration from "../persistence/ForkMigrations/013_FlowRuns.ts";
import ScheduleMigration from "../persistence/ForkMigrations/014_ScheduledTaskFlow.ts";
import * as FlowRunRepository from "./FlowRunRepository.ts";
import { applyTransitions, decide } from "./FlowEngine.ts";
import { initialState } from "./flowTestUtils.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const testLayer = FlowRunRepository.layer.pipe(Layer.provideMerge(database));
it.effect(
  "migrates idempotently, round trips snapshots, applies atomically, and cascades tombstones",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, deleted_at TEXT)`;
      yield* sql`CREATE TABLE scheduled_tasks(task_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO scheduled_tasks VALUES ('existing')`;
      yield* FlowMigration;
      yield* ScheduleMigration;
      yield* FlowMigration;
      yield* ScheduleMigration;
      expect(yield* sql`SELECT flow_json FROM scheduled_tasks`).toEqual([{ flow_json: null }]);
      const repository = yield* FlowRunRepository.FlowRunRepository;
      const state = initialState({
        version: 1,
        title: "Stored",
        steps: [{ id: "gate", kind: "approval", prompt: "Ship?" }],
        edges: [],
      });
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${state.run.flowRunThreadId}, NULL)`;
      yield* repository.create(state);
      const decision = decide(state, { type: "start", at: state.run.createdAt });
      yield* repository.apply(state.run.id, decision.transitions);
      const expected = applyTransitions(state, decision.transitions);
      expect(yield* repository.read(state.run.id)).toEqual(expected);
      expect(yield* repository.list(state.run.projectId)).toEqual([expected.run]);
      const step = expected.stepRuns[0]!;
      const answer = decide(expected, {
        type: "approval_answered",
        stepRunId: step.id,
        at: state.run.createdAt,
        decision: "approve",
        answeredBy: "tester",
      });
      yield* repository.apply(state.run.id, answer.transitions);
      expect(yield* repository.stepOutput(step.id)).toEqual({ decision: "approve" });
      const rollback = yield* repository
        .apply(state.run.id, [
          { type: "run", run: { ...expected.run, status: "failed" } },
          {
            type: "approval",
            approval: { ...expected.approvals[0]!, stepRunId: FlowStepRunId.make("absent") },
          },
        ])
        .pipe(Effect.exit);
      expect(rollback._tag).toBe("Failure");
      expect((yield* repository.read(state.run.id))?.run.status).toBe("succeeded");
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = 'now' WHERE thread_id = ${state.run.flowRunThreadId}`;
      expect(yield* repository.read(state.run.id)).toBeNull();
      expect(yield* sql`SELECT * FROM flow_step_runs`).toEqual([]);
      expect(yield* sql`SELECT * FROM flow_approvals`).toEqual([]);
      yield* repository.create(state);
      yield* repository.deleteForThread(state.run.flowRunThreadId);
      expect(yield* repository.list(state.run.projectId)).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
);
