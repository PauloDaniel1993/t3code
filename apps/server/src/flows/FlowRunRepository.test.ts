import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import {
  FlowRunId,
  FlowStepRunId,
  ThreadId,
  ProjectId,
  type FlowStepOutput,
} from "@t3tools/contracts";
import FlowMigration from "../persistence/ForkMigrations/013_FlowRuns.ts";
import ScheduleMigration from "../persistence/ForkMigrations/014_ScheduledTaskFlow.ts";
import * as FlowRunRepository from "./FlowRunRepository.ts";
import { applyTransitions, decide } from "./FlowEngine.ts";
import { initialState } from "./FlowEngine.test-support.ts";
import { sweepOrphanedFlowRuns } from "./FlowCleanup.ts";

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
      yield* repository.apply(state.run.id, 0, decision.transitions);
      const expected = { ...applyTransitions(state, decision.transitions), version: 1 };
      expect(yield* repository.read(state.run.id)).toEqual(expected);
      expect(
        (yield* repository.apply(state.run.id, 0, decision.transitions).pipe(Effect.exit))._tag,
      ).toBe("Failure");
      expect((yield* repository.read(state.run.id))?.version).toBe(1);
      expect((yield* repository.list(state.run.projectId)).runs).toEqual([expected.run]);
      const step = expected.stepRuns[0]!;
      const answer = decide(expected, {
        type: "approval_answered",
        stepRunId: step.id,
        at: state.run.createdAt,
        decision: "approve",
        answeredBy: "tester",
      });
      yield* repository.apply(state.run.id, 1, answer.transitions);
      expect(yield* repository.stepOutput(step.id)).toEqual({
        kind: "approval",
        decision: "approve",
      });
      const rollback = yield* repository
        .apply(state.run.id, 2, [
          { type: "run", run: { ...expected.run, status: "failed" } },
          {
            type: "approval",
            approval: { ...expected.approvals[0]!, stepRunId: FlowStepRunId.make("absent") },
          },
        ])
        .pipe(Effect.exit);
      expect(rollback._tag).toBe("Failure");
      expect((yield* repository.read(state.run.id))?.run.status).toBe("succeeded");
      const outputs: FlowStepOutput[] = [
        { kind: "agent", text: "result", decision: "approve", risk: 2 },
        {
          kind: "command",
          text: "output",
          lines: ["output"],
          lineCount: 1,
          exitCode: 5,
          timedOut: false,
        },
        {
          kind: "loop",
          iterations: 1,
          exitReason: "condition",
          steps: { kind: { kind: "agent", text: "nested" } },
        },
        {
          kind: "map",
          items: [{ status: "succeeded", outputs: { inner: { kind: "agent", text: "map" } } }],
        },
      ];
      yield* repository.apply(
        state.run.id,
        2,
        outputs.map((output, index) => ({
          type: "step",
          step: { ...step, id: FlowStepRunId.make(`output-${index}`), output },
        })),
      );
      for (const [index, output] of outputs.entries())
        expect(yield* repository.stepOutput(FlowStepRunId.make(`output-${index}`))).toEqual(output);
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = 'now' WHERE thread_id = ${state.run.flowRunThreadId}`;
      yield* repository.deleteForThread(state.run.flowRunThreadId);
      expect(yield* repository.read(state.run.id)).toBeNull();
      expect(yield* sql`SELECT * FROM flow_step_runs`).toEqual([]);
      expect(yield* sql`SELECT * FROM flow_approvals`).toEqual([]);
      yield* repository.create(state);
      yield* sweepOrphanedFlowRuns();
      expect((yield* repository.list(state.run.projectId)).runs).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "allocates stable per-flow numbers and pages tied timestamps without losing nested identity",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, deleted_at TEXT)`;
      yield* FlowMigration;
      const repository = yield* FlowRunRepository.FlowRunRepository;
      const initial = initialState({
        version: 1,
        title: "Snapshot title",
        steps: [
          {
            id: "loop",
            kind: "loop",
            maxIterations: 1,
            until: { ref: "iteration", op: "eq", value: 0 },
            steps: [{ id: "gate", kind: "approval", prompt: "Approve?" }],
            edges: [],
          },
        ],
        edges: [],
      });
      for (let i = 1; i <= 52; i++) {
        const id = String(i).padStart(3, "0");
        const summary = yield* repository.create({
          ...initial,
          run: {
            ...initial.run,
            id: FlowRunId.make(id),
            flowRunThreadId: ThreadId.make(id),
            flowTitle: "Stale title",
            runNumber: 99,
          },
        });
        expect(summary).toMatchObject({ runNumber: i, flowTitle: "Snapshot title" });
      }
      const page = yield* repository.list(initial.run.projectId);
      expect(page.runs).toHaveLength(50);
      expect(page.runs[0]?.runNumber).toBe(52);
      expect(page.nextCursor).not.toBeNull();
      const older = yield* repository.list(initial.run.projectId, page.nextCursor!);
      expect(older.runs.map((r) => r.runNumber)).toEqual([2, 1]);
      expect(older.nextCursor).toBeNull();
      yield* repository.deleteForThread(ThreadId.make("052"));
      const summary = yield* repository.create(initial);
      expect(summary.runNumber).toBe(53);
      const state = { ...initial, run: summary };
      const decision = decide(state, { type: "start", at: summary.createdAt });
      yield* repository.apply(summary.id, 0, decision.transitions);
      const restored = yield* repository.read(summary.id);
      const parent = restored?.stepRuns.find((s) => s.stepPath.at(-1) === "loop");
      const child = restored?.stepRuns.find((s) => s.stepPath.at(-1) === "gate");
      expect(child).toMatchObject({ parentStepRunId: parent?.id, iteration: 0 });
      expect(
        yield* sql`SELECT parent_step_run_id FROM flow_step_runs WHERE id = ${child!.id}`,
      ).toEqual([{ parent_step_run_id: parent!.id }]);
      const otherProject = yield* repository.create({
        ...initial,
        run: {
          ...initial.run,
          id: FlowRunId.make("other"),
          flowRunThreadId: ThreadId.make("other"),
          projectId: ProjectId.make("other"),
        },
      });
      expect(otherProject.runNumber).toBe(1);
    }).pipe(Effect.provide(testLayer)),
);
