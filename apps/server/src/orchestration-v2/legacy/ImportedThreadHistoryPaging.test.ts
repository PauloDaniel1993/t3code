import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
} from "../ProviderAdapter.ts";
import { makeSingleLayer } from "../ProviderAdapterRegistry.ts";
import { runOrchestratorV2Scenario } from "../testkit/OrchestratorScenario.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../testkit/ReplayFixtureWorkspace.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  OLDER_THREAD_USER_TURN_LIMIT,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "../threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "../WireProjection.ts";
import { LegacyV1ThreadImporter } from "./LegacyV1ThreadImporter.ts";
import { repairForkTaskLinks } from "./ForkTaskLinkRepair.ts";
import { TestLayer, seedThreads, stamp } from "./ForkDataCarryOver.testkit.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const unimplemented = (detail: string) =>
  Effect.fail(new ProviderAdapterProtocolError({ driver, detail }));

/** Answers every turn with one assistant message. */
const replyingAdapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (sessionInput) =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
      const now = yield* DateTime.now;
      const providerSession: OrchestrationV2ProviderSession = {
        id: sessionInput.providerSessionId,
        driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
        model: "gpt-5.4",
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      return {
        instanceId,
        driver,
        providerSessionId: sessionInput.providerSessionId,
        providerSession,
        events: Stream.fromPubSub(events),
        ensureThread: (threadInput) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now;
            return {
              id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: threadInput.threadId, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            } satisfies OrchestrationV2ProviderThread;
          }),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            const eventTime = yield* DateTime.now;
            const providerTurnId = ProviderTurnId.make(`provider-turn:${turnInput.runOrdinal}`);
            yield* PubSub.publishAll(events, [
              {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turnInput.providerThread.id,
                  nodeId: turnInput.rootNodeId,
                  runAttemptId: turnInput.attemptId,
                  nativeTurnRef: { driver, nativeId: providerTurnId, strength: "strong" },
                  ordinal: turnInput.runOrdinal,
                  status: "completed",
                  startedAt: eventTime,
                  completedAt: eventTime,
                },
              },
              {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  id: TurnItemId.make(`turn-item:reply:${turnInput.runOrdinal}`),
                  threadId: turnInput.threadId,
                  runId: turnInput.runId,
                  nodeId: turnInput.rootNodeId,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 1,
                  status: "completed",
                  title: null,
                  startedAt: eventTime,
                  completedAt: eventTime,
                  updatedAt: eventTime,
                  type: "assistant_message",
                  messageId: MessageId.make(`message:reply:${turnInput.runOrdinal}`),
                  text: "V2 reply",
                  streaming: false,
                },
              },
              {
                type: "turn.terminal",
                driver,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId,
                runOrdinal: turnInput.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              },
            ] satisfies ReadonlyArray<ProviderAdapterV2Event>);
          }),
        steerTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () => unimplemented("readThreadSnapshot"),
        rollbackThread: () => unimplemented("rollbackThread"),
        forkThread: () => unimplemented("forkThread"),
      };
    }),
} satisfies ProviderAdapterV2Shape;

const MESSAGE_COUNT = 400;
const TASK_COUNT = 220;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const at = (second: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(stamp), { seconds: second }));

/**
 * A V1 parent with several hundred messages and, as in the developer's
 * database, more than a page of task threads whose imported items sit after
 * the whole transcript with real-sized prompts and results.
 */
