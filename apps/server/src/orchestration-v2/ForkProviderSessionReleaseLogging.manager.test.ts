import * as NetAddress from "effect/unstable/net/NetAddress";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2AppThread,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as Tracer from "effect/Tracer";
import { HttpServer } from "effect/unstable/http";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EventSinkV2, EventSinkWriteError, layer as eventSinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import type {
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import { makeSingleLayer as makeProviderAdapterRegistryLayer } from "./ProviderAdapterRegistry.ts";
import { layer as providerEventIngestorLayer } from "./ProviderEventIngestor.ts";
import {
  ProviderSessionManagerV2,
  layerWithOptions as providerSessionManagerLayerWithOptions,
} from "./ProviderSessionManager.ts";

// Drives the real ProviderSessionManagerV2 idle timer on a test clock and reads
// what ForkProviderSessionReleaseLogging writes. Nothing here waits on wall time:
// the clock is advanced by hand and every wait is on a Deferred the test owns.

const IDLE_MS = 1000;
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} satisfies ProviderAdapterV2RuntimePolicy;

const StoresLayer = Layer.merge(eventStoreLayer, projectionStoreLayer).pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const EventSinkLayer = eventSinkLayer.pipe(
  Layer.provide(Layer.mergeAll(StoresLayer, SqlitePersistenceMemory)),
);
// Fails only the write that persists a release, so the release itself fails.
const FailingReleaseEventSinkLayer = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const delegate = yield* EventSinkV2;
    return EventSinkV2.of({
      ...delegate,
      write: (input) =>
        input.events.some(
          (event) =>
            event.type === "provider-session.updated" &&
            (event.payload.status === "stopped" || event.payload.status === "error"),
        )
          ? Effect.fail(new EventSinkWriteError({ eventCount: input.events.length }))
          : delegate.write(input),
    });
  }),
).pipe(Layer.provide(EventSinkLayer));

