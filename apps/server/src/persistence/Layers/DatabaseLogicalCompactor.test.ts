import { EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { stableLegacyToolActivityId } from "../../orchestration/LegacyToolActivityIdentity.ts";
import { DatabaseLogicalCompactor } from "../Services/DatabaseLogicalCompactor.ts";
import { DatabaseLogicalCompactorLive } from "./DatabaseLogicalCompactor.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const compactorLayer = it.layer(
  Layer.mergeAll(
    DatabaseLogicalCompactorLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const encodeUnknownJson = Schema.encodeSync(Schema.UnknownFromJsonString);

const makePayload = (activityId: string, detail: string) =>
  encodeUnknownJson({
    threadId: ThreadId.make("thread-logical-compaction"),
    activity: {
      id: EventId.make(activityId),
      tone: "tool",
      kind: "tool.updated",
      summary: "Tool update",
      payload: {
        toolUseId: "tool-logical",
        itemType: "command_execution",
        status: "in_progress",
        detail,
        data: { cumulative: detail },
      },
      turnId: TurnId.make("turn-logical-compaction"),
      createdAt: "2026-07-23T10:00:00.000Z",
    },
  });

interface EventRow {
  readonly sequence: number;
  readonly eventId: string;
  readonly streamVersion: number;
  readonly commandId: string | null;
  readonly causationEventId: string | null;
  readonly correlationId: string | null;
  readonly payloadJson: string;
  readonly metadataJson: string;
}

compactorLayer("database logical event compaction", (it) => {
  it.effect("rewrites only eligible payloads below the watermark", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const compactor = yield* DatabaseLogicalCompactor;
      const oversizedPayload = makePayload("activity-before", "progress ".repeat(4_000));
      const laterPayload = makePayload("activity-after", "later ".repeat(4_000));

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES
          ('event-before', 'thread', 'thread-logical-compaction', 0,
           'thread.activity-appended', '2026-07-23T10:00:00.000Z', 'command-before',
           'causation-before', 'correlation-before', 'provider', ${oversizedPayload},
           '{"adapterKey":"kimi"}'),
          ('event-after', 'thread', 'thread-logical-compaction', 1,
           'thread.activity-appended', '2026-07-23T10:00:01.000Z', 'command-after',
           'event-before', 'correlation-after', 'provider', ${laterPayload},
           '{"adapterKey":"kimi"}')
      `;
      const beforeRows = yield* sql<EventRow>`
        SELECT
          sequence,
          event_id AS "eventId",
          stream_version AS "streamVersion",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        ORDER BY sequence ASC
      `;

      const result = yield* compactor.compactEventBatch({
        safetyWatermark: beforeRows[0]!.sequence,
        cursor: 0,
        batchSize: 10,
      });
      const afterRows = yield* sql<EventRow>`
        SELECT
          sequence,
          event_id AS "eventId",
          stream_version AS "streamVersion",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        ORDER BY sequence ASC
      `;

      assert.strictEqual(result.rewrittenRows, 1);
      assert.isAbove(result.reclaimedBytes, 0);
      assert.strictEqual(result.done, true);
      assert.notStrictEqual(afterRows[0]!.payloadJson, oversizedPayload);
      assert.notInclude(afterRows[0]!.payloadJson, '"data"');
      assert.strictEqual(afterRows[1]!.payloadJson, laterPayload);
      assert.deepStrictEqual(
        afterRows.map(({ payloadJson: _, ...identity }) => identity),
        beforeRows.map(({ payloadJson: _, ...identity }) => identity),
      );
    }),
  );

  it.effect("deletes only superseded legacy tool projection progress", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const compactor = yield* DatabaseLogicalCompactor;
      const progressPayload = (status: string, marker: string) =>
        encodeUnknownJson({
          toolUseId: "tool-projection",
          status,
          data: `${marker}-${"payload ".repeat(1_000)}`,
        });
      const malformedIdentityPayload = encodeUnknownJson({
        toolUseId: "tool-a",
        itemId: "tool-b",
        status: "in_progress",
        data: "must remain",
      });

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          ('projection-progress-1', 'thread-projection', 'turn-projection', 'tool',
           'tool.updated', 'Progress 1', ${progressPayload("in_progress", "first")},
           10, '2026-07-23T10:00:00.000Z'),
          ('projection-progress-2', 'thread-projection', 'turn-projection', 'tool',
           'tool.updated', 'Progress 2', ${progressPayload("in_progress", "second")},
           11, '2026-07-23T10:00:01.000Z'),
          ('projection-terminal', 'thread-projection', 'turn-projection', 'tool',
           'tool.updated', 'Completed', ${progressPayload("completed", "terminal")},
           12, '2026-07-23T10:00:02.000Z'),
          ('projection-malformed', 'thread-projection', 'turn-projection', 'tool',
           'tool.updated', 'Ambiguous', ${malformedIdentityPayload},
           13, '2026-07-23T10:00:03.000Z'),
          ('projection-later', 'thread-projection', 'turn-projection', 'tool',
           'tool.updated', 'Later', ${progressPayload("in_progress", "later")},
           99, '2026-07-23T10:00:04.000Z'),
          ('projection-message', 'thread-projection', 'turn-projection', 'info',
           'message.created', 'Message', '{"text":"preserve"}',
           14, '2026-07-23T10:00:05.000Z')
      `;

      const result = yield* compactor.compactProjectionBatch({
        safetyWatermark: 20,
        cursor: 0,
        batchSize: 20,
      });
      const rows = yield* sql<{ readonly activityId: string }>`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE thread_id = 'thread-projection'
        ORDER BY sequence ASC
      `;

      assert.strictEqual(result.deletedRows, 2);
      assert.strictEqual(result.skippedRows, 2);
      assert.isAbove(result.reclaimedBytes, 0);
      assert.deepStrictEqual(
        rows.map((row) => row.activityId),
        [
          stableLegacyToolActivityId("thread-projection", "turn-projection", "tool-projection"),
          "projection-malformed",
          "projection-message",
          "projection-later",
        ],
      );
    }),
  );

  it.effect("does not merge identical legacy tool ids from different provider instances", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const compactor = yield* DatabaseLogicalCompactor;
      const payload = (providerInstanceId: string) =>
        encodeUnknownJson({
          provider: "kimi",
          providerInstanceId,
          toolUseId: "shared-tool-id",
          status: "in_progress",
          detail: "progress ".repeat(1_000),
        });

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          ('provider-a-progress', 'multi-provider-thread', 'shared-turn', 'tool',
           'tool.updated', 'Provider A', ${payload("kimi-a")},
           10, '2026-07-23T10:00:00.000Z'),
          ('provider-b-progress', 'multi-provider-thread', 'shared-turn', 'tool',
           'tool.updated', 'Provider B', ${payload("kimi-b")},
           11, '2026-07-23T10:00:01.000Z')
      `;

      const result = yield* compactor.compactProjectionBatch({
        safetyWatermark: 20,
        cursor: 0,
        batchSize: 20,
      });
      const rows = yield* sql<{ readonly activityId: string }>`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE thread_id = 'multi-provider-thread'
        ORDER BY sequence ASC
      `;

      assert.strictEqual(result.deletedRows, 0);
      assert.deepStrictEqual(
        rows.map((row) => row.activityId),
        [
          stableLegacyToolActivityId(
            "multi-provider-thread",
            "shared-turn",
            "shared-tool-id",
            "kimi-a",
          ),
          stableLegacyToolActivityId(
            "multi-provider-thread",
            "shared-turn",
            "shared-tool-id",
            "kimi-b",
          ),
        ],
      );
    }),
  );
});
