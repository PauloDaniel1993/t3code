import { EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DatabaseCompactionEstimator } from "../Services/DatabaseCompactionEstimator.ts";
import { DatabaseCompactionEstimatorLive } from "./DatabaseCompactionEstimator.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const estimatorLayer = it.layer(
  Layer.mergeAll(
    DatabaseCompactionEstimatorLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const activityEnvelope = ({
  activityId,
  detail,
  status,
}: {
  readonly activityId: string;
  readonly detail: string;
  readonly status: string;
}) =>
  encodeUnknownJson({
    threadId: ThreadId.make("thread-estimate"),
    activity: {
      id: EventId.make(activityId),
      tone: "tool",
      kind: "tool.updated",
      summary: "Tool update",
      payload: {
        toolUseId: "tool-1",
        status,
        detail,
        data: { cumulative: detail },
      },
      turnId: TurnId.make("turn-estimate"),
      createdAt: "2026-07-23T10:00:00.000Z",
    },
  });

estimatorLayer("database compaction estimator", (it) => {
  it.effect("reports bounded aggregate savings and generic active-work blockers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const estimator = yield* DatabaseCompactionEstimator;
      const largeDetail = "progress ".repeat(2_000);
      const firstPayload = activityEnvelope({
        activityId: "activity-1",
        detail: largeDetail,
        status: "in_progress",
      });
      const secondPayload = activityEnvelope({
        activityId: "activity-2",
        detail: largeDetail,
        status: "in_progress",
      });
      const terminalPayload = activityEnvelope({
        activityId: "activity-3",
        detail: largeDetail,
        status: "completed",
      });

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          ('thread-activities', 2, '2026-07-23T10:00:00.000Z'),
          ('thread-state', 3, '2026-07-23T10:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES
          ('event-1', 'thread', 'thread-estimate', 0, 'thread.activity-appended',
           '2026-07-23T10:00:00.000Z', 'command-1', NULL, NULL, 'provider',
           ${firstPayload}, '{}'),
          ('event-2', 'thread', 'thread-estimate', 1, 'thread.activity-appended',
           '2026-07-23T10:00:01.000Z', 'command-2', 'event-1', NULL, 'provider',
           ${secondPayload}, '{}'),
          ('event-after-watermark', 'thread', 'thread-estimate', 2,
           'thread.activity-appended', '2026-07-23T10:00:02.000Z', 'command-3',
           'event-2', NULL, 'provider', ${terminalPayload}, '{}')
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          ('activity-1', 'thread-estimate', 'turn-estimate', 'tool', 'tool.updated',
           'Tool update', ${encodeUnknownJson({
             toolUseId: "tool-1",
             status: "in_progress",
             data: largeDetail,
           })}, 1, '2026-07-23T10:00:00.000Z'),
          ('activity-2', 'thread-estimate', 'turn-estimate', 'tool', 'tool.updated',
           'Tool update', ${encodeUnknownJson({
             toolUseId: "tool-1",
             status: "in_progress",
             data: largeDetail,
           })}, 2, '2026-07-23T10:00:01.000Z'),
          ('activity-3', 'thread-estimate', 'turn-estimate', 'tool', 'tool.updated',
           'Tool update', ${encodeUnknownJson({
             toolUseId: "tool-1",
             status: "completed",
             data: largeDetail,
           })}, 3, '2026-07-23T10:00:02.000Z'),
          ('activity-null-sequence', 'thread-estimate', 'turn-estimate', 'tool', 'tool.updated',
           'Tool update', ${encodeUnknownJson({
             toolUseId: "tool-1",
             status: "in_progress",
             data: largeDetail,
           })}, NULL, '2026-07-23T10:00:03.000Z')
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, assistant_message_id, state,
          requested_at, started_at, completed_at, checkpoint_turn_count, checkpoint_ref,
          checkpoint_status, checkpoint_files_json
        )
        VALUES (
          'thread-estimate', 'turn-estimate', NULL, NULL, 'running',
          '2026-07-23T10:00:00.000Z', '2026-07-23T10:00:01.000Z', NULL,
          NULL, NULL, NULL, '[]'
        ), (
          'thread-completed-placeholder', NULL, 'message-completed-placeholder', NULL, 'completed',
          '2026-07-23T10:00:00.000Z', NULL, '2026-07-23T10:00:01.000Z',
          NULL, NULL, NULL, '[]'
        )
      `;

      const estimate = yield* estimator.estimate();

      assert.strictEqual(estimate.safetyWatermark, 2);
      assert.strictEqual(estimate.eligibleEventCount, 2);
      assert.strictEqual(estimate.eligibleProjectionCount, 1);
      assert.isAbove(estimate.reclaimableEventPayloadBytes, 0);
      assert.isAbove(estimate.supersededProjectionBytes, 0);
      assert.deepStrictEqual(estimate.activeWorkBlockers, ["turn-work-active"]);
      assert.strictEqual("payload" in estimate, false);
      assert.isAtLeast(estimate.temporaryDiskRequiredBytes, estimate.databaseBytes);
    }),
  );
});