const importLongThreadWithTasks = Effect.fnUntraced(function* (workspace: string) {
  const sql = yield* SqlClient.SqlClient;
  const tasks = Array.from({ length: TASK_COUNT }, (_, index) => `task-${index}`);
  yield* seedThreads([["root", null], ...tasks.map((task) => [task, "root"] as const)]);
  yield* sql`UPDATE projection_projects SET workspace_root = ${workspace}`;
  yield* sql`UPDATE projection_threads SET worktree_path = ${workspace} WHERE thread_id = 'root'`;
  for (let index = 0; index < MESSAGE_COUNT; index++) {
    yield* sql`INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${`m${String(index).padStart(3, "0")}`}, 'root', ${index % 2 === 0 ? "user" : "assistant"},
        ${`message ${index}`}, 0, ${at(index)}, ${at(index)})`;
  }
  for (const [index, task] of tasks.entries()) {
    const json = yield* encodeJson({
      title: task,
      prompt: `prompt ${index} `.repeat(300),
      createdBy: "agent",
      status: "finished",
      requestedAt: at(index),
      startedAt: at(index),
      finishedAt: at(index + 1),
      result: { summary: `result ${index} `.repeat(300), completedAt: at(index + 1) },
      delivery: { state: "delivered", updatedAt: at(index + 1) },
    });
    yield* sql`UPDATE projection_threads SET task_json = ${json} WHERE thread_id = ${task}`;
  }
  const importer = yield* LegacyV1ThreadImporter;
  yield* importer.reconcileShells;
  yield* repairForkTaskLinks();
  yield* importer.importPendingTranscripts;
});

const itemKey = (row: OrchestrationV2ProjectedTurnItem) =>
  `${row.sourceThreadId}:${row.sourceItemId}`;

/**
 * Open the thread and press "load earlier" until the history ends, reading
 * exactly as `threadBoundedSnapshot` and `threadHistoryPage` in `http.ts` do.
 */
const pageWholeThread = Effect.fnUntraced(function* (threadId: ThreadId) {
  const projections = yield* ProjectionStoreV2;
  const opened = yield* projections.getThreadSnapshotWindow(threadId, {
    rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
    userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
  });
  const first = buildBoundedThreadProjection({
    projection: projectThreadProjectionForWire(opened.projection),
    snapshotSequence: opened.snapshotSequence,
  });
  assert.isFalse(first.payloadBudgetExceeded);
  const pages = [first.projection.visibleTurnItems];
  let cursor = first.historyCursor;
  let hasMoreHistory = first.hasMoreHistory;
  while (cursor !== null) {
    assert.isTrue(hasMoreHistory);
    const decoded = decodeThreadHistoryCursor(cursor);
    const window = yield* projections.getThreadSnapshotWindow(threadId, {
      rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
      userTurnLimit: OLDER_THREAD_USER_TURN_LIMIT,
      anchorItemId: TurnItemId.make(decoded.si),
      anchorThreadId: ThreadId.make(decoded.st),
    });
    const page = selectHistoryPageFromCursor({
      items: projectThreadProjectionForWire(window.projection).visibleTurnItems,
      cursor,
      snapshotSequence: window.snapshotSequence,
    });
    assert.isNotEmpty(page.items);
    pages.push(page.items);
    cursor = page.nextCursor;
    hasMoreHistory = page.hasMoreHistory;
  }
  assert.isFalse(hasMoreHistory);
  const full = yield* projections.getThreadProjection(threadId);
  return {
    pages,
    // Clients prepend each older page, so the timeline reads last page first.
    timeline: pages.toReversed().flat().map(itemKey),
    expected: full.visibleTurnItems.map(itemKey),
  };
});

