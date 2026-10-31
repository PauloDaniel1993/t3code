import { deleteFlowRunsForThread } from "./FlowCleanup.ts";
// @effect-diagnostics preferSchemaOverJson:off -- Internal engine records include durable scheduling metadata outside RPC schemas.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  FlowApproval,
  FlowDefinition,
  FlowInputs,
  FlowRunSummary,
  FlowRunError,
  FlowStepRun,
  FlowStepRunId,
  FlowStepOutput,
  type FlowRunId,
  type FlowRunsCursor,
  type FlowRunsPage,
  type ProjectId,
  type ThreadId,
  type FlowRunForThreadResult,
} from "@t3tools/contracts";
import type { State, StepRun, Transition } from "./FlowEngine.ts";

export class FlowPersistenceError extends Schema.TaggedError<FlowPersistenceError>()(
  "FlowPersistenceError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  static readonly is = Schema.is(FlowPersistenceError);

  override get message() {
    return `Flow persistence failed during ${this.operation}.`;
  }
}

export class FlowRunRepository extends Context.Service<
  FlowRunRepository,
  {
    readonly runForThread: (
      id: ThreadId,
    ) => Effect.Effect<typeof FlowRunForThreadResult.Type, FlowPersistenceError>;
    readonly runForStep: (
      id: FlowStepRunId,
    ) => Effect.Effect<FlowRunId | null, FlowPersistenceError>;
    readonly active: () => Effect.Effect<ReadonlyArray<FlowRunId>, FlowPersistenceError>;
    readonly create: (state: State) => Effect.Effect<FlowRunSummary, FlowPersistenceError>;
    readonly read: (id: FlowRunId) => Effect.Effect<State | null, FlowPersistenceError>;
    readonly apply: (
      id: FlowRunId,
      expectedVersion: number,
      transitions: ReadonlyArray<Transition>,
    ) => Effect.Effect<void, FlowPersistenceError>;
    readonly list: (
      projectId: ProjectId,
      before?: FlowRunsCursor,
    ) => Effect.Effect<FlowRunsPage, FlowPersistenceError>;
    readonly stepOutput: (
      id: FlowStepRunId,
    ) => Effect.Effect<StepRun["output"], FlowPersistenceError>;
    readonly deleteForThread: (id: ThreadId) => Effect.Effect<void, FlowPersistenceError>;
  }
>()("t3/flows/FlowRunRepository") {}

const StoredStepRun = Schema.Struct({
  ...FlowStepRun.mapFields(({ output: _output, ...fields }) => fields).fields,
  cancelledBy: Schema.optional(FlowStepRunId),
  expectedMessageId: Schema.optional(Schema.String),
  superseded: Schema.optional(Schema.Boolean),
  cancelReason: Schema.optional(Schema.Literals(["stopped", "flow_failed", "retry_dependency"])),
  reportReceived: Schema.optional(Schema.Boolean),
  reminderSent: Schema.optional(Schema.Boolean),
  lastSettledTurnId: Schema.optional(Schema.String),
  takenEdges: Schema.optional(Schema.Array(Schema.Number)),
  items: Schema.optional(Schema.Array(Schema.String)),
});
const encodeStep = Schema.encodeSync(Schema.fromJsonString(StoredStepRun));
const encodeRun = Schema.encodeSync(Schema.fromJsonString(FlowRunSummary));
const encodeDefinition = Schema.encodeSync(Schema.fromJsonString(FlowDefinition));
const encodeInputs = Schema.encodeSync(Schema.fromJsonString(FlowInputs));
const encodeOutput = Schema.encodeSync(Schema.fromJsonString(Schema.NullOr(FlowStepOutput)));
const encodeError = Schema.encodeSync(Schema.fromJsonString(Schema.NullOr(FlowRunError)));
const decodeRun = Schema.decodeSync(Schema.fromJsonString(FlowRunSummary));
const decodeDefinition = Schema.decodeSync(Schema.fromJsonString(FlowDefinition));
const decodeInputs = Schema.decodeSync(Schema.fromJsonString(FlowInputs));
const decodeStep = Schema.decodeSync(Schema.fromJsonString(StoredStepRun));
const decodeOutput = Schema.decodeSync(Schema.fromJsonString(Schema.NullOr(FlowStepOutput)));
const parse = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (cause) => new FlowPersistenceError({ operation: "decode", cause }),
  });
