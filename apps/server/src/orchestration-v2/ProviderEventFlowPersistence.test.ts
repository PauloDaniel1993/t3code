import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { EventStoreV2, layer as eventStoreLayer } from "./EventStore.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import { ProviderEventIngestorV2, layer as ingestorLayer } from "./ProviderEventIngestor.ts";
import { ProviderAdapterEventStreamError } from "./ProviderAdapter.ts";
import { makeProviderEventFlowStage } from "./ProviderEventFlowStage.ts";
import { PROVIDER_TOOL_RESULT_BYTES } from "./ProviderEventPayload.ts";
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";

const driver = ProviderDriverKind.make("codex");

const stores = Layer.merge(eventStoreLayer, projectionStoreLayer).pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const sink = eventSinkLayer.pipe(Layer.provide(Layer.mergeAll(stores, SqlitePersistenceMemory)));
const services = Layer.mergeAll(stores, sink, idAllocatorLayer);
const testLayer = Layer.merge(services, ingestorLayer.pipe(Layer.provide(services)));

function makeThread(threadId: ThreadId, providerInstanceId: ProviderInstanceId, now: DateTime.Utc) {
  return {
    id: threadId,
    projectId: ProjectId.make("flow-project"),
    title: "Flow test",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    branch: null,
    worktreePath: null,
    branchPullRequest: null,
    activeOrderKey: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  } satisfies OrchestrationV2AppThread;
}

