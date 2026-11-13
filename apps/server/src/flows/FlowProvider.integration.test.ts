import * as ServerConfig from "../config.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as Lifecycle from "./FlowLifecycle.ts";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import * as Settings from "../serverSettings.ts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  FlowId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type FlowDefinition,
} from "@t3tools/contracts";

import { threadShellFromProjection } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import { makeFlowRpcHandlers } from "./FlowRpcHandlers.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { validateFlowDefinition, flowDefinitionRevision } from "@t3tools/shared/flow";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Service from "./FlowService.ts";
import * as Runtime from "./FlowRuntime.ts";
import * as Definitions from "./FlowDefinitions.ts";
import * as Repository from "./FlowRunRepository.ts";
import * as Lock from "./FlowRunLock.ts";
import * as Commands from "./FlowCommandRunner.ts";

it.effect(
  "drives provider terminal events through the effect worker into a loop, command and approval",
  () =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("flow-provider");
      const driver = ProviderDriverKind.make("codex");
      const instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "test-model" };
      let turns = 0;
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  turns++;
                  const providerTurnId = ProviderTurnId.make(`turn:${turn.attemptId}`);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: { driver, nativeId: providerTurnId, strength: "strong" },
                      ordinal: turn.providerTurnOrdinal,
                      status: "completed",
                      startedAt: now,
                      completedAt: now,
                    },
                  });
                  yield* Queue.offer(events, {
                    type: "turn.terminal",
                    driver,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId,
                    runOrdinal: turn.runOrdinal,
                    status: "completed",
                    failure: null,
                    threadDisposition: "reusable",
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const database = Sqlite.layerMemory;
      const harness = Harness.layerWithRegistry(
        { name: "flow-provider" },
        Registry.layerFromAdapters([adapter]),
        { databaseLayer: database },
      ).pipe(Layer.provide(Lifecycle.layer));
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* Worker.OrchestrationEffectWorkerV2;
        const provider = yield* buildUnavailableProviderSnapshot({
          instanceId,
          driverKind: driver,
          reason: "fixture",
        });
        const runtime = Runtime.layer.pipe(
          Layer.provide(Layer.mock(Definitions.FlowDefinitions)({})),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-flow-runtime-" })),
          Layer.provide(Layer.mock(DocumentText.DocumentText)({})),
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Instances.ProviderInstanceRegistry)({
                listInstances: Effect.succeed([
                  {
                    instanceId,
                    driverKind: driver,
                    enabled: true,
                    displayName: undefined,
                    continuationIdentity: { driverKind: driver, continuationKey: "fixture" },
                    orchestrationAdapter: adapter,
                    textGeneration: {
                      generateCommitMessage: () => Effect.die("unused"),
                      generatePrContent: () => Effect.die("unused"),
                      generateBranchName: () => Effect.die("unused"),
                      generateThreadTitle: () => Effect.die("unused"),
                      generateReviewGuide: () => Effect.die("unused"),
                      generateTranscriptionPostProcessing: () => Effect.die("unused"),
                    },
                    snapshot: {
                      getSnapshot: Effect.succeed(provider),
                      refresh: Effect.succeed(provider),
                      streamChanges: Stream.empty,
                      resolveMaintenance: () => Effect.die("unused"),
                      applyUsageLimits: () => Effect.void,
                    },
                  },
                ]),
              }),
              Outbox.layer,
              Layer.mock(Settings.ServerSettingsService)({
                getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
              }),
              Layer.mock(Projects.ProjectService)({
                getById: () =>
                  Effect.succeedSome({
                    id: ProjectId.make("flow-project"),
                    title: "Flow",
                    workspaceRoot: cwd,
                    defaultModelSelection: modelSelection,
                    scripts: [],
                    createdAt: "2026-10-31T00:00:00.000Z",
                    updatedAt: "2026-10-31T00:00:00.000Z",
                    deletedAt: null,
                  }),
              }),
              Layer.mock(ThreadLaunch.ThreadLaunchService)({
                launch: (input) =>
                  Effect.gen(function* () {
                    const threadId = input.threadId!;
                    yield* orchestrator.dispatch({
                      type: "thread.create",
                      commandId: input.commandId,
                      threadId,
                      projectId: input.projectId,
                      title: input.title,
                      modelSelection: input.modelSelection,
                      runtimeMode: input.runtimeMode,
                      interactionMode: input.interactionMode,
                      worktreePath: cwd,
                      branch: null,
                      createdBy: input.createdBy,
                      creationSource: input.creationSource,
                    });
                    return {
                      threadId,
                      projection: yield* orchestrator.getThreadProjection(threadId),
                      resumed: false,
                    };
                  }).pipe(Effect.orDie),
              }),
              Layer.mock(Threads.ThreadManagementService)({
                dispatch: orchestrator.dispatch,
                getThreadRecords: orchestrator.getThreadRecords,
                getThreadShell: (id) =>
                  orchestrator
                    .getThreadProjection(id)
                    .pipe(Effect.map(threadShellFromProjection), Effect.orDie),
                sendToThread: (input) =>
                  Effect.gen(function* () {
                    const dispatch = yield* orchestrator.dispatch({
                      type: "message.dispatch",
                      commandId: input.commandId,
                      messageId: input.messageId!,
                      threadId: input.threadId,
                      text: input.text,
                      attachments: [],
                      modelSelection,
                      dispatchMode: { type: "start_immediately" },
                      createdBy: "user",
                      creationSource: "web",
                    });
                    const projection = yield* orchestrator.getThreadProjection(input.threadId);
                    return {
                      dispatch,
                      projection,
                      message: projection.messages.find((m) => m.id === input.messageId)!,
                      run: projection.runs.find((r) => r.userMessageId === input.messageId)!,
                      turnItem: null,
                      delivery: "started" as const,
                    };
                  }).pipe(Effect.orDie),
                interruptThread: (input) =>
                  orchestrator
                    .dispatch({
                      type: "thread.stop",
                      commandId: input.commandId,
                      threadId: input.threadId,
                    })
                    .pipe(Effect.as({ type: "no_active_run" as const }), Effect.orDie),
              }),
            ),
          ),
        );
        const definition: FlowDefinition = {
          version: 1,
          title: "Provider flow",
          workspace: "root",
          defaults: { model: { providerInstanceId: instanceId, model: "test-model" } },
          steps: [
            { id: "implement", kind: "agent", prompt: "Implement" },
            {
              id: "loop",
              kind: "loop",
              maxIterations: 1,
              until: { ref: "iteration", op: "eq", value: 0 },
              steps: [{ id: "review", kind: "agent", prompt: "Review" }],
              edges: [],
            },
            { id: "command", kind: "command", command: "echo checked" },
            { id: "gate", kind: "approval", prompt: "Ship?" },
          ],
          edges: [
            { from: "implement", to: "loop" },
            { from: "loop", to: "command" },
            { from: "command", to: "gate" },
          ],
        };
        const entry = {
          flowId: FlowId.make("provider"),
          definition,
          revision: flowDefinitionRevision(definition),
          validation: validateFlowDefinition(definition),
        };
        const commandStarted = yield* Queue.unbounded<void>();
        let holdCommands = false;
        let killedCommands = 0;
        const context = yield* Layer.build(
          Service.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                runtime,
                Repository.layer,
                Lock.layer,
                NodeCrypto.layer,
                Layer.mock(Definitions.FlowDefinitions)({ read: () => Effect.succeed(entry) }),
                Layer.succeed(Commands.FlowCommandRunner, {
                  run: () =>
                    holdCommands
                      ? Queue.offer(commandStarted, undefined).pipe(
                          Effect.andThen(Effect.never),
                          Effect.ensuring(
                            Effect.sync(() => {
                              killedCommands++;
                            }),
                          ),
                        )
                      : Effect.succeed({
                          kind: "command",
                          text: "checked",
                          lines: ["checked"],
                          lineCount: 1,
                          exitCode: 0,
                          timedOut: false,
                        }),
                }),
              ),
            ),
          ),
        );
        const service = Context.get(context, Service.FlowService);
        yield* service.recover();
        const rpc = yield* makeFlowRpcHandlers("test-session").pipe(
          Effect.provideService(Service.FlowService, service),
        );
        const run = yield* rpc["flow.start"]({
          projectId: ProjectId.make("flow-project"),
          flowId: entry.flowId,
          inputs: {},
        });
        yield* service.run(run.id).pipe(
          Stream.filter(
            (event) =>
              event.summary?.status === "running" || event.summary?.status === "waiting_approval",
          ),
          Stream.runHead,
        );
        yield* worker.drain();
        yield* service.run(run.id).pipe(
          Stream.filter((event) => event.summary?.status === "waiting_approval"),
          Stream.runHead,
        );
        yield* worker.drain();
        expect(turns).toBe(2);
        const snapshot = yield* service.snapshot(run.id);
        expect((yield* orchestrator.getThreadProjection(run.flowRunThreadId)).runs).toHaveLength(0);
        expect(snapshot.stepRuns.filter((step) => step.status === "succeeded")).toHaveLength(4);
        const gate = snapshot.approvals[0]!;
        const stepThread = snapshot.stepRuns.find((step) => step.threadId)!.threadId!;
        expect(
          (yield* service
            .answerApproval(
              { stepRunId: gate.stepRunId, decision: "approve" },
              stepThread,
              stepThread,
            )
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(
          (yield* rpc["flow.answerApproval"]({
            stepRunId: snapshot.approvals[0]!.stepRunId,
            decision: "approve",
          })).status,
        ).toBe("succeeded");
        const stopped = yield* rpc["flow.start"]({
          projectId: ProjectId.make("flow-project"),
          flowId: entry.flowId,
          inputs: {},
        });
        yield* service.run(stopped.id).pipe(
          Stream.filter((event) => event.summary?.status === "running"),
          Stream.runHead,
        );
        expect((yield* rpc["flow.stop"]({ flowRunId: stopped.id })).status).toBe("cancelled");
        yield* worker.drain();
        holdCommands = true;
        for (const type of ["thread.archive", "thread.delete"] as const) {
          const owned = yield* rpc["flow.start"]({
            projectId: ProjectId.make("flow-project"),
            flowId: entry.flowId,
            inputs: {},
          });
          yield* Queue.take(commandStarted);
          yield* orchestrator.dispatch({
            type,
            commandId: CommandId.make(type),
            threadId: owned.flowRunThreadId,
          });
          if (type === "thread.archive")
            expect((yield* service.snapshot(owned.id)).summary.status).toBe("cancelled");
          else
            expect(
              (yield* service.runsPage(ProjectId.make("flow-project"))).runs.some(
                (run) => run.id === owned.id,
              ),
            ).toBe(false);
          expect(killedCommands).toBe(type === "thread.archive" ? 1 : 2);
        }
      }).pipe(Effect.provide(Layer.mergeAll(harness, database, Lifecycle.layer)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
