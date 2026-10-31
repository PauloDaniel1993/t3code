// @effect-diagnostics preferSchemaOverJson:off -- Compare bounded stream projections and describe declared report fields.
import {
  FlowError,
  FlowRevisionConflict,
  FlowRunId,
  ThreadId,
  type FlowDefinition,
  type FlowDefinitionEntry,
  type FlowId,
  type FlowInputs,
  type FlowRunSummary,
  type FlowStepRunId,
  type FlowRunSnapshot,
  type FlowRunEvent,
  type FlowRunsEvent,
  type FlowRunsCursor,
  type FlowRunsPage,
  type FlowValidationResult,
  type ProjectId,
  type ScheduledTaskId,
  type FlowRunForThreadResult,
  type FlowStepOutput,
} from "@t3tools/contracts";
import { coerceFlowInputs, resolveFlowInputs, FlowValueError } from "@t3tools/shared/flow";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Definitions from "./FlowDefinitions.ts";
import * as Repository from "./FlowRunRepository.ts";
import * as Lock from "./FlowRunLock.ts";
import * as Commands from "./FlowCommandRunner.ts";
import * as Runtime from "./FlowRuntime.ts";
import {
  decide,
  applyTransitions,
  type State,
  type Trigger,
  type StepRun,
  type Action,
} from "./FlowEngine.ts";
import { sweepOrphanedFlowRuns } from "./FlowCleanup.ts";