const McpRegistryLayer = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make(),
).pipe(
  Layer.provide(
    Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
  ),
  Layer.provide(
    Layer.succeed(
      ServerEnvironment,
      ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-release-logging")),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const unused = (name: string) => () => Effect.die(`${name} is unused in this test`);

function makeAdapter(input: {
  readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
  readonly closes: Ref.Ref<number>;
}): ProviderAdapterV2Shape {
  return {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (open) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* Effect.addFinalizer(() => Ref.update(input.closes, (count) => count + 1));
        return {
          instanceId: modelSelection.instanceId,
          driver,
          providerSessionId: open.providerSessionId,
          providerSession: {
            id: open.providerSessionId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            status: "ready",
            cwd: process.cwd(),
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          ...(input.hasPendingBackgroundWork === undefined
            ? {}
            : { hasPendingBackgroundWork: input.hasPendingBackgroundWork }),
          ensureThread: unused("ensureThread"),
          resumeThread: (thread) => Effect.succeed(thread.providerThread),
          startTurn: () => Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: unused("readThreadSnapshot"),
          rollbackThread: unused("rollbackThread"),
          forkThread: unused("forkThread"),
        } satisfies ProviderAdapterV2SessionRuntime;
      }),
  };
}

type LogEntry = { readonly message: string; readonly annotations: Record<string, unknown> };

/** What the fork's release logging wrote, and a way to wait for one message. */
function captureTelemetry(options: { readonly throwing?: boolean } = {}) {
  const logs: LogEntry[] = [];
  const spans: Tracer.NativeSpan[] = [];
  const waiters = new Map<string, Deferred.Deferred<void>>();
  const logger = Logger.make(({ fiber, message }) => {
    const text = String((Array.isArray(message) ? message : [message])[0]);
    if (!text.startsWith("provider.session.release.")) return;
    if (options.throwing) throw new Error("the logger is broken");
    logs.push({ message: text, annotations: fiber.getRef(References.CurrentLogAnnotations) });
    const waiter = waiters.get(text);
    if (waiter !== undefined) Deferred.doneUnsafe(waiter, Effect.void);
  });
  const tracer = Tracer.make({
    span: (spanOptions) => {
      if (spanOptions.name.startsWith("provider.session.release.") && options.throwing) {
        throw new Error("the tracer is broken");
      }
      const span = new Tracer.NativeSpan(spanOptions);
      if (span.name.startsWith("provider.session.release.")) spans.push(span);
      return span;
    },
  });
  const until = (message: string) =>
    Effect.gen(function* () {
      const waiter = yield* Deferred.make<void>();
      waiters.set(message, waiter);
      if (logs.some((log) => log.message === message)) yield* Deferred.succeed(waiter, undefined);
      yield* Deferred.await(waiter);
    });
  return {
    logs,
    spans,
    until,
    messages: () => logs.map((log) => log.message),
    layer: Logger.layer([logger], { mergeWithExisting: false }),
    tracer,
  };
}

function scenario<E>(input: {
  readonly telemetry: ReturnType<typeof captureTelemetry>;
  readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
  readonly failReleaseWrites?: boolean;
  readonly maxIdlePinMs?: number;
  readonly run: (ctx: {
    readonly manager: typeof ProviderSessionManagerV2.Service;
    readonly closes: Ref.Ref<number>;
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
  }) => Effect.Effect<void, E, IdAllocatorV2 | ProjectionStoreV2>;
}) {
  return Effect.gen(function* () {
    const closes = yield* Ref.make(0);
    const sinkLayer = input.failReleaseWrites ? FailingReleaseEventSinkLayer : EventSinkLayer;
    const managerLayer = providerSessionManagerLayerWithOptions({
      idleTimeoutMs: IDLE_MS,
      ...(input.maxIdlePinMs === undefined ? {} : { maxIdlePinMs: input.maxIdlePinMs }),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          makeProviderAdapterRegistryLayer(
            makeAdapter({
              closes,
              ...(input.hasPendingBackgroundWork === undefined
                ? {}
                : { hasPendingBackgroundWork: input.hasPendingBackgroundWork }),
            }),
          ),
          sinkLayer,
          idAllocatorLayer,
          providerEventIngestorLayer.pipe(
            Layer.provide(Layer.mergeAll(sinkLayer, idAllocatorLayer, StoresLayer)),
          ),
          McpRegistryLayer,
          StoresLayer,
        ),
      ),
    );
    const layer = Layer.mergeAll(StoresLayer, sinkLayer, idAllocatorLayer, managerLayer).pipe(
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const manager = yield* ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({ fixtureName: "release-logging" });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "release-logging",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const thread: OrchestrationV2AppThread = {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId,
        title: "Release logging",
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: idAllocator.derive.providerThread({
          driver,
          nativeThreadId: "native-thread",
        }),
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "thread.created" as const,
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      yield* input.run({
        manager,
        closes,
        threadId,
        providerSessionId,
      });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(input.telemetry.layer), Effect.withTracer(input.telemetry.tracer));
}

const open = (
  manager: typeof ProviderSessionManagerV2.Service,
  threadId: ThreadId,
  providerSessionId: ProviderSessionId,
) => manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });

it.effect("a release is logged from candidate to outcome under one decision id", () => {
  const telemetry = captureTelemetry();
  return scenario({
    telemetry,
    run: ({ manager, closes, threadId, providerSessionId }) =>
      Effect.gen(function* () {
        const projection = yield* ProjectionStoreV2;
        yield* open(manager, threadId, providerSessionId);
        const completed = yield* telemetry
          .until("provider.session.release.stop-completed")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(IDLE_MS);
        yield* Fiber.join(completed);

        assert.deepEqual(telemetry.messages(), [
          "provider.session.release.candidate",
          "provider.session.release.decision",
          "provider.session.release.stop-requested",
          "provider.session.release.stop-completed",
        ]);
        assert.equal(new Set(telemetry.logs.map((log) => log.annotations.decisionId)).size, 1);
        assert.isTrue(
          telemetry.logs.every((log) => log.annotations.providerSessionId === providerSessionId),
        );
        assert.equal(telemetry.logs[1]?.annotations.decision, "stop_inactive_session");
        assert.equal(telemetry.logs[3]?.annotations.result, "entry_removed");
        assert.equal(telemetry.spans.length, 1);
        assert.equal(telemetry.spans[0]?.status._tag, "Ended");
        // The logging did not stand in for the release.
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.equal(yield* Ref.get(closes), 1);
        assert.equal(
          (yield* projection.getThreadProjection(threadId)).providerSessions.at(-1)?.status,
          "stopped",
        );
      }),
  });
});

it.effect("a session that turns busy during the check is skipped, and the log says so", () => {
  const telemetry = captureTelemetry();
  return Effect.gen(function* () {
    const checkEntered = yield* Deferred.make<void>();
    const firstCheck = yield* Ref.make(true);
    yield* scenario({
      telemetry,
      // Parks the idle timer inside the probe until a turn cancels it.
      hasPendingBackgroundWork: Effect.gen(function* () {
        if (yield* Ref.getAndSet(firstCheck, false)) {
          yield* Deferred.succeed(checkEntered, undefined);
          return yield* Effect.never;
        }
        return false;
      }),
      run: ({ manager, closes, threadId, providerSessionId }) =>
        Effect.gen(function* () {
          const idAllocator = yield* IdAllocatorV2;
          const projection = yield* ProjectionStoreV2;
          const runtime = yield* open(manager, threadId, providerSessionId);
          yield* TestClock.adjust(IDLE_MS);
          yield* Deferred.await(checkEntered);

          const now = yield* DateTime.now;
          const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
          const skipped = yield* telemetry
            .until("provider.session.release.decision")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* runtime.startTurn({
            appThread: (yield* projection.getThreadProjection(threadId)).thread,
            threadId,
            runId,
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
            rootNodeId: idAllocator.derive.rootNode({ runId }),
            providerThread: {
              id: idAllocator.derive.providerThread({ driver, nativeThreadId: "native-thread" }),
              driver,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
              text: "hello",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          });
          yield* Fiber.join(skipped);

          assert.deepEqual(telemetry.messages(), [
            "provider.session.release.candidate",
            "provider.session.release.decision",
          ]);
          assert.equal(
            telemetry.logs[1]?.annotations.decision,
            "skip_interrupted_during_background_probe",
          );
          assert.equal(
            telemetry.logs[1]?.annotations.decisionId,
            telemetry.logs[0]?.annotations.decisionId,
          );
          assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
          assert.equal(yield* Ref.get(closes), 0);
        }),
    });
  });
});

it.effect("pending background work defers the release and is logged as the reason", () => {
  const telemetry = captureTelemetry();
  return Effect.gen(function* () {
    const pending = yield* Ref.make(true);
    yield* scenario({
      telemetry,
      hasPendingBackgroundWork: Ref.get(pending),
      run: ({ manager, closes, threadId, providerSessionId }) =>
        Effect.gen(function* () {
          yield* open(manager, threadId, providerSessionId);
          const deferred = yield* telemetry
            .until("provider.session.release.decision")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* TestClock.adjust(IDLE_MS);
          yield* Fiber.join(deferred);

          assert.deepEqual(telemetry.messages(), [
            "provider.session.release.candidate",
            "provider.session.release.decision",
          ]);
          assert.equal(telemetry.logs[1]?.annotations.decision, "skip_background_work");
          assert.equal(telemetry.logs[1]?.annotations.pinnedForMs, 0);
          assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
          assert.equal(yield* Ref.get(closes), 0);

          // Once the work is done the next check releases, under a fresh decision.
          yield* Ref.set(pending, false);
          const completed = yield* telemetry
            .until("provider.session.release.stop-completed")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* TestClock.adjust(IDLE_MS);
          yield* Fiber.join(completed);
          const ids = telemetry.logs.map((log) => log.annotations.decisionId);
          assert.notEqual(ids[0], ids[2]);
          assert.equal(ids[2], ids[5]);
          assert.equal(yield* Ref.get(closes), 1);
        }),
    });
  });
});

it.effect("a failed pending-work check is logged and marks the stop that follows", () => {
  const telemetry = captureTelemetry();
  return scenario({
    telemetry,
    hasPendingBackgroundWork: Effect.die("the adapter cannot say"),
    run: ({ manager, closes, threadId, providerSessionId }) =>
      Effect.gen(function* () {
        yield* open(manager, threadId, providerSessionId);
        const completed = yield* telemetry
          .until("provider.session.release.stop-completed")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(IDLE_MS);
        yield* Fiber.join(completed);

        assert.deepEqual(telemetry.messages(), [
          "provider.session.release.candidate",
          "provider.session.release.pending-work-check-failed",
          "provider.session.release.decision",
          "provider.session.release.stop-requested",
          "provider.session.release.stop-completed",
        ]);
        assert.equal(new Set(telemetry.logs.map((log) => log.annotations.decisionId)).size, 1);
        assert.include(String(telemetry.logs[1]?.annotations.cause), "the adapter cannot say");
        assert.equal(telemetry.logs[2]?.annotations.pendingWorkCheck, "failed");
        // Upstream still treats a failed check as "no pending work".
        assert.equal(yield* Ref.get(closes), 1);
      }),
  });
});

it.effect("a failed release is reported under the same decision id", () => {
  const telemetry = captureTelemetry();
  return scenario({
    telemetry,
    failReleaseWrites: true,
    run: ({ manager, threadId, providerSessionId }) =>
      Effect.gen(function* () {
        yield* open(manager, threadId, providerSessionId);
        const completed = yield* telemetry
          .until("provider.session.release.stop-completed")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(IDLE_MS);
        yield* Fiber.join(completed);

        const outcome = telemetry.logs.at(-1);
        assert.equal(outcome?.annotations.result, "release_failed");
        assert.isDefined(outcome?.annotations.cause);
        assert.equal(outcome?.annotations.decisionId, telemetry.logs[0]?.annotations.decisionId);
        assert.equal(outcome?.annotations.providerSessionId, providerSessionId);
      }),
  });
});

it.effect("a session closed before its timer fires writes nothing", () => {
  const telemetry = captureTelemetry();
  return scenario({
    telemetry,
    run: ({ manager, closes, threadId, providerSessionId }) =>
      Effect.gen(function* () {
        yield* open(manager, threadId, providerSessionId);
        yield* manager.close(providerSessionId);
        yield* TestClock.adjust(IDLE_MS * 10);
        yield* Effect.yieldNow;

        assert.equal(yield* Ref.get(closes), 1);
        assert.deepEqual(telemetry.logs, []);
        assert.deepEqual(telemetry.spans, []);
      }),
  });
});

it.effect("a logger and tracer that throw do not stop or delay the release", () => {
  const telemetry = captureTelemetry({ throwing: true });
  return scenario({
    telemetry,
    run: ({ manager, closes, threadId, providerSessionId }) =>
      Effect.gen(function* () {
        const projection = yield* ProjectionStoreV2;
        yield* open(manager, threadId, providerSessionId);
        yield* TestClock.adjust(IDLE_MS);
        for (let turn = 0; turn < 50 && (yield* Ref.get(closes)) === 0; turn += 1) {
          yield* Effect.yieldNow;
        }

        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.equal(yield* Ref.get(closes), 1);
        assert.equal(
          (yield* projection.getThreadProjection(threadId)).providerSessions.at(-1)?.status,
          "stopped",
        );
        assert.deepEqual(telemetry.logs, []);
      }),
  });
});

it.effect("a throwing logger does not defeat the deferral for background work", () => {
  const telemetry = captureTelemetry({ throwing: true });
  return scenario({
    telemetry,
    hasPendingBackgroundWork: Effect.succeed(true),
    maxIdlePinMs: 2 * IDLE_MS,
    run: ({ manager, closes, threadId, providerSessionId }) =>
      Effect.gen(function* () {
        yield* open(manager, threadId, providerSessionId);
        yield* TestClock.adjust(IDLE_MS);
        yield* Effect.yieldNow;
        // Deferred, not stranded: the timer is still armed and releases once the pin expires.
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
        yield* TestClock.adjust(IDLE_MS * 2);
        for (let turn = 0; turn < 50 && (yield* Ref.get(closes)) === 0; turn += 1) {
          yield* Effect.yieldNow;
        }
        assert.equal(yield* Ref.get(closes), 1);
      }),
  });
});
