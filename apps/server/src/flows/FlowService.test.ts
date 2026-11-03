import { McpServer, McpSchema } from "effect/ai";
import * as Schema from "effect/Schema";
import { EnvironmentId, ProviderInstanceId, FlowError } from "@t3tools/contracts";
import * as FlowMcp from "./FlowMcp.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  FlowId,
  FlowRunId,
  FlowStepRunId,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  type FlowDefinition,
} from "@t3tools/contracts";
import { flowDefinitionRevision, validateFlowDefinition } from "@t3tools/shared/flow";
import * as Deferred from "effect/Deferred";
import * as PubSub from "effect/PubSub";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import FlowMigration from "../persistence/ForkMigrations/013_FlowRuns.ts";
import * as Definitions from "./FlowDefinitions.ts";
import * as Repository from "./FlowRunRepository.ts";
import * as Runtime from "./FlowRuntime.ts";
import * as Commands from "./FlowCommandRunner.ts";
import * as Lock from "./FlowRunLock.ts";
import * as Service from "./FlowService.ts";
import { initialState } from "./FlowEngine.test-support.ts";
import { applyTransitions, decide } from "./FlowEngine.ts";

const decodeMcp = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const reportMcp = Effect.fn("test.reportMcp")(function* (
  service: Service.FlowService["Service"],
  threadId: ThreadId,
  fields: Record<string, string>,
) {
  const context = yield* Layer.build(
    McpHttpServer.toolkitRegistration(FlowMcp.FlowToolkit, FlowMcp.layer).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(Layer.succeed(Service.FlowService, service)),
      Layer.provide(
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
        }),
      ),
    ),
  );
  const result = yield* Context.get(context, McpServer.McpServer)
    .callTool({ name: "t3_flow_report", arguments: { fields } })
    .pipe(
      Effect.provideService(Invocation.McpInvocationContext, {
        environmentId: EnvironmentId.make("env"),
        requestNamespace: "test",
        thread: {
          threadId,
          providerSessionId: "provider",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"] as const),
        issuedAt: 0,
      }),
      Effect.provideService(McpSchema.McpServerClient, {
        clientId: 1,
        protocolVersion: "2025-06-18",
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1" },
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
        getClient: Effect.die("unused"),
      }),
    );
  return decodeMcp(result.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
});