it.effect(
  "persists two bounded tool snapshots from 10,000 updates, with one final projection row",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const store = yield* EventStoreV2;
      const ingestor = yield* ProviderEventIngestorV2;
      const projections = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const driver = ProviderDriverKind.make("codex");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const providerSessionId = ProviderSessionId.make("flow-session");
      const threadId = ThreadId.make("flow-thread");
      const thread = makeThread(threadId, providerInstanceId, now);
      yield* sink.write({
        events: [
          {
            id: EventId.make("flow-create"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      const stage = yield* makeProviderEventFlowStage({ driver, providerSessionId });
      const item = {
        id: TurnItemId.make("flow-tool"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: "Tool",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "dynamic_tool",
        toolName: "fixture",
        input: { api_key: "secret-input" },
        output: { rawOutput: "step 1 of 10", password: "secret-running" },
      } as const;
      for (let index = 0; index < 10_000; index++) {
        yield* stage.offer({
          type: "turn_item.updated",
          driver,
          turnItem: {
            ...item,
            title: `Tool ${index}`,
            output: { ...item.output, rawOutput: `step ${index + 1} of 10000` },
          },
        });
      }
      yield* stage.offer({
        type: "turn_item.updated",
        driver,
        turnItem: {
          ...item,
          status: "completed",
          completedAt: now,
          output: { password: "secret-final", content: "界".repeat(100_000) },
        },
      });
      yield* stage.end;
      yield* stage.events.pipe(
        Stream.runForEach((event) =>
          ingestor.ingestNormalized({ providerSessionId, providerInstanceId, threadId, event }),
        ),
      );
      const stored = yield* store
        .read({ threadId, eventType: "turn-item.updated" })
        .pipe(Stream.runCollect);
      expect(stored).toHaveLength(2);
      expect(testJson(stored)).not.toContain("secret-");
      const intermediate = stored[0]?.event;
      expect(intermediate).toMatchObject({
        payload: {
          status: "running",
          title: "Tool 9999",
          input: { api_key: "[REDACTED]" },
          output: { rawOutput: "step 10000 of 10000", password: "[REDACTED]" },
        },
      });
      const final = stored[1]?.event;
      if (final?.type !== "turn-item.updated" || final.payload.type !== "dynamic_tool")
        throw new Error("Expected final tool snapshot");
      expect(Buffer.byteLength(testJson(final.payload.output))).toBeLessThanOrEqual(
        PROVIDER_TOOL_RESULT_BYTES,
      );
      expect(final.payload.output).toMatchObject({ password: "[REDACTED]" });
      const projection = yield* projections.getThreadProjection(threadId);
      expect(projection.turnItems).toHaveLength(1);
      expect(projection.turnItems[0]).toEqual(final.payload);
      process.stdout.write(
        testJson({
          measurement: "persisted burst",
          incomingUpdates: 10_001,
          storedEvents: stored.length,
          storedBytes: Buffer.byteLength(testJson(stored)),
          projectedRows: projection.turnItems.length,
        }),
      );
    }).pipe(Effect.provide(testLayer)),
);

function testJson(value: unknown): string {
  return JSON.stringify(value);
}

it.effect("stores task links behind large arguments and marks excessively deep results", () =>
  Effect.gen(function* () {
    const sink = yield* EventSinkV2;
    const store = yield* EventStoreV2;
    const ingestor = yield* ProviderEventIngestorV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("payload-regression-thread");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("payload-regression-session");
    yield* sink.write({
      events: [
        {
          id: EventId.make("payload-create"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: makeThread(threadId, providerInstanceId, now),
        },
      ],
    });
    const stage = yield* makeProviderEventFlowStage({ driver, providerSessionId });
    let deep: unknown = "leaf";
    for (let i = 0; i < 5_000; i++) deep = [deep];
    const output = {
      content: [{ type: "text", text: testJson({ threadId: "child", taskId: "task" }) }],
      isError: true,
    };
    for (const [index, result] of [output, { ok: true, deep }].entries()) {
      yield* stage.offer({
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: TurnItemId.make(`payload-tool-${index}`),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: index,
          status: "completed",
          title: "Result",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "dynamic_tool",
          toolName: "task_create",
          input: { prompt: "i".repeat(70_000) },
          output: result,
        },
      });
    }
    yield* stage.end;
    yield* stage.events.pipe(
      Stream.runForEach((event) =>
        ingestor.ingestNormalized({ providerSessionId, providerInstanceId, threadId, event }),
      ),
    );
    const stored = yield* store
      .read({ threadId, eventType: "turn-item.updated" })
      .pipe(Stream.runCollect);
    expect(stored).toHaveLength(2);
    const task = stored[0]?.event;
    if (task?.type !== "turn-item.updated" || task.payload.type !== "dynamic_tool")
      throw new Error("Expected task result");
    expect(task.payload.output).toEqual(output);
    expect(compactDynamicToolOutput(task.payload.output)).toEqual({
      threadId: "child",
      taskId: "task",
      isError: true,
    });
    expect(stored[1]?.event).toMatchObject({ payload: { output: { ok: true } } });
    expect(testJson(stored[1])).toContain("[TRUNCATED: depth limit]");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("writes accepted completed array results before reporting transport failure", () =>
  Effect.gen(function* () {
    const sink = yield* EventSinkV2;
    const store = yield* EventStoreV2;
    const ingestor = yield* ProviderEventIngestorV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("failure-thread");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("failure-session");
    yield* sink.write({
      events: [
        {
          id: EventId.make("failure-create"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: makeThread(threadId, providerInstanceId, now),
        },
      ],
    });
    const stage = yield* makeProviderEventFlowStage({ driver, providerSessionId });
    const output = {
      content: [
        {
          type: "text",
          text: testJson({ threadId: "child", taskId: "task", isError: true }),
        },
      ],
      nested: [[{ paths: ["a.ts", "b.ts"] }]],
    };
    yield* stage.offer({
      type: "turn_item.updated",
      driver,
      turnItem: {
        id: TurnItemId.make("final-array-tool"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: "Result",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "dynamic_tool",
        toolName: "task_create",
        input: { paths: ["a.ts"] },
        output,
      },
    });
    yield* stage.fail(
      Cause.fail(
        new ProviderAdapterEventStreamError({
          driver,
          providerSessionId,
          cause: "transport failure",
        }),
      ),
    );
    const exit = yield* stage.events.pipe(
      Stream.runForEach((event) =>
        ingestor.ingestNormalized({ providerSessionId, providerInstanceId, threadId, event }),
      ),
      Effect.exit,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const stored = yield* store
      .read({ threadId, eventType: "turn-item.updated" })
      .pipe(Stream.runCollect);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.event).toMatchObject({
      payload: { status: "completed", input: { paths: ["a.ts"] }, output },
    });
  }).pipe(Effect.provide(testLayer)),
);