const decodeApproval = Schema.decodeUnknownSync(FlowApproval);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const write = Effect.fn("FlowRunRepository.write")(function* (
    id: FlowRunId,
    transitions: ReadonlyArray<Transition>,
  ) {
    for (const t of transitions) {
      if (t.type === "run") {
        if (t.run.id !== id)
          return yield* new FlowPersistenceError({ operation: "run ownership", cause: null });
        yield* sql`UPDATE flow_runs SET
        summary_json = ${encodeRun(t.run)}, status = ${t.run.status}, error = ${encodeError(t.run.error)},
        started_at = ${t.run.startedAt}, finished_at = ${t.run.finishedAt} WHERE id = ${id}`;
      } else if (t.type === "step") {
        if (t.step.flowRunId !== id)
          return yield* new FlowPersistenceError({ operation: "step ownership", cause: null });
        const s = t.step;
        const encoded = yield* parse(() => ({
          state: encodeStep(s),
          output: encodeOutput(s.output),
          error: encodeError(s.error),
        }));
        const existing = yield* sql<{
          flow_run_id: string;
        }>`SELECT flow_run_id FROM flow_step_runs WHERE id = ${s.id}`;
        if (existing[0] && existing[0].flow_run_id !== id)
          return yield* new FlowPersistenceError({ operation: "step ownership", cause: null });
        yield* sql`INSERT INTO flow_step_runs ${sql.insert({ id: s.id, flow_run_id: id, parent_step_run_id: s.parentStepRunId, step_path: JSON.stringify(s.stepPath), iteration: s.iteration ?? null, item_index: s.itemIndex ?? null, attempt: s.attempt, status: s.status, thread_id: s.threadId, output: encoded.output, error: encoded.error, created_at: s.createdAt, started_at: s.startedAt, finished_at: s.finishedAt, state_json: encoded.state })}
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, thread_id = excluded.thread_id, output = excluded.output, error = excluded.error, started_at = excluded.started_at, finished_at = excluded.finished_at, state_json = excluded.state_json`;
      } else {
        const a = t.approval;
        const owner =
          yield* sql`SELECT id FROM flow_step_runs WHERE id = ${a.stepRunId} AND flow_run_id = ${id}`;
        if (!owner.length)
          return yield* new FlowPersistenceError({ operation: "approval ownership", cause: null });
        yield* sql`INSERT INTO flow_approvals ${sql.insert({ step_run_id: a.stepRunId, prompt: a.prompt, decision: a.decision, comment: a.comment ?? null, answered_by: a.answeredBy, answered_at: a.answeredAt })}
          ON CONFLICT(step_run_id) DO UPDATE SET decision = excluded.decision, comment = excluded.comment, answered_by = excluded.answered_by, answered_at = excluded.answered_at`;
      }
    }
  });
  const protect = <A>(
    operation: string,
    effect: Effect.Effect<A, SqlError | FlowPersistenceError>,
  ) =>
    effect.pipe(
      Effect.mapError((cause) =>
        FlowPersistenceError.is(cause) ? cause : new FlowPersistenceError({ operation, cause }),
      ),
    );
  const read = Effect.fn("FlowRunRepository.read")(function* (id: FlowRunId) {
    return yield* protect(
      "read",
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            version: number;
            summary_json: string;
            definition_snapshot: string;
            inputs: string;
            workspace: string | null;
            base_ref: string | null;
          }>`SELECT * FROM flow_runs WHERE id = ${id}`;
          const row = rows[0];
          if (!row) return null;
          const steps = yield* sql<{
            state_json: string;
            output: string;
          }>`SELECT state_json, output FROM flow_step_runs WHERE flow_run_id = ${id} ORDER BY rowid`;
          const approvals = yield* sql<{
            step_run_id: string;
            prompt: string;
            decision: string | null;
            comment: string | null;
            answered_by: string | null;
            answered_at: string | null;
          }>`SELECT a.* FROM flow_approvals a JOIN flow_step_runs s ON s.id = a.step_run_id WHERE s.flow_run_id = ${id}`;
          return yield* parse(
            () =>
              ({
                version: row.version,
                run: decodeRun(row.summary_json),
                definition: decodeDefinition(row.definition_snapshot),
                inputs: decodeInputs(row.inputs),
                workspace: row.workspace || null,
                baseRef: row.base_ref,
                stepRuns: steps.map((s) => {
                  const step = decodeStep(s.state_json);
                  return {
                    ...step,
                    output: decodeOutput(s.output),
                    scope:
                      step.parentStepRunId === null
                        ? "root"
                        : `${step.parentStepRunId}:${step.iteration ?? step.itemIndex ?? 0}`,
                  };
                }),
                approvals: approvals.map((a) =>
                  decodeApproval({
                    stepRunId: a.step_run_id,
                    prompt: a.prompt,
                    decision: a.decision,
                    ...(a.comment === null ? {} : { comment: a.comment }),
                    answeredBy: a.answered_by,
                    answeredAt: a.answered_at,
                  }),
                ),
              }) satisfies State,
          );
        }),
      ),
    );
  });
  return FlowRunRepository.of({
    runForThread: Effect.fn("FlowRunRepository.runForThread")(function* (id) {
      const runs = yield* protect(
        "thread lookup",
        sql<{ id: FlowRunId }>`SELECT id FROM flow_runs WHERE flow_run_thread_id = ${id} LIMIT 1`,
      );
      if (runs[0]) return { flowRunId: runs[0].id, role: "flow_run_thread" as const };
      const steps = yield* protect(
        "thread lookup",
        sql<{
          id: FlowStepRunId;
          flow_run_id: FlowRunId;
        }>`SELECT id, flow_run_id FROM flow_step_runs WHERE thread_id = ${id} ORDER BY rowid DESC LIMIT 1`,
      );
      return steps[0]
        ? { flowRunId: steps[0].flow_run_id, stepRunId: steps[0].id, role: "step_thread" as const }
        : null;
    }),
    runForStep: Effect.fn("FlowRunRepository.runForStep")(function* (id) {
      const rows = yield* protect(
        "step lookup",
        sql<{ flow_run_id: FlowRunId }>`SELECT flow_run_id FROM flow_step_runs WHERE id = ${id}`,
      );
      return rows[0]?.flow_run_id ?? null;
    }),
    active: Effect.fn("FlowRunRepository.active")(function* () {
      const rows = yield* protect(
        "active",
        sql<{
          id: FlowRunId;
        }>`SELECT id FROM flow_runs WHERE status IN ('starting', 'running', 'waiting_approval')`,
      );
      return rows.map((row) => row.id);
    }),
    create: Effect.fn("FlowRunRepository.create")(function* (state) {
      const r = state.run;
      return yield* protect(
        "create",
        sql.withTransaction(
          Effect.gen(function* () {
            const [number] = yield* sql<{ last_number: number }>`INSERT INTO flow_run_numbers
              (project_id, flow_id, last_number) VALUES (${r.projectId}, ${r.flowId}, 1)
              ON CONFLICT(project_id, flow_id) DO UPDATE SET last_number = last_number + 1
              RETURNING last_number`;
            const summary = {
              ...r,
              runNumber: number!.last_number,
              flowTitle: state.definition.title,
            };
            yield* sql`INSERT INTO flow_runs ${sql.insert({ id: r.id, version: state.version, project_id: r.projectId, flow_id: r.flowId, run_number: summary.runNumber, flow_title: summary.flowTitle, flow_run_thread_id: r.flowRunThreadId, definition_snapshot: encodeDefinition(state.definition), inputs: encodeInputs(state.inputs), base_ref: state.baseRef, workspace: state.workspace ?? "", status: r.status, error: encodeError(r.error), created_at: r.createdAt, started_at: r.startedAt, finished_at: r.finishedAt, scheduled_task_id: r.scheduledTaskId ?? null, summary_json: encodeRun(summary) })}`;
            yield* write(r.id, [
              ...state.stepRuns.map((step): Transition => ({ type: "step", step })),
              ...state.approvals.map((approval): Transition => ({ type: "approval", approval })),
            ]);
            return summary;
          }),
        ),
      );
    }),
    read,
    apply: Effect.fn("FlowRunRepository.apply")((id, expectedVersion, transitions) =>
      protect(
        "apply",
        sql.withTransaction(
          Effect.gen(function* () {
            const updated =
              yield* sql`UPDATE flow_runs SET version = version + 1 WHERE id = ${id} AND version = ${expectedVersion} RETURNING id`;
            if (updated.length !== 1)
              return yield* new FlowPersistenceError({
                operation: "version conflict",
                cause: null,
              });
            yield* write(id, transitions);
          }),
        ),
      ),
    ),
    list: Effect.fn("FlowRunRepository.list")(function* (projectId, before) {
      const rows = yield* protect(
        "list",
        before
          ? sql<{
              summary_json: string;
            }>`SELECT summary_json FROM flow_runs WHERE project_id = ${projectId}
            AND (created_at < ${before.createdAt} OR (created_at = ${before.createdAt} AND id < ${before.id}))
            ORDER BY created_at DESC, id DESC LIMIT 51`
          : sql<{
              summary_json: string;
            }>`SELECT summary_json FROM flow_runs WHERE project_id = ${projectId}
            ORDER BY created_at DESC, id DESC LIMIT 51`,
      );
      const runs = yield* parse(() => rows.slice(0, 50).map((row) => decodeRun(row.summary_json)));
      const last = runs.at(-1);
      return {
        runs,
        nextCursor: rows.length > 50 && last ? { createdAt: last.createdAt, id: last.id } : null,
      };
    }),
    stepOutput: Effect.fn("FlowRunRepository.stepOutput")(function* (id) {
      const rows = yield* protect(
        "output",
        sql<{ output: string }>`SELECT output FROM flow_step_runs WHERE id = ${id}`,
      );
      return yield* parse(() => (rows[0] ? decodeOutput(rows[0].output) : null));
    }),
    deleteForThread: Effect.fn("FlowRunRepository.deleteForThread")((id) =>
      protect(
        "delete",
        deleteFlowRunsForThread(id).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ).pipe(Effect.asVoid),
    ),
  });
});

export const layer = Layer.effect(FlowRunRepository, make);