const setup = Effect.fn("test.setup")(function* (
  definition: FlowDefinition,
  preparation?: Effect.Effect<void, FlowError>,
  attentionFailure?: Effect.Effect<void>,
  stepFailure?: Effect.Effect<void, FlowError>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, deleted_at TEXT)`;
  yield* sql`CREATE TABLE scheduled_tasks(task_id TEXT PRIMARY KEY, project_id TEXT, flow_json TEXT)`;
  yield* FlowMigration;
  const events = yield* Queue.unbounded<ThreadId>();
  const launches: Runtime.FlowThreadInput[] = [];
  const launched = yield* Queue.unbounded<Runtime.FlowThreadInput>();
  const messages: Runtime.FlowThreadInput[] = [];
  const continuing = new Map<ThreadId, string>();
  const settled = new Map<
    string,
    { messageId: string; turnId: string; text: string; failed: boolean }
  >();
  const commands: Parameters<Commands.FlowCommandRunner["Service"]["run"]>[0][] = [];
  const attention: string[] = [];
  let saved = definition;
  const entry = () => ({
    flowId: FlowId.make("example"),
    definition: saved,
    revision: flowDefinitionRevision(saved),
    validation: validateFlowDefinition(saved),
  });
  const runtime = Runtime.FlowRuntime.of({
    belongsToRun: (id, runId) =>
      repository.runForThread(id).pipe(
        Effect.map((link) => link?.flowRunId === runId),
        Effect.orDie,
      ),
    root: () => Effect.succeed("/workspace"),
    launch: Effect.fn("test.launch")(function* (input) {
      if (!input.parentThreadId && preparation) yield* preparation;
      if (input.parentThreadId && stepFailure) yield* stepFailure;
      launches.push(input);
      yield* Queue.offer(launched, input);
      yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads VALUES (${input.threadId}, NULL)`.pipe(
        Effect.orDie,
      );
      return input.workspace.type === "worktree" ? "/workspace/worktree" : "/workspace";
    }),
    send: (input) =>
      Effect.sync(() => {
        messages.push(input);
      }),
    interrupt: () => Effect.void,
    attention: (run) =>
      (attentionFailure ?? Effect.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            attention.push(run.status);
          }),
        ),
      ),
    continuing: (id) => Effect.succeed(continuing.get(id) ?? null),
    settled: (_id, messageId) => Effect.succeed(settled.get(messageId) ?? null),
    events: Stream.fromQueue(events),
  });
  const definitions = Definitions.FlowDefinitions.of({
    importImage: () => Effect.die("unused"),
    readImage: () => Effect.die("unused"),
    read: () => Effect.succeed(entry()),
    list: () => Effect.succeed([entry()]),
    validate: (value) => Effect.succeed(validateFlowDefinition(value)),
    write: (_root, _id, value) =>
      Effect.sync(() => {
        saved = value;
        return entry();
      }),
    rename: () => Effect.succeed(entry()),
    delete: () => Effect.void,
    stream: () => Stream.make([entry()]),
  });
  const reads: FlowRunId[] = [];
  const services = Layer.mergeAll(
    Layer.succeed(Runtime.FlowRuntime, runtime),
    Layer.succeed(Definitions.FlowDefinitions, definitions),
    Layer.succeed(Commands.FlowCommandRunner, {
      run: (input) =>
        Effect.sync(() => {
          commands.push(input);
          return {
            kind: "command" as const,
            text: "command text",
            lines: ["command text"],
            exitCode: 0,
            timedOut: false,
            lineCount: 1,
          };
        }),
    }),
    Layer.effect(
      Repository.FlowRunRepository,
      Effect.gen(function* () {
        const repository = yield* Repository.FlowRunRepository;
        return {
          ...repository,
          read: (id: FlowRunId) => {
            reads.push(id);
            return repository.read(id);
          },
        };
      }),
    ).pipe(Layer.provide(Repository.layer)),
    Lock.layer,
    NodeCrypto.layer,
  );
  const context = yield* Layer.build(Service.layer.pipe(Layer.provideMerge(services)));
  const service = Context.get(context, Service.FlowService);
  const repository = Context.get(context, Repository.FlowRunRepository);
  const finish = Effect.fn("test.finish")(function* (
    input: Runtime.FlowThreadInput,
    text = "assistant text",
  ) {
    const messageId = input.messageId!;
    settled.set(messageId, { messageId, turnId: `turn:${messageId}`, text, failed: false });
    yield* Queue.offer(events, input.threadId);
  });
  return {
    service,
    launches,
    messages,
    continuing,
    commands,
    attention,
    finish,
    repository,
    launched,
    settled,
    reads,
  };
});
const database = NodeSqliteClient.layer({ filename: ":memory:" });
const awaitStatus = (service: Service.FlowService["Service"], id: FlowRunId, status: string) =>
  service.run(id).pipe(
    Stream.filter(
      (event) => (event.type === "snapshot" ? event.summary : event.summary)?.status === status,
    ),
    Stream.runHead,
  );