it.effect(
  "pages an imported thread with a V2 run back through every imported item once, in order",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* checkpointWorkspace("imported-thread-history-paging");
        const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
          { name: "imported-thread-history-paging", runtimePolicyOverride: { cwd: workspace } },
          makeSingleLayer(replyingAdapter),
          { databaseLayer: SqlitePersistenceMemory },
        );
        yield* Effect.gen(function* () {
          yield* importLongThreadWithTasks(workspace);
          const threadId = ThreadId.make("root");

          // Before any V2 write the history already pages completely.
          const importedOnly = yield* pageWholeThread(threadId);
          assert.lengthOf(importedOnly.expected, MESSAGE_COUNT + TASK_COUNT);
          assert.deepEqual(importedOnly.timeline, importedOnly.expected);
          assert.isAbove(importedOnly.pages[0]!.length, 1);

          yield* runOrchestratorV2Scenario({
            name: "imported-thread-history-paging",
            commands: [],
            steps: [
              {
                type: "dispatch",
                command: {
                  type: "message.dispatch",
                  createdBy: "user",
                  creationSource: "web",
                  commandId: CommandId.make("command:imported:continue"),
                  threadId,
                  messageId: MessageId.make("message:imported:continue"),
                  text: "Continue on V2.",
                  attachments: [],
                  dispatchMode: { type: "start_immediately" },
                },
              },
              { type: "await_thread_idle", threadId },
            ],
          });

          const { pages, timeline, expected } = yield* pageWholeThread(threadId);
          const imported = importedOnly.expected;
          const runRows = (yield* (yield* ProjectionStoreV2).getThreadProjection(
            threadId,
          )).visibleTurnItems.filter((row) => row.item.runId !== null);
          assert.isNotEmpty(runRows);
          assert.isTrue(runRows.every((row) => row.item.ordinal > 1_000_000));
          assert.deepEqual(expected.slice(0, imported.length), imported);

          // The first page opens on the V2 turn and the newest imported rows,
          // not on one row of it.
          const firstPage = pages[0]!.map(itemKey);
          for (const row of runRows) assert.include(firstPage, itemKey(row));
          assert.isAbove(pages[0]!.length, runRows.length);
          assert.include(firstPage, imported.at(-1));

          // Load earlier reaches the first imported message; nothing skipped or twice.
          assert.equal(new Set(timeline).size, timeline.length);
          assert.deepEqual(timeline, expected);
        }).pipe(Effect.provide(Layer.mergeAll(TestLayer, runtime)));
      }),
    ),
  120_000,
);

/**
 * 90 completed commands with one tool node each and no task records, sized so
 * the 1 MiB budget falls between 69 and 70 rows.
 */
const taskFreeProjection = () => {
  const threadId = ThreadId.make("task-free");
  const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
  const nodes = Array.from({ length: 90 }, (_, index): OrchestrationV2ExecutionNode => ({
    id: NodeId.make(`node-${index}`),
    threadId,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make(`node-${index}`),
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
  }));
  const rows = nodes.map((node, index): OrchestrationV2ProjectedTurnItem => {
    const id = TurnItemId.make(`item-${index}`);
    return {
      position: index,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: id,
      item: {
        id,
        type: "command_execution",
        threadId,
        runId: null,
        nodeId: node.id,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index + 1,
        status: "completed",
        title: `Command ${index}`,
        input: `cmd-${index}`,
        output: "x".repeat(6_850),
        exitCode: 0,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      },
    };
  });
  return {
    thread: {
      id: threadId,
      projectId: "project-1",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
    },
    runs: [],
    attempts: [],
    nodes,
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: rows.map((row) => row.item),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: rows,
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
};

it("pages a thread without task records exactly as upstream does", () => {
  const projection = taskFreeProjection();
  const first = buildBoundedThreadProjection({ projection, snapshotSequence: 1 });
  const older = selectHistoryPageFromCursor({
    items: projection.visibleTurnItems,
    cursor: first.historyCursor!,
    snapshotSequence: 1,
  });
  const ordinals = (rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) =>
    rows.map((row) => row.item.ordinal);
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => from + index);

  // Upstream 977bf4a4 opens on ordinals 22..90 and loads 1..21 earlier.
  assert.isFalse(first.payloadBudgetExceeded);
  assert.isTrue(first.hasMoreHistory);
  assert.deepEqual(ordinals(first.projection.visibleTurnItems), range(22, 90));
  assert.deepEqual(ordinals(older.items), range(1, 21));
  assert.isNull(older.nextCursor);
  assert.isFalse(older.hasMoreHistory);
});
