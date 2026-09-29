import {
  EventId,
  MessageId,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2RpcSchemas,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EventSinkV2, layer as sinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import { ProjectionStoreV2, layer as projectionLayer } from "./ProjectionStore.ts";
import { buildBoundedThreadStreamSnapshot } from "./ThreadStream.ts";
import { selectHistoryPageFromCursor } from "./threadHistoryPaging.ts";

const stores = Layer.merge(eventStoreLayer, projectionLayer).pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const testLayer = Layer.merge(
  stores,
  sinkLayer.pipe(Layer.provide(Layer.merge(stores, SqlitePersistenceMemory))),
);

const decodeThread = Schema.decodeUnknownSync(OrchestrationV2AppThread);
const encodeSnapshot = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2RpcSchemas.subscribeThread.output),
);

it.effect(
  "bounds real SQLite history with 10,000 completed tool nodes and recovers the next page",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const projections = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("history-review-thread");
      const thread = decodeThread({
        id: threadId,
        projectId: "project",
        title: "Review",
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "test" },
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
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("history-create"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      const batch: OrchestrationV2DomainEvent[] = [];
      const base = {
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed",
        title: "Tool",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      } as const;
      batch.push({
        id: EventId.make("history-prompt-event"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...base,
          id: TurnItemId.make("prompt"),
          ordinal: 1,
          type: "user_message",
          messageId: MessageId.make("message"),
          text: "go",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
        },
      });
      for (let i = 0; i < 10_000; i++) {
        const nodeId = NodeId.make(`node-${i}`);
        batch.push({
          id: EventId.make(`history-node-event-${i}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "tool_call",
            status: "completed",
            countsForRun: true,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: now,
          },
        });
        batch.push({
          id: EventId.make(`history-item-event-${i}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...base,
            id: TurnItemId.make(`tool-${i}`),
            nodeId,
            ordinal: i + 2,
            type: "command_execution",
            input: "run",
            output: "result",
          },
        });
      }
      yield* sink.write({ events: batch });
      const window = yield* projections.getThreadSnapshotWindow(threadId, {
        rowLimit: 77,
        userTurnLimit: 10,
      });
      const snapshot = buildBoundedThreadStreamSnapshot(window);
      const encoded = encodeSnapshot(snapshot);
      const bytes = Buffer.byteLength(testJson({ _tag: "Chunk", requestId: 0, values: [encoded] }));
      expect(snapshot.projection.visibleTurnItems).toHaveLength(200);
      expect(snapshot.projection.nodes).toHaveLength(200);
      expect(bytes).toBeLessThanOrEqual(1_048_576);
      expect(snapshot.payloadBudgetExceeded).toBe(false);
      const older = selectHistoryPageFromCursor({
        items: window.projection.visibleTurnItems,
        cursor: snapshot.historyCursor!,
        snapshotSequence: window.snapshotSequence,
      });
      expect(older.items).toHaveLength(200);
      const ids = [...older.items, ...snapshot.projection.visibleTurnItems].map(
        (row) => row.sourceItemId,
      );
      expect(new Set(ids).size).toBe(400);
      process.stdout.write(
        testJson({
          measurement: "SQLite node-bearing history",
          queriedRows: window.projection.turnItems.length,
          retainedNodes: snapshot.projection.nodes.length,
          visibleRows: snapshot.projection.visibleTurnItems.length,
          snapshotRpcBytes: bytes,
        }),
      );
    }).pipe(Effect.provide(testLayer)),
);

function testJson(value: unknown): string {
  return JSON.stringify(value);
}