it.effect(
  "drives agent, reported loop, command and map approvals; snapshots omit text and resolve thread roles",
  () =>
    Effect.gen(function* () {
      const { service, launches, finish, commands, attention, launched } = yield* setup({
        version: 1,
        title: "Review",
        workspace: "worktree",
        inputs: [
          { name: "issue", type: "string", required: true },
          { name: "items", type: "string[]", default: ["first"] },
        ],
        steps: [
          {
            id: "implement",
            kind: "agent",
            prompt: "Fix {{inputs.issue}}",
            images: ["docs/mockup.png"],
          },
          {
            id: "review-loop",
            kind: "loop",
            maxIterations: 3,
            until: { ref: "steps.review.output.verdict", op: "eq", value: "approve" },
            steps: [
              {
                id: "review",
                kind: "agent",
                prompt: "Review",
                outputs: [{ name: "verdict", type: "enum", values: ["approve", "revise"] }],
              },
            ],
            edges: [],
          },
          {
            id: "command",
            kind: "command",
            command: "echo done",
            env: { ISSUE: "{{inputs.issue}}" },
          },
          {
            id: "map",
            kind: "map",
            over: "inputs.items",
            steps: [{ id: "gate", kind: "approval", prompt: "Ship {{item}}?" }],
            edges: [],
          },
        ],
        edges: [
          { from: "implement", to: "review-loop" },
          { from: "review-loop", to: "command" },
          { from: "command", to: "map" },
        ],
      });
      yield* service.recover();
      const run = yield* service.start({
        projectId: ProjectId.make("project"),
        flowId: FlowId.make("example"),
        inputs: { issue: "123" },
        baseRef: "main",
      });
      yield* Queue.take(launched);
      yield* Queue.take(launched);
      expect(launches[0]?.title).toBe("▶ Review · run 1");
      expect(launches[0]?.workspace).toEqual({
        type: "worktree",
        baseRef: "main",
        branch: `flow/example/${run.id.slice(0, 8)}`,
        startFromOrigin: false,
      });
      expect(launches[1]?.images).toEqual(["docs/mockup.png"]);
      expect(launches[1]?.parentThreadId).toBe(run.flowRunThreadId);
      expect(launches[1]?.workspace).toEqual({
        type: "existing_worktree",
        worktreePath: "/workspace/worktree",
      });
      expect(yield* service.runForThread(run.flowRunThreadId)).toEqual({
        flowRunId: run.id,
        role: "flow_run_thread",
      });
      expect((yield* service.runForThread(launches[1]!.threadId))?.role).toBe("step_thread");
      expect(yield* reportMcp(service, run.flowRunThreadId, {})).toMatchObject({
        code: "invalid_request",
      });
      yield* finish(launches[1]!);
      yield* service.run(run.id).pipe(
        Stream.filter((event) =>
          event.stepRuns.some(
            (step) => step.stepPath.at(-1) === "review" && step.status === "running",
          ),
        ),
        Stream.runHead,
      );
      const review = yield* Queue.take(launched);
      expect(review.prompt).toContain("t3_flow_report");
      expect(yield* reportMcp(service, review.threadId, { verdict: "invalid" })).toMatchObject({
        valid: false,
      });
      expect(yield* reportMcp(service, review.threadId, { verdict: "approve" })).toMatchObject({
        valid: true,
      });
      yield* finish(review);
      yield* awaitStatus(service, run.id, "waiting_approval");
      expect(commands[0]?.env).toEqual({ ISSUE: "123" });
      const snapshot = yield* service.snapshot(run.id);
      expect(snapshot.baseRef).toBe("main");
      const map = snapshot.stepRuns.find((step) => step.stepPath[0] === "map")!;
      expect(map.itemCount).toBe(1);
      expect(map).not.toHaveProperty("items");
      expect(snapshot.stepRuns.find((step) => step.stepPath[0] === "implement")).not.toHaveProperty(
        "itemCount",
      );
      expect(JSON.stringify(snapshot)).not.toContain("assistant text");
      const implement = snapshot.stepRuns.find((step) => step.stepPath[0] === "implement")!;
      expect((yield* service.stepRunOutput(implement.id))?.kind).toBe("agent");
      expect(yield* service.runForThread(ThreadId.make("ordinary"))).toBeNull();
      const result = yield* service.answerApproval(
        { stepRunId: snapshot.approvals[0]!.stepRunId, decision: "approve" },
        "tester",
      );
      expect(result.status).toBe("succeeded");
      expect(
        (yield* service.snapshot(run.id)).stepRuns.find((step) => step.id === map.id),
      ).toMatchObject({ itemCount: 1, status: "succeeded" });
      expect(attention).toContain("waiting_approval");
      expect(attention).toContain("succeeded");
    }).pipe(Effect.scoped, Effect.provide(database)),
);

