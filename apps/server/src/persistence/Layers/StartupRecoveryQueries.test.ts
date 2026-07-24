import { CommandId, MessageId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProviderSessionRuntime from "../ProviderSessionRuntime.ts";
import { OrchestrationCommandReceiptRepository } from "../Services/OrchestrationCommandReceipts.ts";
import { ProjectionThreadSessionRepository } from "../Services/ProjectionThreadSessions.ts";
import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./OrchestrationCommandReceipts.ts";
import { ProjectionThreadSessionRepositoryLive } from "./ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "./ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const recoveryQueryLayer = it.layer(
  Layer.mergeAll(
    ProviderSessionRuntime.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    OrchestrationCommandReceiptRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadSessionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionTurnRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

recoveryQueryLayer("startup recovery repository queries", (it) => {
  it.effect("selects only active runtime bindings, projected work, and undelivered starts", () =>
    Effect.gen(function* () {
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sessions = yield* ProjectionThreadSessionRepository;
      const turns = yield* ProjectionTurnRepository;
      const instanceId = ProviderInstanceId.make("kimi");
      const activeThreadId = ThreadId.make("thread-active");
      const stoppedThreadId = ThreadId.make("thread-stopped");
      const partialThreadId = ThreadId.make("thread-partial");
      const activeTurnId = TurnId.make("turn-active");

      yield* runtimes.upsert({
        threadId: activeThreadId,
        providerName: "kimi",
        providerInstanceId: instanceId,
        adapterKey: "kimi",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-07-23T10:00:00.000Z",
        resumeCursor: { sessionId: "resume-active" },
        runtimePayload: { activeTurnId },
      });
      yield* runtimes.upsert({
        threadId: stoppedThreadId,
        providerName: "kimi",
        providerInstanceId: instanceId,
        adapterKey: "kimi",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: "2026-07-23T10:01:00.000Z",
        resumeCursor: null,
        runtimePayload: { activeTurnId: null },
      });

      yield* sessions.upsert({
        threadId: activeThreadId,
        status: "running",
        providerName: "kimi",
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
        activeTurnId,
        lastError: null,
        recovery: null,
        updatedAt: "2026-07-23T10:00:00.000Z",
      });
      yield* sessions.upsert({
        threadId: stoppedThreadId,
        status: "stopped",
        providerName: "kimi",
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        recovery: null,
        updatedAt: "2026-07-23T10:01:00.000Z",
      });
      yield* sessions.upsert({
        threadId: partialThreadId,
        status: "ready",
        providerName: "kimi",
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
        activeTurnId: TurnId.make("turn-partial"),
        lastError: null,
        recovery: null,
        updatedAt: "2026-07-23T10:02:00.000Z",
      });

      yield* turns.replacePendingTurnStart({
        threadId: activeThreadId,
        messageId: MessageId.make("message-pending"),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt: "2026-07-23T10:03:00.000Z",
      });
      yield* turns.upsertByTurnId({
        threadId: activeThreadId,
        turnId: activeTurnId,
        pendingMessageId: MessageId.make("message-delivered"),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "running",
        requestedAt: "2026-07-23T10:00:00.000Z",
        startedAt: "2026-07-23T10:00:01.000Z",
        completedAt: null,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });
      yield* turns.upsertByTurnId({
        threadId: stoppedThreadId,
        turnId: TurnId.make("turn-completed"),
        pendingMessageId: null,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "completed",
        requestedAt: "2026-07-23T09:00:00.000Z",
        startedAt: "2026-07-23T09:00:01.000Z",
        completedAt: "2026-07-23T09:01:00.000Z",
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });

      assert.deepStrictEqual(
        (yield* runtimes.listActive()).map((row) => row.threadId),
        [activeThreadId],
      );
      assert.deepStrictEqual(
        (yield* sessions.listActive()).map((row) => row.threadId),
        [activeThreadId, partialThreadId],
      );
      assert.deepStrictEqual(
        (yield* turns.listPendingTurnStarts()).map((row) => row.messageId),
        [MessageId.make("message-pending")],
      );
      assert.deepStrictEqual(
        (yield* turns.listRunningTurns()).map((row) => row.turnId),
        [activeTurnId],
      );
    }),
  );

  it.effect("atomically claims a recovery command receipt once", () =>
    Effect.gen(function* () {
      const receipts = yield* OrchestrationCommandReceiptRepository;
      const receipt = {
        commandId: CommandId.make("server:startup-recovery:pending-claim:test"),
        aggregateKind: "thread" as const,
        aggregateId: ThreadId.make("thread-recovery-receipt"),
        acceptedAt: "2026-07-23T10:00:00.000Z",
        resultSequence: 0,
        status: "accepted" as const,
        error: null,
      };

      assert.strictEqual(yield* receipts.tryInsert(receipt), true);
      assert.strictEqual(yield* receipts.tryInsert(receipt), false);
      assert.strictEqual(
        Option.getOrThrow(yield* receipts.getByCommandId({ commandId: receipt.commandId })).status,
        "accepted",
      );
    }),
  );

  it.effect("skips undecodable active recovery rows without hiding valid work", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* ProjectionThreadSessionRepository;
      const turns = yield* ProjectionTurnRepository;
      const validThreadId = ThreadId.make("thread-valid-recovery-row");
      const corruptThreadId = ThreadId.make("thread-corrupt-recovery-row");
      const validTurnId = TurnId.make("turn-valid-recovery-row");

      yield* sessions.upsert({
        threadId: validThreadId,
        status: "running",
        providerName: "kimi",
        providerInstanceId: ProviderInstanceId.make("kimi"),
        runtimeMode: "full-access",
        activeTurnId: validTurnId,
        lastError: null,
        recovery: null,
        updatedAt: "2026-07-23T10:00:00.000Z",
      });
      yield* turns.upsertByTurnId({
        threadId: validThreadId,
        turnId: validTurnId,
        pendingMessageId: null,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "running",
        requestedAt: "2026-07-23T10:00:00.000Z",
        startedAt: "2026-07-23T10:00:01.000Z",
        completedAt: null,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_instance_id, runtime_mode,
          active_turn_id, last_error, recovery_json, updated_at
        ) VALUES (
          ${corruptThreadId}, 'running', 'kimi', 'kimi', 'full-access',
          NULL, NULL, '{', '2026-07-23T10:00:02.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id,
          source_proposed_plan_id, assistant_message_id, state, requested_at,
          started_at, completed_at, checkpoint_turn_count, checkpoint_ref,
          checkpoint_status, checkpoint_files_json
        ) VALUES (
          ${corruptThreadId}, 'turn-corrupt-recovery-row', NULL, NULL,
          NULL, NULL, 'running', '2026-07-23T10:00:02.000Z',
          NULL, NULL, NULL, NULL, NULL, '{'
        )
      `;

      const activeSessionIds = (yield* sessions.listActive()).map((row) => row.threadId);
      assert.include(activeSessionIds, validThreadId);
      assert.notInclude(activeSessionIds, corruptThreadId);

      const runningTurnIds = (yield* turns.listRunningTurns()).map((row) => row.turnId);
      assert.include(runningTurnIds, validTurnId);
      assert.notInclude(runningTurnIds, TurnId.make("turn-corrupt-recovery-row"));
    }),
  );
});
