import {
  CommandId,
  CorrelationId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";

import { createEmptyReadModel, projectEvent } from "../../orchestration/projector.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { DatabaseCompactionJournalRepositoryLive } from "./DatabaseCompactionJournal.ts";
import { DatabaseCompactionEstimatorLive } from "./DatabaseCompactionEstimator.ts";
import { DatabaseLogicalCompactionLive } from "./DatabaseLogicalCompaction.ts";
import { DatabaseLogicalCompactorLive } from "./DatabaseLogicalCompactor.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { DatabaseLogicalCompaction } from "../Services/DatabaseLogicalCompaction.ts";
import {
  DATABASE_COMPACTION_JOURNAL_ID,
  DatabaseCompactionJournalRepository,
} from "../Services/DatabaseCompactionJournal.ts";

const dependencies = Layer.mergeAll(
  DatabaseCompactionJournalRepositoryLive,
  DatabaseCompactionEstimatorLive,
  DatabaseLogicalCompactorLive,
  OrchestrationEventStoreLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const logicalCompactionLayer = it.layer(
  Layer.mergeAll(
    DatabaseLogicalCompactionLive.pipe(Layer.provideMerge(dependencies)),
    dependencies,
  ),
);

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const resetCompactionFixtures = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM orchestration_command_receipts`;
  yield* sql`DELETE FROM projection_thread_activities`;
  yield* sql`DELETE FROM orchestration_events`;
  yield* sql`DELETE FROM projection_state`;
  yield* sql`DELETE FROM database_compaction_journal`;
});

const eventPayload = (activityId: string, toolUseId: string) =>
  encodeUnknownJson({
    threadId: ThreadId.make("thread-resume"),
    activity: {
      id: EventId.make(activityId),
      tone: "tool",
      kind: "tool.updated",
      summary: "Tool update",
      payload: {
        toolUseId,
        status: "in_progress",
        detail: "progress ".repeat(2_000),
        data: "cumulative ".repeat(2_000),
      },
      turnId: TurnId.make("turn-resume"),
      createdAt: "2026-07-23T10:00:00.000Z",
    },
  });

logicalCompactionLayer("resumable database logical compaction", (it) => {
  it.effect("checkpoints every batch, resumes, and becomes idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* DatabaseLogicalCompaction;
      yield* resetCompactionFixtures;
      const firstPayload = eventPayload("activity-resume-1", "tool-resume");
      const secondPayload = eventPayload("activity-resume-2", "tool-resume");

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('thread-activities', 2, '2026-07-23T10:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES
          ('event-resume-1', 'thread', 'thread-resume', 0, 'thread.activity-appended',
           '2026-07-23T10:00:00.000Z', 'command-resume-1', NULL, NULL, 'provider',
           ${firstPayload}, '{}'),
          ('event-resume-2', 'thread', 'thread-resume', 1, 'thread.activity-appended',
           '2026-07-23T10:00:01.000Z', 'command-resume-2', 'event-resume-1', NULL,
           'provider', ${secondPayload}, '{}')
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          ('projection-resume-1', 'thread-resume', 'turn-resume', 'tool', 'tool.updated',
           'First', ${encodeUnknownJson({
             toolUseId: "tool-resume",
             status: "in_progress",
             data: "first ".repeat(2_000),
           })}, 1, '2026-07-23T10:00:00.000Z'),
          ('projection-resume-2', 'thread-resume', 'turn-resume', 'tool', 'tool.updated',
           'Second', ${encodeUnknownJson({
             toolUseId: "tool-resume",
             status: "in_progress",
             data: "second ".repeat(2_000),
           })}, 2, '2026-07-23T10:00:01.000Z')
      `;

      const firstBatch = yield* maintenance.runNextBatch({ batchSize: 1 });
      assert.strictEqual(firstBatch.phase, "logical-compaction");
      assert.strictEqual(firstBatch.processedEventCount, 1);
      assert.isAbove(firstBatch.logicalBytesReclaimed, 0);

      let resumed = yield* maintenance.runNextBatch({ batchSize: 1 });
      while (resumed.phase === "logical-compaction") {
        resumed = yield* maintenance.runNextBatch({ batchSize: 1 });
      }
      assert.strictEqual(resumed.phase, "awaiting-restart");
      assert.strictEqual(resumed.processedEventCount, 2);
      assert.strictEqual(resumed.eligibleEventCount, 2);
      assert.strictEqual(resumed.eligibleProjectionCount, 1);
      assert.strictEqual(resumed.skippedEventCount, 0);

      const persistedRows = yield* sql<{
        readonly eventId: string;
        readonly payloadJson: string;
      }>`
        SELECT event_id AS "eventId", payload_json AS "payloadJson"
        FROM orchestration_events
        ORDER BY sequence ASC
      `;
      const rowsAfterRerun = yield* maintenance.run();
      const rerunPayloads = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_events
        ORDER BY sequence ASC
      `;

      assert.deepStrictEqual(
        rerunPayloads.map((row) => row.payloadJson),
        persistedRows.map((row) => row.payloadJson),
      );
      assert.deepStrictEqual(rowsAfterRerun, resumed);
    }),
  );

  it.effect("starts a fresh journal when new eligible history arrives after completion", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* DatabaseLogicalCompaction;
      const journals = yield* DatabaseCompactionJournalRepository;
      yield* resetCompactionFixtures;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('thread-activities', 1000000, '2026-07-23T10:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-repeat-1', 'thread', 'thread-repeat', 0, 'thread.activity-appended',
          '2026-07-23T10:00:00.000Z', 'command-repeat-1', NULL, NULL, 'provider',
          ${eventPayload("activity-repeat-1", "tool-repeat")}, '{}'
        )
      `;

      const first = yield* maintenance.run();
      yield* journals.upsert({
        ...first,
        phase: "completed",
        terminalOutcome: {
          beforeBytes: first.physicalBytesBefore ?? 0,
          afterBytes: first.physicalBytesBefore ?? 0,
          reclaimedBytes: 0,
          completedAt: "2026-07-23T10:01:00.000Z",
          rollbackRetained: false,
        },
        updatedAt: "2026-07-23T10:01:00.000Z",
      });

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-repeat-2', 'thread', 'thread-repeat', 1, 'thread.activity-appended',
          '2026-07-23T10:02:00.000Z', 'command-repeat-2', 'event-repeat-1', NULL, 'provider',
          ${eventPayload("activity-repeat-2", "tool-repeat")}, '{}'
        )
      `;
      yield* sql`
        UPDATE projection_state
        SET last_applied_sequence = 1000000, updated_at = '2026-07-23T10:02:00.000Z'
        WHERE projector = 'thread-activities'
      `;

      const repeated = yield* maintenance.run();
      const persisted = yield* journals.get({ journalId: DATABASE_COMPACTION_JOURNAL_ID });

      assert.strictEqual(repeated.phase, "awaiting-restart");
      assert.strictEqual(repeated.eligibleEventCount, 1);
      assert.isTrue(Option.isSome(persisted));
      assert.strictEqual(Option.getOrThrow(persisted).terminalOutcome, null);
    }),
  );

  it.effect("preserves stream invariants and full replay across large interrupted history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const eventStore = yield* OrchestrationEventStore;
      const maintenance = yield* DatabaseLogicalCompaction;
      yield* resetCompactionFixtures;
      const threadId = ThreadId.make("thread-large-compaction");
      const turnId = TurnId.make("turn-large-compaction");
      const occurredAt = "2026-07-23T11:00:00.000Z";
      const historySize = 260;

      const threadCreated = yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("event-large-thread-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt,
        commandId: CommandId.make("command-large-thread-created"),
        causationEventId: null,
        correlationId: CorrelationId.make("command-large-thread-created"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-large-compaction"),
          title: "Large compaction",
          modelSelection: {
            instanceId: ProviderInstanceId.make("kimi"),
            model: "kimi-for-coding",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      });

      let causationEventId = threadCreated.eventId;
      let lastCompactedSequence = threadCreated.sequence;
      for (let index = 0; index < historySize; index += 1) {
        const missingIdentity = index === 130;
        const event = yield* eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make(`event-large-activity-${index}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: CommandId.make(`command-large-activity-${index}`),
          causationEventId,
          correlationId: CorrelationId.make("command-large-thread-created"),
          metadata: { adapterKey: "kimi" },
          payload: {
            threadId,
            activity: {
              id: EventId.make(`activity-large-${index}`),
              tone: "tool",
              kind: "tool.updated",
              summary: "Large tool update",
              payload: {
                ...(missingIdentity ? {} : { toolUseId: "tool-large" }),
                status: index === historySize - 1 ? "completed" : "in_progress",
                detail: `detail-${index}-${"progress ".repeat(800)}`,
                data: `cumulative-${index}-${"payload ".repeat(800)}`,
              },
              turnId,
              createdAt: occurredAt,
            },
          },
        });
        causationEventId = event.eventId;
        lastCompactedSequence = event.sequence;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary,
            payload_json, sequence, created_at
          )
          VALUES (
            ${`activity-large-${index}`},
            ${threadId},
            ${turnId},
            'tool',
            'tool.updated',
            'Large tool update',
            ${encodeUnknownJson({
              ...(missingIdentity ? {} : { toolUseId: "tool-large" }),
              status: index === historySize - 1 ? "completed" : "in_progress",
              detail: `detail-${index}-${"progress ".repeat(800)}`,
              data: `cumulative-${index}-${"payload ".repeat(800)}`,
            })},
            ${event.sequence},
            ${occurredAt}
          )
        `;
      }
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('thread-activities', ${lastCompactedSequence}, ${occurredAt})
      `;
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at,
          result_sequence, status, error
        )
        VALUES (
          'command-large-receipt', 'thread', ${threadId}, ${occurredAt},
          ${lastCompactedSequence}, 'accepted', NULL
        )
      `;

      const beforeHead = yield* sql<{
        readonly headVersion: number;
        readonly eventCount: number;
      }>`
        SELECT
          MAX(stream_version) AS "headVersion",
          COUNT(*) AS "eventCount"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
      `;
      const firstBatch = yield* maintenance.runNextBatch({ batchSize: 25 });
      assert.strictEqual(firstBatch.safetyWatermark, lastCompactedSequence);

      const laterActivityPayload = {
        toolUseId: "tool-large",
        status: "in_progress",
        detail: "later",
        data: "later payload must remain",
      };
      const laterPayloadValue = {
        threadId,
        activity: {
          id: EventId.make("activity-large-later"),
          tone: "tool" as const,
          kind: "tool.updated",
          summary: "Tool update",
          payload: laterActivityPayload,
          turnId,
          createdAt: occurredAt,
        },
      };
      const laterPayload = encodeUnknownJson(laterPayloadValue);
      const laterEvent = yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.make("event-large-later"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt,
        commandId: CommandId.make("command-large-later"),
        causationEventId,
        correlationId: CorrelationId.make("command-large-thread-created"),
        metadata: { adapterKey: "kimi" },
        payload: laterPayloadValue,
      });
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, created_at
        )
        VALUES (
          'activity-large-later', ${threadId}, ${turnId}, 'tool', 'tool.updated',
          'Tool update',
          ${encodeUnknownJson(laterActivityPayload)},
          ${laterEvent.sequence},
          ${occurredAt}
        )
      `;

      let completed = yield* maintenance.runNextBatch({ batchSize: 25 });
      while (completed.phase === "logical-compaction") {
        completed = yield* maintenance.runNextBatch({ batchSize: 25 });
      }
      assert.strictEqual(completed.phase, "awaiting-restart");
      assert.strictEqual(completed.eligibleEventCount, historySize - 1);
      assert.strictEqual(completed.skippedEventCount, 1);
      assert.isAtLeast(completed.processedEventCount, historySize);
      assert.isAbove(completed.logicalBytesReclaimed, 0);

      const afterHead = yield* sql<{
        readonly headVersion: number;
        readonly eventCount: number;
      }>`
        SELECT
          MAX(stream_version) AS "headVersion",
          COUNT(*) AS "eventCount"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
      `;
      assert.deepStrictEqual(afterHead[0], {
        headVersion: beforeHead[0]!.headVersion + 1,
        eventCount: beforeHead[0]!.eventCount + 1,
      });
      const [receipt] = yield* sql<{
        readonly resultSequence: number;
        readonly status: string;
      }>`
        SELECT result_sequence AS "resultSequence", status
        FROM orchestration_command_receipts
        WHERE command_id = 'command-large-receipt'
      `;
      assert.deepStrictEqual(receipt, {
        resultSequence: lastCompactedSequence,
        status: "accepted",
      });
      const [causation] = yield* sql<{ readonly causationEventId: string | null }>`
        SELECT causation_event_id AS "causationEventId"
        FROM orchestration_events
        WHERE event_id = 'event-large-activity-259'
      `;
      assert.strictEqual(causation?.causationEventId, "event-large-activity-258");
      const [laterPersisted] = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE event_id = 'event-large-later'
      `;
      assert.strictEqual(laterPersisted?.payloadJson, laterPayload);

      const replayEvents = Array.from(yield* Stream.runCollect(eventStore.readAll()));
      let replay = createEmptyReadModel(occurredAt);
      for (const event of replayEvents) {
        replay = yield* projectEvent(replay, event);
      }
      const replayActivities = replay.threads[0]?.activities ?? [];
      type ComparableActivity = {
        readonly id: string;
        readonly tone: string;
        readonly kind: string;
        readonly summary: string;
        readonly payload: unknown;
        readonly turnId: string | null;
        readonly sequence: number | null;
        readonly createdAt: string;
      };
      const projectedActivities = yield* sql<{
        readonly id: string;
        readonly tone: string;
        readonly kind: string;
        readonly summary: string;
        readonly payloadJson: string;
        readonly turnId: string | null;
        readonly sequence: number;
        readonly createdAt: string;
      }>`
        SELECT
          activity_id AS id,
          tone,
          kind,
          summary,
          payload_json AS "payloadJson",
          turn_id AS "turnId",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY sequence ASC, activity_id ASC
      `;
      const projectedReplayView: ComparableActivity[] = projectedActivities.map((activity) => ({
        id: activity.id,
        tone: activity.tone,
        kind: activity.kind,
        summary: activity.summary,
        payload: decodeUnknownJson(activity.payloadJson),
        turnId: activity.turnId,
        sequence: activity.sequence,
        createdAt: activity.createdAt,
      }));
      const eventReplayView: ComparableActivity[] = Array.from(replayActivities, (activity) => ({
        id: activity.id,
        tone: activity.tone,
        kind: activity.kind,
        summary: activity.summary,
        payload: activity.payload,
        turnId: activity.turnId,
        sequence: activity.sequence ?? null,
        createdAt: activity.createdAt,
      }));
      assert.deepStrictEqual(projectedReplayView, eventReplayView);

      const payloadsBeforeRerun = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_events
        ORDER BY sequence ASC
      `;
      const rerun = yield* maintenance.run();
      const payloadsAfterRerun = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_events
        ORDER BY sequence ASC
      `;
      assert.deepStrictEqual(rerun, completed);
      assert.deepStrictEqual(payloadsAfterRerun, payloadsBeforeRerun);
    }),
  );
});