it.effect("rejects stale saves and typed inputs; scheduled starts coerce and skip overlap", () =>
  Effect.gen(function* () {
    const definition: FlowDefinition = {
      version: 1,
      title: "Gate",
      workspace: "root",
      inputs: [{ name: "count", type: "number", required: true }],
      steps: [{ id: "gate", kind: "approval", prompt: "Continue?" }],
      edges: [],
    };
    const { service } = yield* setup(definition);
    expect(
      (yield* service
        .save({
          projectId: ProjectId.make("p"),
          flowId: FlowId.make("example"),
          definition,
          baseRevision: null,
        })
        .pipe(Effect.exit))._tag,
    ).toBe("Failure");
    yield* service.save({
      projectId: ProjectId.make("p"),
      flowId: FlowId.make("example"),
      definition,
      baseRevision: flowDefinitionRevision(definition),
    });
    const input = {
      projectId: ProjectId.make("p"),
      flowId: FlowId.make("example"),
      inputs: { count: "3" },
      scheduledTaskId: ScheduledTaskId.make("schedule"),
    };
    expect((yield* service.start(input).pipe(Effect.exit))._tag).toBe("Failure");
    const run = yield* service.start({ ...input, coerce: true });
    expect((yield* service.snapshot(run.id)).inputs).toEqual({ count: 3 });
    expect((yield* service.snapshot(run.id)).baseRef).toBeNull();
    expect((yield* service.start({ ...input, coerce: true }).pipe(Effect.exit))._tag).toBe(
      "Failure",
    );
    yield* service.stop(run.id);
    expect((yield* service.start({ ...input, coerce: true })).runNumber).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(database)),
);

it.effect(
  "recovers terminal turns before deciding interruptions and retains auto-continuing agents and approvals",
  () =>
    Effect.gen(function* () {
      const definition: FlowDefinition = {
        version: 1,
        title: "Recover",
        steps: [
          { id: "agent", kind: "agent", prompt: "Work" },
          { id: "gate", kind: "approval", prompt: "Wait" },
        ],
        edges: [],
      };
      const { service, repository, continuing, launches, finish } = yield* setup(definition);
      const run = yield* service.start({
        projectId: ProjectId.make("p"),
        flowId: FlowId.make("example"),
        inputs: {},
      });
      yield* awaitStatus(service, run.id, "waiting_approval");
      continuing.set(launches[1]!.threadId, "continued-message");
      expect((yield* service.snapshot(run.id)).baseRef).toBe("HEAD");
      yield* service.recover();
      const state = yield* repository.read(run.id);
      expect(state?.stepRuns.find((step) => step.stepPath[0] === "agent")?.expectedMessageId).toBe(
        "continued-message",
      );
      expect(state?.stepRuns.find((step) => step.stepPath[0] === "gate")?.status).toBe(
        "waiting_approval",
      );
      yield* finish({ ...launches[1]!, messageId: "continued-message" });
      yield* service.run(run.id).pipe(
        Stream.filter((event) =>
          event.stepRuns.some(
            (step) => step.stepPath[0] === "agent" && step.status === "succeeded",
          ),
        ),
        Stream.runHead,
      );
      const commandDefinition: FlowDefinition = {
        version: 1,
        title: "Command",
        steps: [{ id: "cmd", kind: "command", command: "echo ok" }],
        edges: [],
      };
      const initial = initialState(commandDefinition);
      const active = applyTransitions(
        initial,
        decide(initial, { type: "start", at: initial.run.createdAt }).transitions,
      );
      yield* repository.create({
        ...active,
        run: {
          ...active.run,
          id: FlowRunId.make("interrupted-command"),
          flowRunThreadId: ThreadId.make("cmd-parent"),
        },
        stepRuns: active.stepRuns.map((step) => ({
          ...step,
          id: FlowStepRunId.make("cmd-step"),
          flowRunId: FlowRunId.make("interrupted-command"),
        })),
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('cmd-parent', NULL)`;
      yield* service.recover();
      expect((yield* repository.read(FlowRunId.make("interrupted-command")))?.run.status).toBe(
        "failed",
      );
    }).pipe(Effect.scoped, Effect.provide(database)),
);

it.effect(
  "restart catches a persisted terminal turn and starts its newly reached command once",
  () =>
    Effect.gen(function* () {
      const { service, launches, settled, commands } = yield* setup({
        version: 1,
        title: "Catch up",
        workspace: "root",
        steps: [
          { id: "agent", kind: "agent", prompt: "Work" },
          { id: "command", kind: "command", command: "echo done" },
          { id: "gate", kind: "approval", prompt: "Continue?" },
        ],
        edges: [
          { from: "agent", to: "command" },
          { from: "command", to: "gate" },
        ],
      });
      const run = yield* service.start({
        projectId: ProjectId.make("p"),
        flowId: FlowId.make("example"),
        inputs: {},
      });
      yield* awaitStatus(service, run.id, "running");
      const messageId = launches[1]!.messageId!;
      expect((yield* service.snapshot(run.id)).baseRef).toBeNull();
      settled.set(messageId, { messageId, turnId: "persisted-turn", text: "done", failed: false });
      yield* service.recover();
      yield* awaitStatus(service, run.id, "waiting_approval");
      expect(commands).toHaveLength(1);
      yield* service.recover();
      expect(commands).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(database)),
);

it.effect(
  "returns starting runs across projects while preparation waits and recovers them without launching",
  () =>
    Effect.gen(function* () {
      const prepare = yield* Deferred.make<void>();
      const { service, repository, launches } = yield* setup(
        {
          version: 1,
          title: "Prepare",
          workspace: "worktree",
          steps: [{ id: "agent", kind: "agent", prompt: "Work" }],
          edges: [],
        },
        Deferred.await(prepare),
      );
      const first = yield* service.start({
        projectId: ProjectId.make("one"),
        flowId: FlowId.make("example"),
        inputs: {},
      });
      const second = yield* service.start({
        projectId: ProjectId.make("two"),
        flowId: FlowId.make("example"),
        inputs: {},
      });
      expect(first.status).toBe("starting");
      expect(second.status).toBe("starting");
      expect((yield* repository.read(first.id))?.workspace).toBeNull();
      yield* service.recover();
      expect((yield* repository.read(first.id))?.run).toMatchObject({
        status: "failed",
        error: { code: "interrupted" },
      });
      expect((yield* repository.read(second.id))?.run.status).toBe("failed");
      expect(launches).toEqual([]);
      yield* Deferred.succeed(prepare, undefined);
    }).pipe(Effect.scoped, Effect.provide(database)),
);

it.effect("does not block transitions behind a stalled stream subscriber", () =>
  Effect.gen(function* () {
    const { service } = yield* setup({
      version: 1,
      title: "Gate",
      workspace: "root",
      steps: [{ id: "gate", kind: "approval", prompt: "Review" }],
      edges: [],
    });
    const run = yield* service.start({
      projectId: ProjectId.make("p"),
      flowId: FlowId.make("example"),
      inputs: {},
    });
    yield* awaitStatus(service, run.id, "waiting_approval");
    const stream = yield* service.run(run.id).pipe(Stream.toPubSub({ capacity: 1 }));
    yield* PubSub.subscribe(stream);
    for (let i = 0; i < 140; i++) {
      yield* service.stop(run.id);
      yield* service.resume(run.id);
    }
    expect((yield* service.snapshot(run.id)).summary.status).toBe("waiting_approval");
  }).pipe(Effect.scoped, Effect.provide(database)),
);

it.effect("isolates presentation defects after commit and malformed runs during recovery", () =>
  Effect.gen(function* () {
    const { service, repository } = yield* setup(
      {
        version: 1,
        title: "Gate",
        workspace: "root",
        steps: [{ id: "gate", kind: "approval", prompt: "Review" }],
        edges: [],
      },
      undefined,
      Effect.die("attention defect"),
    );
    const run = yield* service.start({
      projectId: ProjectId.make("p"),
      flowId: FlowId.make("example"),
      inputs: {},
    });
    yield* awaitStatus(service, run.id, "waiting_approval");
    expect((yield* service.stop(run.id)).status).toBe("cancelled");
    const next = yield* service.start({
      projectId: ProjectId.make("p"),
      flowId: FlowId.make("example"),
      inputs: {},
    });
    yield* awaitStatus(service, next.id, "waiting_approval");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE flow_runs SET status = 'running', summary_json = 'invalid' WHERE id = ${run.id}`;
    yield* service.recover();
    expect((yield* repository.read(next.id))?.run.status).toBe("waiting_approval");
  }).pipe(Effect.scoped, Effect.provide(database)),
);

it.effect("binds root flow steps to root instead of an existing worktree", () =>
  Effect.gen(function* () {
    const { service, launched } = yield* setup({
      version: 1,
      title: "Root",
      workspace: "root",
      steps: [{ id: "a", kind: "agent", prompt: "Work" }],
      edges: [],
    });
    yield* service.start({
      projectId: ProjectId.make("p"),
      flowId: FlowId.make("example"),
      inputs: {},
    });
    yield* Queue.take(launched);
    expect((yield* Queue.take(launched)).workspace).toEqual({ type: "root" });
  }).pipe(Effect.scoped, Effect.provide(database)),
);
it.effect("records preparation failure separately from restart interruption", () =>
  Effect.gen(function* () {
    const { service } = yield* setup(
      { version: 1, title: "Prepare", steps: [], edges: [] },
      Effect.fail(new FlowError({ message: "No enabled provider instance." })),
    );
    const run = yield* service.start({
      projectId: ProjectId.make("p"),
      flowId: FlowId.make("example"),
      inputs: {},
    });
    yield* awaitStatus(service, run.id, "failed");
    expect((yield* service.snapshot(run.id)).summary.error).toMatchObject({
      code: "command_error",
      message: "No enabled provider instance.",
    });
  }).pipe(Effect.scoped, Effect.provide(database)),
);

it.effect("shares a transition read across run subscribers", () =>
  Effect.gen(function* () {
    const { service, reads } = yield* setup({
      version: 1,
      title: "Gate",
      workspace: "root",
      steps: [{ id: "gate", kind: "approval", prompt: "Review" }],
      edges: [],
    });
    const run = yield* service.start({
      projectId: ProjectId.make("p"),
      flowId: FlowId.make("example"),
      inputs: {},
    });
    yield* awaitStatus(service, run.id, "waiting_approval");
    const events = yield* Queue.unbounded<void>();
    for (let i = 0; i < 2; i++) {
      yield* service.run(run.id).pipe(
        Stream.runForEach(() => Queue.offer(events, undefined)),
        Effect.forkChild,
      );
      yield* Queue.take(events);
    }
    const before = reads.length;
    yield* service.stop(run.id);
    yield* Queue.take(events);
    yield* Queue.take(events);
    expect(reads.length - before).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(database)),
);

it.effect("keeps the image path in a failed step's error", () =>
  Effect.gen(function* () {
    const { service } = yield* setup(
      {
        version: 1,
        title: "Images",
        steps: [{ id: "a", kind: "agent", prompt: "Review", images: ["missing.png"] }],
        edges: [],
      },
      undefined,
      undefined,
      Effect.fail(new FlowError({ message: 'Flow file read image "missing.png": missing.' })),
    );
    const run = yield* service.start({
      projectId: ProjectId.make("p"),
      flowId: FlowId.make("example"),
      inputs: {},
    });
    yield* awaitStatus(service, run.id, "failed");
    expect((yield* service.snapshot(run.id)).stepRuns[0]?.error?.message).toContain("missing.png");
  }).pipe(Effect.scoped, Effect.provide(database)),
);
