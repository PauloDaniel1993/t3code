import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  MessageId,
  FlowId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type FlowDefinition,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { validateFlowDefinition, flowDefinitionRevision } from "@t3tools/shared/flow";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
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
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* Worker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const afterSequence = yield* sink.latestSequence();
        const send = Effect.fn("test.send")(function* (input: Runtime.FlowThreadInput) {
          yield* orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${input.commandId}:message`),
              messageId: MessageId.make(input.messageId!),
              threadId: input.threadId,
              text: input.prompt!,
              attachments: [],
              modelSelection,
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.orDie);
        });
        const runtime = Layer.succeed(Runtime.FlowRuntime, {
          root: () => Effect.succeed(cwd),
          launch: Effect.fn("test.launch")(function* (input) {
            yield* orchestrator
              .dispatch({
                type: "thread.create",
                commandId: CommandId.make(input.commandId),
                threadId: input.threadId,
                projectId: input.projectId,
                title: input.title,
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                worktreePath: cwd,
                branch: null,
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(Effect.orDie);
            if (input.prompt) yield* send(input);
            return cwd;
          }),
          send,
          interrupt: () => Effect.void,
          attention: () => Effect.void,
          continuing: () => Effect.succeed(null),
          events: sink.stream({ afterSequence }).pipe(
            Stream.filter((stored) => stored.event.type === "run.updated"),
            Stream.map((stored) => stored.event.threadId),
            Stream.orDie,
          ),
          settled: Effect.fn("test.settled")(function* (id, messageId) {
            const projection = yield* orchestrator.getThreadProjection(id).pipe(Effect.orDie);
            const run = projection.runs.find((run) => run.userMessageId === messageId);
            return run?.status === "completed"
              ? {
                  messageId,
                  turnId: run.id,
                  text: subagentResultForRun(projection, run).text,
                  failed: false,
                }
              : null;
          }),
        });
        const definition: FlowDefinition = {
          version: 1,
          title: "Provider flow",
          workspace: "root",
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
                    Effect.succeed({
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
        const run = yield* service.start({
          projectId: ProjectId.make("flow-project"),
          flowId: entry.flowId,
          inputs: {},
        });
        yield* worker.drain();
        yield* service.run(run.id).pipe(
          Stream.filter((event) => event.summary?.status === "waiting_approval"),
          Stream.runHead,
        );
        yield* worker.drain();
        expect(turns).toBe(2);
        const snapshot = yield* service.snapshot(run.id);
        expect(snapshot.stepRuns.filter((step) => step.status === "succeeded")).toHaveLength(4);
        expect(
          (yield* service.answerApproval(
            { stepRunId: snapshot.approvals[0]!.stepRunId, decision: "approve" },
            "test",
          )).status,
        ).toBe("succeeded");
      }).pipe(Effect.provide(Layer.mergeAll(harness, database)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