export interface FlowStart {
  readonly projectId: ProjectId;
  readonly flowId: FlowId;
  readonly inputs: FlowInputs;
  readonly baseRef?: string | undefined;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly coerce?: boolean;
}
export class FlowService extends Context.Service<
  FlowService,
  {
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<typeof FlowDefinitionEntry.Type>, FlowError>;
    readonly watch: (
      projectId: ProjectId,
      connection: object,
    ) => Stream.Stream<
      { readonly flows: ReadonlyArray<typeof FlowDefinitionEntry.Type> },
      FlowError
    >;
    readonly read: (
      projectId: ProjectId,
      flowId: FlowId,
    ) => Effect.Effect<typeof FlowDefinitionEntry.Type, FlowError>;
    readonly validate: (definition: unknown) => Effect.Effect<FlowValidationResult>;
    readonly save: (input: {
      readonly projectId: ProjectId;
      readonly flowId: FlowId;
      readonly definition: FlowDefinition;
      readonly baseRevision: string | null;
    }) => Effect.Effect<typeof FlowDefinitionEntry.Type, FlowError | FlowRevisionConflict>;
    readonly rename: (
      projectId: ProjectId,
      flowId: FlowId,
      newFlowId: FlowId,
    ) => Effect.Effect<typeof FlowDefinitionEntry.Type, FlowError>;
    readonly delete: (projectId: ProjectId, flowId: FlowId) => Effect.Effect<void, FlowError>;
    readonly start: (input: FlowStart) => Effect.Effect<FlowRunSummary, FlowError>;
    readonly trigger: (id: FlowRunId, trigger: Trigger) => Effect.Effect<FlowRunSummary, FlowError>;
    readonly stop: (id: FlowRunId) => Effect.Effect<FlowRunSummary, FlowError>;
    readonly resume: (id: FlowRunId) => Effect.Effect<FlowRunSummary, FlowError>;
    readonly retryStep: (id: FlowStepRunId) => Effect.Effect<FlowRunSummary, FlowError>;
    readonly answerApproval: (
      input: {
        readonly stepRunId: FlowStepRunId;
        readonly decision: "approve" | "reject";
        readonly comment?: string | undefined;
      },
      answeredBy: string,
    ) => Effect.Effect<FlowRunSummary, FlowError>;
    readonly report: (
      threadId: ThreadId,
      fields: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<FlowValidationResult, FlowError>;
    readonly runsPage: (
      projectId: ProjectId,
      before?: FlowRunsCursor,
    ) => Effect.Effect<FlowRunsPage, FlowError>;
    readonly runs: (projectId: ProjectId) => Stream.Stream<FlowRunsEvent, FlowError>;
    readonly run: (id: FlowRunId) => Stream.Stream<FlowRunEvent, FlowError>;
    readonly snapshot: (id: FlowRunId) => Effect.Effect<FlowRunSnapshot, FlowError>;
    readonly stepRunOutput: (id: FlowStepRunId) => Effect.Effect<FlowStepOutput | null, FlowError>;
    readonly runForThread: (
      id: ThreadId,
    ) => Effect.Effect<typeof FlowRunForThreadResult.Type, FlowError>;
    readonly catchUp: () => Effect.Effect<void, FlowError>;
    readonly recover: () => Effect.Effect<void, FlowError>;
  }
>()("t3/flows/FlowService") {}
const fail = (message: string) => new FlowError({ message });
const mapError = (cause: { readonly message: string }) => fail(cause.message);
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
function stepDefinition(state: State, step: StepRun) {
  let steps = state.definition.steps;
  for (const id of step.stepPath) {
    const value = steps.find((candidate) => candidate.id === id);
    if (!value) throw new Error("Missing step definition");
    if (id === step.stepPath.at(-1)) return value;
    if (value.kind === "loop" || value.kind === "map") steps = value.steps;
  }
  throw new Error("Missing step path");
}
function reportInstruction(state: State, step: StepRun) {
  const definition = stepDefinition(state, step);
  return definition.kind === "agent" && definition.outputs?.length
    ? `\n\nBefore finishing, call t3_flow_report with fields matching: ${JSON.stringify(definition.outputs)}.`
    : "";
}
function snapshotOf(state: State): FlowRunSnapshot {
  return {
    definition: state.definition,
    inputs: state.inputs,
    summary: state.run,
    approvals: state.approvals,
    stepRuns: state.stepRuns.map((step) => {
      const { output, scope: _scope, ...rest } = step;
      let outputFields: FlowRunSnapshot["stepRuns"][number]["outputFields"] = null;
      if (output)
        switch (output.kind) {
          case "agent": {
            const { text: _text, kind: _kind, ...fields } = output;
            outputFields = { kind: "agent", fields };
            break;
          }
          case "command":
            outputFields = {
              kind: "command",
              exitCode: output.exitCode,
              timedOut: output.timedOut,
              lineCount: output.lineCount,
            };
            break;
          case "approval":
            outputFields = output;
            break;
          case "loop":
            outputFields = {
              kind: "loop",
              iterations: output.iterations,
              exitReason: output.exitReason,
            };
            break;
          case "map":
            outputFields = { kind: "map", items: output.items.map(({ status }) => ({ status })) };
            break;
        }
      return { ...rest, outputFields };
    }),
  };
}
const make = Effect.gen(function* () {
  const definitions = yield* Definitions.FlowDefinitions;
  const repository = yield* Repository.FlowRunRepository;
  const lock = yield* Lock.FlowRunLock;
  const commands = yield* Commands.FlowCommandRunner;
  const runtime = yield* Runtime.FlowRuntime;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Scope.Scope;
  const changes = yield* PubSub.bounded<{ projectId: ProjectId; event: FlowRunEvent }>(128);
  const filesGate = yield* Semaphore.make(1);
  const startGate = yield* Semaphore.make(1);
  const commandFibers = new Map<FlowStepRunId, Fiber.Fiber<unknown>>();
  let recoveryActions: Map<FlowRunId, Action[]> | undefined;
  const readState = Effect.fn("FlowService.readState")(function* (id: FlowRunId) {
    const state = yield* repository.read(id).pipe(Effect.mapError(mapError));
    if (!state) return yield* fail("Flow run not found.");
    return state;
  });
  const publish = Effect.fn("FlowService.publish")(function* (state: State, before?: State) {
    const snapshot = snapshotOf(state);
    const previous = before && snapshotOf(before);
    const oldSteps = new Map(previous?.stepRuns.map((step) => [step.id, step]));
    const oldApprovals = new Map(
      previous?.approvals.map((approval) => [approval.stepRunId, approval]),
    );
    const stepRuns = snapshot.stepRuns.filter(
      (step) => JSON.stringify(step) !== JSON.stringify(oldSteps.get(step.id)),
    );
    const approvals = snapshot.approvals.filter(
      (approval) =>
        JSON.stringify(approval) !== JSON.stringify(oldApprovals.get(approval.stepRunId)),
    );
    yield* PubSub.publish(changes, {
      projectId: state.run.projectId,
      event: { type: "upsert", summary: state.run, stepRuns, approvals },
    });
  });
  const drive = Effect.fn("FlowService.drive")(function* (
    id: FlowRunId,
    trigger: Trigger,
  ): Effect.fn.Return<FlowRunSummary, FlowError> {
    const state = yield* readState(id);
    const decision = decide(state, trigger);
    if (decision.rejected)
      return yield* fail(
        decision.rejected.errors?.map((error) => `${error.path}: ${error.message}`).join("; ") ??
          "Flow action is not applicable in its current state.",
      );
    if (!decision.transitions.length) return state.run;
    yield* repository
      .apply(id, state.version, decision.transitions)
      .pipe(Effect.mapError(mapError));
    let next = { ...applyTransitions(state, decision.transitions), version: state.version + 1 };
    yield* publish(next, state);
    if (recoveryActions) {
      recoveryActions.set(id, [...(recoveryActions.get(id) ?? []), ...decision.actions]);
      return next.run;
    }
    return yield* executeActions(next, decision.actions);
  });
  const executeActions = Effect.fn("FlowService.executeActions")(function* (
    state: State,
    actions: ReadonlyArray<Action>,
  ): Effect.fn.Return<FlowRunSummary, FlowError> {
    const id = state.run.id;
    let next = state;
    for (const action of actions) {
      if (
        "stepRunId" in action &&
        ["launch_step_thread", "continue_thread", "start_command", "send_reminder"].includes(
          action.type,
        )
      ) {
        const step = next.stepRuns.find((step) => step.id === action.stepRunId);
        if (!step || step.superseded || !["running", "waiting_report"].includes(step.status))
          continue;
      }
      const execute = Effect.gen(function* () {
        switch (action.type) {
          case "launch_step_thread":
          case "continue_thread":
          case "send_reminder": {
            const step = next.stepRuns.find((step) => step.id === action.stepRunId)!;
            if (!action.threadId) return;
            const input = {
              projectId: next.run.projectId,
              threadId: action.threadId,
              commandId: `flow:${action.stepRunId}:${action.messageId}`,
              messageId: action.messageId,
              title: `${next.definition.title} · ${step.stepPath.at(-1)}`,
              parentThreadId: next.run.flowRunThreadId,
              workspace:
                next.definition.workspace === "root"
                  ? { type: "root" as const }
                  : { type: "existing_worktree" as const, worktreePath: next.workspace },
              prompt:
                (action.type === "send_reminder"
                  ? "Report the declared output fields for this step."
                  : action.prompt) + reportInstruction(next, step),
              ...(action.type === "send_reminder"
                ? {}
                : {
                    model: action.model,
                    runtimeMode: action.runtimeMode,
                    interactionMode: action.interactionMode,
                  }),
            };
            if (action.type === "launch_step_thread") yield* runtime.launch(input);
            else yield* runtime.send(input);
            break;
          }
          case "start_command": {
            const work = commands.run({ ...action, workspace: next.workspace }).pipe(
              Effect.matchEffect({
                onSuccess: (output) =>
                  triggerRun(id, {
                    type: "command_finished",
                    stepRunId: action.stepRunId,
                    output,
                    at: "",
                  }),
                onFailure: () =>
                  triggerRun(id, {
                    type: "command_finished",
                    stepRunId: action.stepRunId,
                    error: { code: "command_error", message: "Flow command failed." },
                    at: "",
                  }),
              }),
              Effect.catch((error) =>
                Effect.logWarning("Flow command result rejected", { cause: error }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  commandFibers.delete(action.stepRunId);
                }),
              ),
            );
            commandFibers.set(action.stepRunId, yield* work.pipe(Effect.forkIn(scope)));
            break;
          }
          case "kill_command": {
            const fiber = commandFibers.get(action.stepRunId);
            if (fiber) yield* Fiber.interrupt(fiber);
            break;
          }
          case "interrupt_turn":
            if (action.threadId)
              yield* runtime.interrupt(
                next.run.projectId,
                action.threadId,
                `flow-stop:${action.stepRunId}:${next.version}`,
              );
            break;
          case "update_flow_run_thread":
          case "finish":
            yield* runtime.attention(next.run);
            break;
        }
      });
      const result = yield* execute.pipe(Effect.result);
      if (
        result._tag === "Failure" &&
        "stepRunId" in action &&
        action.type !== "interrupt_turn" &&
        action.type !== "kill_command"
      ) {
        yield* drive(id, {
          type: "action_failed",
          stepRunId: action.stepRunId,
          error: { code: "command_error", message: "Could not execute flow step action." },
          at: yield* now,
        });
        next = yield* readState(id);
      } else if (result._tag === "Failure") return yield* result.failure;
    }
    return next.run;
  });
  const triggerRun = Effect.fn("FlowService.trigger")(function* (
    id: FlowRunId,
    trigger: Trigger,
  ): Effect.fn.Return<FlowRunSummary, FlowError> {
    return yield* lock.withRunLock(id, drive(id, { ...trigger, at: trigger.at || (yield* now) }));
  });
  const stepRun = Effect.fn("FlowService.stepRun")(function* (id: FlowStepRunId) {
    const owner = yield* repository.runForStep(id).pipe(Effect.mapError(mapError));
    if (!owner) return yield* fail("Step run not found.");
    return owner;
  });
  const settleThread = Effect.fn("FlowService.settleThread")(function* (threadId: ThreadId) {
    const link = yield* repository.runForThread(threadId).pipe(Effect.mapError(mapError));
    if (!link || link.role !== "step_thread") return;
    const state = yield* readState(link.flowRunId);
    for (const step of state.stepRuns) {
      if (
        step.threadId !== threadId ||
        !step.expectedMessageId ||
        step.superseded ||
        !["running", "waiting_report"].includes(step.status)
      )
        continue;
      const settled = yield* runtime.settled(threadId, step.expectedMessageId);
      if (settled && settled.turnId !== step.lastSettledTurnId)
        yield* triggerRun(link.flowRunId, {
          type: "step_thread_settled",
          stepRunId: step.id,
          ...settled,
          ...(settled.failed
            ? { error: { code: "turn_failed" as const, message: "Step thread did not complete." } }
            : {}),
          at: "",
        });
    }
  });
  const catchUp = Effect.fn("FlowService.catchUp")(function* () {
    for (const id of yield* repository.active().pipe(Effect.mapError(mapError))) {
      const state = yield* readState(id);
      for (const threadId of new Set(
        state.stepRuns.flatMap((step) => (step.threadId ? [step.threadId] : [])),
      ))
        yield* settleThread(threadId);
    }
  });
  const read = Effect.fn("FlowService.read")(function* (projectId: ProjectId, flowId: FlowId) {
    return yield* definitions
      .read(yield* runtime.root(projectId), flowId)
      .pipe(Effect.mapError(mapError));
  });
  let observing = false;
  const observe = Effect.fn("FlowService.observe")(function* () {
    if (observing) return;
    observing = true;
    yield* runtime.events.pipe(
      Stream.runForEach((id) =>
        settleThread(id).pipe(
          Effect.catch((error) => Effect.logWarning("Flow settlement failed", { cause: error })),
        ),
      ),
      Effect.forkIn(scope),
    );
  });
  return FlowService.of({
    read,
    validate: Effect.fn("FlowService.validate")((definition) => definitions.validate(definition)),
    list: Effect.fn("FlowService.list")(function* (projectId) {
      return yield* definitions
        .list(yield* runtime.root(projectId))
        .pipe(Effect.mapError(mapError));
    }),
    watch: (projectId, connection) =>
      Stream.unwrap(
        runtime.root(projectId).pipe(
          Effect.map((root) =>
            definitions.stream(root, connection).pipe(
              Stream.map((flows) => ({ flows })),
              Stream.mapError(mapError),
            ),
          ),
        ),
      ),
    save: Effect.fn("FlowService.save")((input) =>
      filesGate.withPermits(1)(
        Effect.gen(function* () {
          const root = yield* runtime.root(input.projectId);
          const existing = yield* definitions.read(root, input.flowId).pipe(
            Effect.catchTags({
              FlowDefinitionError: (error) =>
                error.reason === "missing" ? Effect.succeed(null) : Effect.fail(mapError(error)),
            }),
          );
          if ((existing?.revision ?? null) !== input.baseRevision)
            return yield* new FlowRevisionConflict({
              code: "revision_conflict",
              message: "The flow file changed. Reload before saving.",
              currentRevision: existing?.revision ?? null,
            });
          return yield* definitions
            .write(root, input.flowId, input.definition)
            .pipe(Effect.mapError(mapError));
        }),
      ),
    ),
    rename: Effect.fn("FlowService.rename")((projectId, flowId, newFlowId) =>
      filesGate.withPermits(1)(
        Effect.gen(function* () {
          const root = yield* runtime.root(projectId);
          const entry = yield* definitions
            .rename(root, flowId, newFlowId)
            .pipe(Effect.mapError(mapError));
          yield* sql`UPDATE scheduled_tasks SET flow_json = json_set(flow_json, '$.flowId', ${newFlowId}) WHERE project_id = ${projectId} AND json_extract(flow_json, '$.flowId') = ${flowId}`.pipe(
            Effect.mapError(() => fail("Could not rename scheduled flow targets.")),
            Effect.onError(() => definitions.rename(root, newFlowId, flowId).pipe(Effect.ignore)),
          );
          return entry;
        }),
      ),
    ),
    delete: Effect.fn("FlowService.delete")(function* (projectId, flowId) {
      yield* definitions
        .delete(yield* runtime.root(projectId), flowId)
        .pipe(Effect.mapError(mapError));
    }),
    start: Effect.fn("FlowService.start")((input) =>
      startGate.withPermits(1)(
        Effect.gen(function* () {
          if (input.scheduledTaskId) {
            const active =
              yield* sql`SELECT id FROM flow_runs WHERE scheduled_task_id = ${input.scheduledTaskId} AND status IN ('starting', 'running', 'waiting_approval') LIMIT 1`.pipe(
                Effect.mapError(() => fail("Could not check previous flow run.")),
              );
            if (active.length) return yield* fail("skipped: previous flow run still active");
          }
          const entry = yield* read(input.projectId, input.flowId);
          if (!entry.definition || !entry.validation.valid)
            return yield* fail(
              entry.validation.errors.map((error) => `${error.path}: ${error.message}`).join("; "),
            );
          const definition = entry.definition;
          const inputs = yield* Effect.try({
            try: () =>
              input.coerce
                ? coerceFlowInputs(definition.inputs ?? [], input.inputs as Record<string, string>)
                : resolveFlowInputs(definition.inputs ?? [], input.inputs),
            catch: (cause) =>
              fail(cause instanceof FlowValueError ? cause.message : "Invalid flow inputs."),
          });
          const id = FlowRunId.make(
            yield* crypto
              .randomUUIDv4()
              .pipe(Effect.mapError(() => fail("Could not allocate flow run id."))),
          );
          const threadId = ThreadId.make(`flow:${id}`);
          const at = yield* now;
          const root = yield* runtime.root(input.projectId);
          let state: State = {
            version: 0,
            definition,
            inputs,
            workspace: root,
            baseRef: input.baseRef ?? null,
            stepRuns: [],
            approvals: [],
            run: {
              id,
              projectId: input.projectId,
              flowId: input.flowId,
              flowTitle: definition.title,
              runNumber: 1,
              flowRunThreadId: threadId,
              status: "starting",
              activeStepRunIds: [],
              error: null,
              createdAt: at,
              startedAt: null,
              finishedAt: null,
              ...(input.scheduledTaskId ? { scheduledTaskId: input.scheduledTaskId } : {}),
            },
          };
          state = {
            ...state,
            run: yield* repository.create(state).pipe(Effect.mapError(mapError)),
          };
          const workspace = yield* runtime
            .launch({
              projectId: input.projectId,
              threadId,
              commandId: `flow:${id}`,
              title: `▶ ${definition.title} · run ${state.run.runNumber}`,
              workspace:
                definition.workspace === "root"
                  ? { type: "root" }
                  : {
                      type: "worktree",
                      baseRef: input.baseRef ?? "HEAD",
                      branch: `flow/${input.flowId}/${id.slice(0, 8)}`,
                      startFromOrigin: false,
                    },
              model: definition.defaults?.model,
              runtimeMode: definition.defaults?.runtimeMode,
              interactionMode: definition.defaults?.interactionMode,
            })
            .pipe(
              Effect.onError(() =>
                repository
                  .apply(id, 0, [
                    {
                      type: "run",
                      run: {
                        ...state.run,
                        status: "failed",
                        finishedAt: at,
                        error: {
                          code: "command_error",
                          message: "Flow workspace preparation failed.",
                        },
                      },
                    },
                  ])
                  .pipe(Effect.ignore),
              ),
            );
          yield* sql`UPDATE flow_runs SET workspace = ${workspace} WHERE id = ${id}`.pipe(
            Effect.mapError(() => fail("Could not persist flow workspace.")),
          );
          return yield* triggerRun(id, { type: "start", at });
        }),
      ),
    ),
    trigger: triggerRun,
    stop: Effect.fn("FlowService.stop")((id) => triggerRun(id, { type: "stop", at: "" })),
    resume: Effect.fn("FlowService.resume")((id) => triggerRun(id, { type: "resume", at: "" })),
    retryStep: Effect.fn("FlowService.retryStep")(function* (id) {
      return yield* triggerRun(yield* stepRun(id), { type: "retry_step", stepRunId: id, at: "" });
    }),
    answerApproval: Effect.fn("FlowService.answerApproval")(function* (input, answeredBy) {
      return yield* triggerRun(yield* stepRun(input.stepRunId), {
        type: "approval_answered",
        stepRunId: input.stepRunId,
        decision: input.decision,
        ...(input.comment === undefined ? {} : { comment: input.comment }),
        answeredBy,
        at: "",
      });
    }),
    report: Effect.fn("FlowService.report")(function* (threadId, fields) {
      const link = yield* repository.runForThread(threadId).pipe(Effect.mapError(mapError));
      if (!link || link.role !== "step_thread")
        return yield* fail("t3_flow_report requires a running flow step thread.");
      return yield* lock.withRunLock(
        link.flowRunId,
        Effect.gen(function* () {
          const state = yield* readState(link.flowRunId);
          const steps = state.stepRuns.filter(
            (step) =>
              step.threadId === threadId &&
              !step.superseded &&
              ["running", "waiting_report"].includes(step.status),
          );
          if (steps.length !== 1)
            return yield* fail("No single step run is waiting on this thread.");
          const trigger = {
            type: "report_received" as const,
            stepRunId: steps[0]!.id,
            fields,
            at: yield* now,
          };
          const decision = decide(state, trigger);
          if (decision.rejected)
            return {
              valid: false,
              errors: decision.rejected.errors ?? [
                { path: "$.fields", message: "Step is not accepting reports." },
              ],
            };
          yield* drive(link.flowRunId, trigger);
          return { valid: true, errors: [] };
        }),
      );
    }),
    runsPage: Effect.fn("FlowService.runsPage")((projectId, before) =>
      repository.list(projectId, before).pipe(Effect.mapError(mapError)),
    ),
    runs: (projectId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const page = yield* repository.list(projectId).pipe(Effect.mapError(mapError));
          return Stream.concat(
            Stream.make({ type: "snapshot", ...page } satisfies FlowRunsEvent),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((change) => change.projectId === projectId),
              Stream.map((change): FlowRunsEvent => ({
                type: "upsert",
                runs:
                  change.event.type === "upsert" && change.event.summary
                    ? [change.event.summary]
                    : [],
              })),
            ),
          );
        }),
      ),
    run: (id) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = snapshotOf(yield* readState(id));
          return Stream.concat(
            Stream.make({ type: "snapshot", ...snapshot } satisfies FlowRunEvent),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter(
                (change) => change.event.type === "upsert" && change.event.summary?.id === id,
              ),
              Stream.map((change) => change.event),
            ),
          );
        }),
      ),
    snapshot: Effect.fn("FlowService.snapshot")((id) => readState(id).pipe(Effect.map(snapshotOf))),
    stepRunOutput: Effect.fn("FlowService.stepRunOutput")((id) =>
      repository.stepOutput(id).pipe(Effect.mapError(mapError)),
    ),
    runForThread: Effect.fn("FlowService.runForThread")((id) =>
      repository.runForThread(id).pipe(Effect.mapError(mapError)),
    ),
    catchUp,
    recover: Effect.fn("FlowService.recover")(function* () {
      yield* sweepOrphanedFlowRuns().pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(() => fail("Could not sweep orphaned flow runs.")),
      );
      const originals = new Map<FlowRunId, State>();
      for (const id of yield* repository.active().pipe(Effect.mapError(mapError)))
        originals.set(id, yield* readState(id));
      recoveryActions = new Map();
      yield* Effect.gen(function* () {
        yield* catchUp();
        for (const [id, original] of originals) {
          const state = yield* readState(id);
          if (!["starting", "running", "waiting_approval"].includes(state.run.status)) continue;
          const continuingThreadIds: ThreadId[] = [];
          const continuingMessageIds: Record<string, string> = {};
          for (const step of state.stepRuns)
            if (step.threadId && ["running", "waiting_report"].includes(step.status)) {
              const messageId = yield* runtime.continuing(
                step.threadId,
                step.expectedMessageId ?? "",
              );
              if (messageId) {
                continuingThreadIds.push(step.threadId);
                continuingMessageIds[step.threadId] = messageId;
              }
            }
          yield* triggerRun(id, {
            type: "recovered",
            interruptedStepRunIds: original.stepRuns
              .filter((step) => ["running", "waiting_report"].includes(step.status))
              .map((step) => step.id),
            continuingThreadIds,
            continuingMessageIds,
            at: "",
          });
          for (const threadId of continuingThreadIds) yield* settleThread(threadId);
        }
        const pending = recoveryActions!;
        recoveryActions = undefined;
        for (const [id, actions] of pending)
          yield* lock.withRunLock(
            id,
            Effect.gen(function* () {
              yield* executeActions(yield* readState(id), actions);
            }),
          );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            recoveryActions = undefined;
          }),
        ),
      );
      yield* observe();
    }),
  });
});
export const layer = Layer.effect(FlowService, make);
