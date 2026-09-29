import {
  EventId,
  MessageId,
  NodeId,
  RunId,
  RuntimeRequestId,
  OrchestrationV2AppThread,
  OrchestrationV2RpcSchemas,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EventSinkV2, layer as sinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import { ProjectionStoreV2, layer as projectionLayer } from "./ProjectionStore.ts";
import { buildBoundedThreadStreamSnapshot } from "./ThreadStream.ts";
import {
  decodeThreadHistoryCursor,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./threadHistoryPaging.ts";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { createQuestionHistoryProjector } from "../../../../packages/client-runtime/src/state/threadRequests.ts";

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

it.effect("decodes a 10,001-row SQLite turn linearly and recovers every 200-row page", () =>
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
    let decodedRows = 0;
    const originalParse = JSON.parse;
    const parse = vi.spyOn(JSON, "parse").mockImplementation((input, reviver) => {
      const value = originalParse(input, reviver);
      if (
        value?.threadId === threadId &&
        (value.type === "command_execution" || value.type === "user_message")
      )
        decodedRows++;
      return value;
    });
    try {
      const window = yield* projections.getThreadSnapshotWindow(threadId, {
        rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
        userTurnLimit: 10,
      });
      const snapshot = buildBoundedThreadStreamSnapshot(window);
      const encoded = encodeSnapshot(snapshot);
      const bytes = Buffer.byteLength(testJson({ _tag: "Chunk", requestId: 0, values: [encoded] }));
      expect(snapshot.projection.visibleTurnItems).toHaveLength(200);
      expect(snapshot.projection.nodes).toHaveLength(200);
      expect(bytes).toBeLessThanOrEqual(1_048_576);
      expect(snapshot.payloadBudgetExceeded).toBe(false);
      const ids = snapshot.projection.visibleTurnItems.map((row) => String(row.sourceItemId));
      let cursor = snapshot.historyCursor;
      let pages = 1;
      while (cursor !== null && cursor !== undefined) {
        const anchor = decodeThreadHistoryCursor(cursor);
        const olderWindow = yield* projections.getThreadSnapshotWindow(threadId, {
          rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          userTurnLimit: 20,
          anchorItemId: TurnItemId.make(anchor.si),
          anchorThreadId: ThreadId.make(anchor.st),
        });
        const page = selectHistoryPageFromCursor({
          items: olderWindow.projection.visibleTurnItems,
          cursor,
          snapshotSequence: olderWindow.snapshotSequence,
        });
        expect(page.items).toHaveLength(Math.min(200, 10_001 - ids.length));
        ids.unshift(...page.items.map((row) => String(row.sourceItemId)));
        cursor = page.nextCursor;
        pages++;
      }
      expect(ids).toEqual(["prompt", ...Array.from({ length: 10_000 }, (_, i) => `tool-${i}`)]);
      expect(pages).toBe(51);
      expect(decodedRows).toBeGreaterThanOrEqual(10_001);
      expect(decodedRows).toBeLessThanOrEqual(10_200);
      process.stdout.write(
        testJson({
          measurement: "SQLite node-bearing history",
          queriedRows: window.projection.turnItems.length,
          retainedNodes: snapshot.projection.nodes.length,
          visibleRows: snapshot.projection.visibleTurnItems.length,
          snapshotRpcBytes: bytes,
          decodedRows,
          pages,
        }),
      );
    } finally {
      parse.mockRestore();
    }
  }).pipe(Effect.provide(testLayer)),
);

function testJson(value: unknown): string {
  return JSON.stringify(value);
}

it.effect(
  "keeps the latest completed assistant outside the SQL page and a visible legacy answer without a node",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSinkV2;
      const projections = yield* ProjectionStoreV2;
      const { thread } = v2Projection;
      const threadId = thread.id;
      const now = v2Projection.updatedAt;
      const runId = RunId.make("completed-run");
      const messageId = MessageId.make("latest-assistant");
      const requestId = RuntimeRequestId.make("legacy-question");
      const base = {
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      const events: OrchestrationV2DomainEvent[] = [
        {
          id: EventId.make("retained-thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
        {
          id: EventId.make("retained-run"),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: thread.modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("user"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make("retained-message"),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role: "assistant",
            text: "Completed answer",
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("retained-prompt"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...base,
            id: TurnItemId.make("user-item"),
            ordinal: 1,
            type: "user_message",
            messageId: MessageId.make("user"),
            text: "Go",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
          },
        },
        {
          id: EventId.make("retained-assistant"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...base,
            id: TurnItemId.make("assistant-item"),
            ordinal: 2,
            type: "assistant_message",
            messageId,
            text: "Completed answer",
            attachments: [],
            streaming: false,
          },
        },
        {
          id: EventId.make("retained-request"),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: NodeId.make("missing-question-node"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "resolved",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: now,
            answers: { next: "continue" },
          },
        },
      ];
      for (let i = 0; i < 300; i++)
        events.push({
          id: EventId.make(`retained-tool-${i}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...base,
            id: TurnItemId.make(`later-tool-${i}`),
            ordinal: i + 3,
            type: "command_execution",
            input: "echo",
            output: "done",
          },
        });
      events.push({
        id: EventId.make("retained-question"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...base,
          id: TurnItemId.make("question-item"),
          ordinal: 400,
          type: "user_input_request",
          requestId,
          responseMode: "message",
          questions: [
            {
              id: "next",
              header: "Next",
              question: "What next?",
              required: true,
              allowCustomAnswer: false,
              options: [{ label: "Continue", value: "continue", description: "Resume" }],
            },
          ],
        },
      });
      yield* sink.write({ events });
      const window = yield* projections.getThreadSnapshotWindow(threadId, {
        rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
        userTurnLimit: 10,
      });
      const snapshot = buildBoundedThreadStreamSnapshot(window);
      expect(snapshot.projection.visibleTurnItems).toHaveLength(200);
      expect(snapshot.projection.messages).toMatchObject([
        { id: messageId, text: "Completed answer" },
      ]);
      expect(
        snapshot.projection.visibleTurnItems.some((row) => row.sourceItemId === "assistant-item"),
      ).toBe(false);
      const question = createQuestionHistoryProjector()(snapshot.projection).find(
        (row) => row.item.type === "user_input_request",
      )?.item;
      if (question?.type !== "user_input_request") throw new Error("Expected visible question");
      expect(question.questionAnswer?.answers).toEqual({ next: "continue" });
      expect(window.projection.turnItems.length).toBeLessThanOrEqual(204);
    }).pipe(Effect.provide(testLayer)),
);
