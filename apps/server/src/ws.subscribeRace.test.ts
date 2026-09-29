import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./orchestration-v2/EventSink.ts";
import { layerFromOrchestrationEventStore as eventStoreLayer } from "./orchestration-v2/EventStore.ts";
import {
  OrchestratorDomainEventStreamError,
  OrchestratorProjectionError,
} from "./orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "./orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "./orchestration-v2/ThreadManagementService.ts";
import { subscribeOrchestrationV2Thread } from "./ws.ts";

const applicationEvents = OrchestrationEventStoreLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const stores = Layer.mergeAll(
  applicationEvents,
  eventStoreLayer.pipe(Layer.provideMerge(applicationEvents)),
  projectionStoreLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const TestLayer = eventSinkLayer.pipe(Layer.provideMerge(stores));

it.layer(TestLayer)("thread snapshot/subscription boundary", (it) => {
  for (const acceptBoundedSnapshot of [false, true]) {
    it.effect(
      `replays a receipted change committed after the ${acceptBoundedSnapshot ? "bounded" : "full"} snapshot and before subscribing`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const sink = yield* EventSinkV2;
            const projections = yield* ProjectionStoreV2;
            const now = yield* DateTime.now;
            const testId = `subscribe-race:${acceptBoundedSnapshot ? "bounded" : "full"}`;
            const threadId = ThreadId.make(`thread:${testId}`);
            const thread: OrchestrationV2AppThread = {
              id: threadId,
              projectId: ProjectId.make("project:subscribe-race"),
              title: "Before subscribe",
              createdBy: "user",
              creationSource: "web",
              providerInstanceId: ProviderInstanceId.make("codex"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
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
            const created = yield* sink.commitCommand({
              commandId: CommandId.make(`command:${testId}:create`),
              commandType: "thread.create",
              threadId,
              acceptedAt: now,
              effects: [],
              events: [
                {
                  id: EventId.make(`event:${testId}:create`),
                  type: "thread.created",
                  threadId,
                  occurredAt: now,
                  payload: thread,
                },
              ],
            });
            const snapshotLoaded = yield* Deferred.make<void>();
            const releaseSnapshot = yield* Deferred.make<void>();
            const holdSnapshot = <A, E>(snapshot: Effect.Effect<A, E>) =>
              snapshot.pipe(
                Effect.tap(() => Deferred.succeed(snapshotLoaded, undefined)),
                Effect.tap(() => Deferred.await(releaseSnapshot)),
                Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
              );
            // Only the facade is replaced to control the boundary. SQLite,
            // transactional projections, command receipts and EventSink's
            // bounded replay/live implementation are the production services.
            const threadManagement = Layer.mock(ThreadManagementService)({
              ensureLegacyTranscript: () => Effect.void,
              getThreadSnapshot: (id) => holdSnapshot(projections.getThreadSnapshot(id)),
              getThreadSnapshotWindow: (id, options) =>
                holdSnapshot(projections.getThreadSnapshotWindow(id, options)),
              streamStoredEventsFrom: (input) =>
                sink
                  .stream({ ...input, bounded: true })
                  .pipe(
                    Stream.mapError((cause) => new OrchestratorDomainEventStreamError({ cause })),
                  ),
            });
            const subscribing = yield* subscribeOrchestrationV2Thread({
              threadId,
              acceptBoundedSnapshot,
            }).pipe(Effect.provide(threadManagement), Effect.forkScoped);
            yield* Effect.raceFirst(Deferred.await(snapshotLoaded), Fiber.join(subscribing));
            const changed = yield* sink.commitCommand({
              commandId: CommandId.make(`command:${testId}:update`),
              commandType: "thread.metadata.update",
              threadId,
              acceptedAt: now,
              effects: [],
              events: ["First change", "Second change"].map((title, index) => ({
                id: EventId.make(`event:${testId}:update:${index}`),
                type: "thread.metadata-updated" as const,
                threadId,
                occurredAt: now,
                payload: { ...thread, title },
              })),
            });
            assert.isTrue(changed.committed);
            assert.equal(changed.receipt.status, "accepted");
            assert.equal(changed.receipt.resultSequence, changed.storedEvents.at(-1)?.sequence);
            yield* Deferred.succeed(releaseSnapshot, undefined);
            const stream = yield* Fiber.join(subscribing);
            // Both publications completed before any stream consumer exists.
            // These changes can reach the client only through persisted replay.
            const received = yield* stream.pipe(Stream.take(3), Stream.runCollect);
            const initial = received[0];
            assert.equal(initial?.kind, "snapshot");
            if (initial?.kind !== "snapshot") return;
            assert.equal(initial.snapshotSequence, created.receipt.resultSequence);
            assert.equal(initial.projection.thread.title, thread.title);
            assert.deepEqual(
              received
                .slice(1)
                .map((item) => (item.kind === "event" ? [item.sequence, item.event] : item)),
              changed.storedEvents.map((stored) => [stored.sequence, stored.event]),
            );
          }),
        ),
    );
  }
});
