import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Console from "effect/Console";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { EventId, MessageId, ThreadId, type OrchestrationV2StoredEvent } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { initializeAttachmentReferenceIndex } from "./AttachmentReferenceIndex.ts";
import {
  applyWithAttachmentPruning,
  findReadableAttachment,
  referencedAttachmentPaths,
} from "./AttachmentReferences.ts";
import { layer as outboxLayer } from "./EffectOutbox.ts";

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project', 'Test', '/test', '[]', '2026-01-01', '2026-01-01')`;
  yield* sql`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<999)
    INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    SELECT 'thread-'||i, 'project', 'Test', 'codex', 'full-access', 'default', '2026-01-01', '2026-01-01', '{}' FROM n`;
  yield* sql`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<9999)
    INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
    SELECT 'message-'||i, 'thread-'||(i/10), 'user', 0, '2026-01-01', '2026-01-01',
      json_object('text', printf('%4096s','text'), 'attachments', json_array(json_object(
        'type','image', 'id',printf('thread-%d-00000000-0000-4000-8000-%012d',i/10,i),
        'name','image.png','mimeType','image/png','sizeBytes',1))) FROM n`;
  yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
    SELECT message_id, thread_id, 1, 'user_message', 'completed', updated_at, payload_json FROM orchestration_v2_projection_messages`;
});
const testLayer = outboxLayer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);
const id = (i: number) =>
  `thread-${Math.floor(i / 10)}-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const encodeBenchmark = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("attachment reference index", () => {
  it.effect(
    "backfills once, follows direct writes and projection rebuilds, and uses indexed unknown-ID lookups",
    () =>
      Effect.gen(function* () {
        yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        for (const source of ["message", "item", "legacy"])
          for (const operation of ["insert", "update", "delete"])
            yield* sql.unsafe(`DROP TRIGGER fork_v2_attachment_${source}_${operation}`);
        yield* sql`DROP TABLE fork_v2_attachment_references`;
        yield* initializeAttachmentReferenceIndex();
        expect((yield* findReadableAttachment(id(5)))?.threadId).toBe("thread-0");
        expect(yield* findReadableAttachment(id(5), "thread-1")).toBeNull();
        expect(yield* findReadableAttachment("unknown")).toBeNull();
        const plan = yield* sql<{
          detail: string;
        }>`EXPLAIN QUERY PLAN SELECT * FROM fork_v2_attachment_references WHERE attachment_id = 'unknown'`;
        expect(plan.some((row) => row.detail.includes("fork_v2_attachment_id_idx"))).toBe(true);
        yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'message-5'`;
        yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'message-5'`;
        expect(yield* findReadableAttachment(id(5))).toBeNull();
        yield* initializeAttachmentReferenceIndex();
        expect(yield* findReadableAttachment(id(5))).toBeNull();
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "measures the reviewed scans and streaming reads against the indexed branch on 1,000 threads and 10,000 messages",
    () =>
      Effect.gen(function* () {
        yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        const payloads = sql`SELECT thread_id, json_extract(payload_json, '$.attachments') AS payload_json FROM orchestration_v2_projection_messages
      UNION ALL SELECT thread_id, json_object('attachments', json_extract(payload_json, '$.attachments'), 'answers', json_extract(payload_json, '$.questionAnswer.attachmentsByQuestionId')) FROM orchestration_v2_projection_turn_items
      UNION ALL SELECT message.thread_id, message.attachments_json FROM projection_thread_messages AS message
        LEFT JOIN orchestration_v2_legacy_imports AS imported ON imported.thread_id = message.thread_id WHERE imported.transcript_imported_at IS NULL AND message.attachments_json IS NOT NULL`;
        const oldLookup = (attachmentId: string) => sql`
      SELECT attachment.value FROM (${payloads}) AS payload
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = payload.thread_id
      JOIN json_tree(payload.payload_json) AS attachment
      WHERE thread.deleted_at IS NULL AND attachment.type = 'object'
        AND json_extract(attachment.value, '$.type') IN ('image','file')
        AND json_extract(attachment.value, '$.id') = ${attachmentId}`;
        const measure = Effect.fnUntraced(function* (
          count: number,
          operation: () => Effect.Effect<unknown, SqlError, SqlClient.SqlClient>,
        ) {
          const started = performance.now();
          for (let i = 0; i < count; i++) yield* operation();
          return (performance.now() - started) / count;
        });
        // Warm both paths before reporting per-call wall-clock cost; no timing assertion.
        yield* oldLookup("unknown");
        yield* findReadableAttachment("unknown");
        const beforeUnknownMs = yield* measure(5, () => oldLookup("unknown"));
        const afterUnknownMs = yield* measure(100, () => findReadableAttachment("unknown"));
        const ids = Array.from({ length: 10 }, (_, i) => id(i));
        const beforeCleanupMs = yield* measure(2, () =>
          Effect.forEach(ids, (value) => sql.withTransaction(oldLookup(value))),
        );
        const afterCleanupMs = yield* measure(100, () =>
          sql.withTransaction(referencedAttachmentPaths(ids)),
        );
        // The previous helper issued this read on every streaming message/item update.
        const beforeStreamingReadMs = yield* measure(
          1000,
          () =>
            sql`SELECT json_extract(payload_json, '$.attachments') FROM orchestration_v2_projection_messages WHERE message_id = 'message-5'`,
        );
        const now = yield* DateTime.now;
        const stored: OrchestrationV2StoredEvent = {
          sequence: 0,
          commandId: null,
          event: {
            id: EventId.make("stream"),
            type: "message.updated",
            threadId: ThreadId.make("thread-0"),
            occurredAt: now,
            payload: {
              id: MessageId.make("stream"),
              threadId: ThreadId.make("thread-0"),
              runId: null,
              nodeId: null,
              role: "assistant",
              createdBy: "agent",
              creationSource: "provider",
              text: "streaming",
              attachments: [],
              streaming: true,
              createdAt: now,
              updatedAt: now,
            },
          },
        };
        const started = performance.now();
        for (let i = 0; i < 1000; i++) yield* applyWithAttachmentPruning(stored, Effect.void);
        const afterStreamingHelperMs = (performance.now() - started) / 1000;
        const streamPayload =
          '{"text":"' + "x".repeat(4096) + '","attachments":[],"streaming":true}';
        yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('stream', 'thread-0', 'assistant', 1, '2026-01-01', '2026-01-01', ${streamPayload})`;
        const update = () =>
          sql`UPDATE orchestration_v2_projection_messages SET payload_json = ${streamPayload} WHERE message_id = 'stream'`;
        const afterStreamingWriteMs = yield* measure(1000, update);
        yield* sql`DROP TRIGGER fork_v2_attachment_message_update`;
        const upstreamStreamingWriteMs = yield* measure(1000, update);
        const benchmark = {
          threads: 1000,
          messages: 10000,
          items: 10000,
          beforeUnknownMs,
          afterUnknownMs,
          beforeCleanupMs,
          afterCleanupMs,
          beforeStreamingReadMs,
          afterStreamingHelperMs,
          afterStreamingWriteMs,
          upstreamStreamingWriteMs,
          addedStreamingMs:
            afterStreamingHelperMs + afterStreamingWriteMs - upstreamStreamingWriteMs,
        };
        yield* Console.info("Attachment revision benchmark", benchmark);
        const reportPath = process.env.T3_ATTACHMENT_BENCHMARK_REPORT;
        if (reportPath !== undefined)
          yield* (yield* FileSystem.FileSystem).writeFileString(
            reportPath,
            encodeBenchmark(benchmark),
          );
        expect((yield* referencedAttachmentPaths(ids)).size).toBe(10);
      }).pipe(Effect.provide(testLayer)),
  );
});
