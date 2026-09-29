import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  ProviderThreadId,
  ProviderTurnId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RunExecutionServiceV2, layer as executionLayer } from "./RunExecutionService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { ProviderEventIngestorV2 } from "./ProviderEventIngestor.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { RunFinalizationObserver } from "./RunFinalizationService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { layer as idLayer } from "./IdAllocator.ts";
import { makeProviderEventFlowStage } from "./ProviderEventFlowStage.ts";
import { ProviderAdapterV2Event } from "./ProviderAdapter.ts";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

const driver = ProviderDriverKind.make("codex");
const unused = () => Effect.die("Unused provider operation");
const decodeEvent = Schema.decodeUnknownSync(ProviderAdapterV2Event);

it.effect(
  "pressure never finalizes a failed reusable run while its provider is still working",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread");
      const runId = RunId.make("run");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const providerSessionId = ProviderSessionId.make("session");
      const providerThreadId = ProviderThreadId.make("pt");
      const providerTurnId = ProviderTurnId.make("turn");
      const attemptId = RunAttemptId.make("attempt");
      const stage = yield* makeProviderEventFlowStage({
        driver,
        providerSessionId,
        maxItems: 2,
        maxBytes: 100,
      });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const receipts = yield* Queue.unbounded<void>();
      const written: OrchestrationV2DomainEvent[] = [];
      let active = false;
      let interrupts = 0;
      const layer = executionLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
            idLayer,
            ServerSettingsService.layerTest(),
            Layer.mock(EventSinkV2)({
              write: () => Effect.succeed([]),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
              writeWithEffects: (input) =>
                Effect.sync(() => {
                  written.push(...input.events);
                  return [];
                }),
            }),
            Layer.mock(ProviderEventIngestorV2)({
              ingestNormalized: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Queue.offer(receipts, undefined)),
                  Effect.as([]),
                ),
            }),
            Layer.succeed(RunFinalizationObserver, {
              refresh: () => Effect.void,
              refreshAfterTurn: () => Effect.void,
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* RunExecutionServiceV2;
        yield* service.startRootRun({
          commandId: CommandId.make("command"),
          appThread: { id: threadId, projectId: "project" } as OrchestrationV2AppThread,
          providerSessionId,
          session: {
            instanceId: providerInstanceId,
            providerSessionId,
            providerSession: {
              id: providerSessionId,
              driver,
              providerInstanceId,
              status: "ready",
              cwd: process.cwd(),
              model: "test",
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            ensureThread: unused,
            resumeThread: unused,
            steerTurn: unused,
            respondToRuntimeRequest: unused,
            readThreadSnapshot: unused,
            rollbackThread: unused,
            forkThread: unused,
            driver,
            events: Stream.empty,
            subscribeEvents: Effect.succeed({
              events: stage.events,
              close: stage.close.pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
            }),
            startTurn: () =>
              Effect.sync(() => {
                active = true;
              }),
            interruptTurn: () =>
              Effect.sync(() => {
                interrupts++;
                active = false;
              }),
          },
          run: { id: runId, threadId, ordinal: 1, providerInstanceId } as OrchestrationV2Run,
          rootNode: { id: "root", providerTurnId } as OrchestrationV2ExecutionNode,
          checkpointScope: { id: "checkpoint" } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: { id: attemptId, providerTurnId } as OrchestrationV2RunAttempt,
          attemptId,
          providerTurnOrdinal: 1,
          shouldFinalizeRun: () => Effect.succeed(true),
          message: {
            messageId: MessageId.make("message"),
            text: "go",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "test" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
          },
        });
        const event = (i: number, status = "running") =>
          decodeEvent({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: `tool-${i}`,
              threadId,
              runId,
              nodeId: null,
              providerThreadId,
              providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: i + 1,
              status,
              title: "Tool",
              type: "command_execution",
              input: "echo",
              output: "progress",
              startedAt: now,
              completedAt: status === "running" ? null : now,
              updatedAt: now,
            },
          });
        yield* stage.offer(event(0));
        yield* Deferred.await(entered);
        yield* stage.offer(event(1));
        yield* stage.offer(event(2));
        yield* Deferred.succeed(release, undefined);
        for (let i = 0; i < 3; i++) yield* Queue.take(receipts);
        expect(written.some((e) => e.type === "run.updated" && e.payload.status === "failed")).toBe(
          false,
        );
        expect(active).toBe(true);
        for (let i = 0; i < 3; i++) yield* stage.offer(event(i, "completed"));
        active = false; // Native provider reports its normal terminal after finishing.
        yield* stage.offer({
          type: "turn.terminal",
          driver,
          providerThreadId,
          providerTurnId,
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Deferred.await(closed);
        expect(written.findLast((e) => e.type === "run.updated")?.payload).toMatchObject({
          status: "waiting",
        });
        expect(written.findLast((e) => e.type === "run-attempt.updated")?.payload).toMatchObject({
          status: "completed",
        });
        expect(interrupts).toBe(0);
      }).pipe(Effect.provide(layer));
    }),
);
