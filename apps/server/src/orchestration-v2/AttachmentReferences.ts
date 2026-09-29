import {
  ChatAttachment,
  CommandId,
  ThreadId,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { attachmentRelativePath, parseThreadSegmentFromAttachmentId } from "../attachmentStore.ts";
import { normalizeAttachmentRelativePath } from "../attachmentPaths.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

const isAttachment = Schema.is(ChatAttachment);
const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function attachmentReferences(payload: unknown): Array<{ id: string; relativePath: string }> {
  if (isAttachment(payload)) {
    const relativePath = attachmentRelativePath(payload);
    return relativePath === null ||
      normalizeAttachmentRelativePath(relativePath) !== relativePath ||
      relativePath.includes("/")
      ? []
      : [{ id: payload.id, relativePath }];
  }
  if (Array.isArray(payload)) return payload.flatMap(attachmentReferences);
  return Predicate.isObject(payload) ? Object.values(payload).flatMap(attachmentReferences) : [];
}

/** Include legacy metadata only until its transcript has been hydrated into V2. */
const referencedAttachments = Effect.fnUntraced(function* (threadId?: string) {
  const sql = yield* SqlClient.SqlClient;
  return sql`
    SELECT message.thread_id, json_extract(message.payload_json, '$.attachments') AS payload_json
    FROM orchestration_v2_projection_messages AS message
    WHERE ${threadId === undefined ? sql`1` : sql`message.thread_id = ${threadId}`}
    UNION ALL
    SELECT item.thread_id, json_object(
      'attachments', json_extract(item.payload_json, '$.attachments'),
      'answers', json_extract(item.payload_json, '$.questionAnswer.attachmentsByQuestionId')
    ) AS payload_json
    FROM orchestration_v2_projection_turn_items AS item
    WHERE ${threadId === undefined ? sql`1` : sql`item.thread_id = ${threadId}`}
    UNION ALL
    SELECT message.thread_id, message.attachments_json AS payload_json
    FROM projection_thread_messages AS message
    LEFT JOIN orchestration_v2_legacy_imports AS imported ON imported.thread_id = message.thread_id
    WHERE imported.transcript_imported_at IS NULL
      AND message.attachments_json IS NOT NULL
      AND ${threadId === undefined ? sql`1` : sql`message.thread_id = ${threadId}`}
  `;
});

// The mint RPC requires environment-wide orchestration read scope. Every live
// thread in that environment is readable; a requested thread must own the exact reference.
const lookupReadableAttachment = Effect.fnUntraced(function* (
  attachmentId: string,
  threadId?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const payloads = yield* referencedAttachments(threadId);
  const rows = yield* sql<{ thread_id: string; attachment_json: string }>`
      SELECT DISTINCT payload.thread_id, attachment.value AS attachment_json
      FROM (${payloads}) AS payload
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = payload.thread_id
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      JOIN json_tree(payload.payload_json) AS attachment
      WHERE thread.deleted_at IS NULL AND project.deleted_at IS NULL
        AND attachment.type = 'object'
        AND json_extract(attachment.value, '$.type') IN ('image', 'file')
        AND json_extract(attachment.value, '$.id') = ${attachmentId}
      ORDER BY payload.thread_id
      LIMIT 1
    `;
  const row = rows[0];
  if (row === undefined) return null;
  const references = attachmentReferences(decodePayload(row.attachment_json));
  const reference = references[0];
  return reference === undefined
    ? null
    : { threadId: ThreadId.make(row.thread_id), relativePath: reference.relativePath };
});

export const findReadableAttachment = Effect.fn("findReadableAttachment")(function* (
  attachmentId: string,
  threadId?: string,
) {
  if (threadId !== undefined) return yield* lookupReadableAttachment(attachmentId, threadId);
  // A filename is only a lookup hint. The query still requires an actual reference;
  // inherited attachments may belong to another thread and use the fallback query.
  const hint = parseThreadSegmentFromAttachmentId(attachmentId);
  if (hint !== null) {
    const hinted = yield* lookupReadableAttachment(attachmentId, hint);
    if (hinted !== null) return hinted;
  }
  return yield* lookupReadableAttachment(attachmentId);
});

export const isAttachmentPathReferenced = Effect.fn("isAttachmentPathReferenced")(function* (
  attachmentId: string,
  relativePath: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const payloads = yield* referencedAttachments();
  const rows = yield* sql<{ attachment_json: string }>`
      SELECT attachment.value AS attachment_json
      FROM (${payloads}) AS payload
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = payload.thread_id
      JOIN json_tree(payload.payload_json) AS attachment
      WHERE thread.deleted_at IS NULL
        AND attachment.type = 'object'
        AND json_extract(attachment.value, '$.type') IN ('image', 'file')
        AND json_extract(attachment.value, '$.id') = ${attachmentId}
    `;
  return rows.some((row) => {
    const references = attachmentReferences(decodePayload(row.attachment_json));
    // Unknown legacy metadata is a reason to retain bytes, never to guess a deletion.
    return (
      references.length === 0 ||
      references.some((reference) => reference.relativePath === relativePath)
    );
  });
});

/** Called inside EventSink's transaction so projection changes and cleanup cannot diverge. */
export const applyWithAttachmentPruning = Effect.fn("applyWithAttachmentPruning")(function* (
  stored: OrchestrationV2StoredEvent,
  apply: ReturnType<ProjectionStoreV2Shape["apply"]>,
) {
  const event = stored.event;
  if (
    event.type !== "message.updated" &&
    event.type !== "turn-item.updated" &&
    event.type !== "thread.deleted"
  ) {
    yield* apply;
    return 0;
  }
  const sql = yield* SqlClient.SqlClient;
  const oldPayloads =
    event.type === "thread.deleted"
      ? yield* sql<{ payload_json: string | null }>`
            SELECT payload_json FROM (${yield* referencedAttachments(event.threadId)})
          `
      : event.type === "message.updated"
        ? yield* sql<{ payload_json: string | null }>`
              SELECT json_extract(payload_json, '$.attachments') AS payload_json FROM orchestration_v2_projection_messages
              WHERE message_id = ${event.payload.id}
            `
        : yield* sql<{ payload_json: string | null }>`
              SELECT json_object('attachments', json_extract(payload_json, '$.attachments'),
                'answers', json_extract(payload_json, '$.questionAnswer.attachmentsByQuestionId')) AS payload_json
              FROM orchestration_v2_projection_turn_items
              WHERE turn_item_id = ${event.payload.id}
            `;
  const retained = new Set(
    event.type === "thread.deleted"
      ? []
      : attachmentReferences({
          attachments: "attachments" in event.payload ? event.payload.attachments : [],
          answers: "questionAnswer" in event.payload ? event.payload.questionAnswer : undefined,
        }).map((reference) => reference.relativePath),
  );
  const removed = new Map(
    oldPayloads.flatMap((row) =>
      attachmentReferences(row.payload_json === null ? null : decodePayload(row.payload_json))
        .filter((reference) => !retained.has(reference.relativePath))
        .map((reference) => [reference.relativePath, reference.id] as const),
    ),
  );
  yield* apply;
  if (removed.size === 0) return 0;
  const outbox = yield* EffectOutboxV2;
  yield* outbox.enqueue([
    {
      id: `effect:${event.id}:attachment.prune`,
      commandId: stored.commandId ?? CommandId.make(`attachment-prune:${event.id}`),
      threadId: event.threadId,
      request: {
        type: "attachment.cleanup",
        attachmentIds: Array.from(new Set(removed.values())),
        relativePaths: Array.from(removed.keys()),
      },
    },
  ]);
  return 1;
});
