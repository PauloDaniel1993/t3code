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

import { attachmentRelativePath } from "../attachmentStore.ts";
import { normalizeAttachmentRelativePath } from "../attachmentPaths.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { requireCompleteAttachmentReferenceIndex } from "./AttachmentReferenceIndex.ts";
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

/** Indexed candidates only: missing IDs never scan projection payloads. */
export const findReadableAttachment = Effect.fnUntraced(function* (
  attachmentId: string,
  threadId?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* requireCompleteAttachmentReferenceIndex();
      const rows = yield* sql<{ thread_id: string; attachment_json: string }>`
    SELECT reference.thread_id, reference.attachment_json
    FROM fork_v2_attachment_references AS reference
    JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = reference.thread_id
    JOIN projection_projects AS project ON project.project_id = thread.project_id
    LEFT JOIN orchestration_v2_legacy_imports AS imported ON imported.thread_id = reference.thread_id
    WHERE reference.attachment_id = ${attachmentId}
      AND json_extract(reference.attachment_json, '$.type') IN ('image', 'file')
      AND ${threadId === undefined ? sql`1` : sql`reference.thread_id = ${threadId}`}
      AND thread.deleted_at IS NULL AND project.deleted_at IS NULL
      AND (reference.source <> 'legacy' OR imported.transcript_imported_at IS NULL)
    ORDER BY reference.thread_id LIMIT 1
  `;
      const row = rows[0];
      if (row === undefined) return null;
      const reference = attachmentReferences(decodePayload(row.attachment_json))[0];
      return reference === undefined
        ? null
        : {
            threadId: ThreadId.make(row.thread_id),
            relativePath: reference.relativePath,
          };
    }),
  );
});

/** One point-index query for an entire bounded cleanup batch. */
export const referencedAttachmentPaths = Effect.fnUntraced(function* (
  attachmentIds: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  if (attachmentIds.length === 0) return new Set<string>();
  yield* requireCompleteAttachmentReferenceIndex();
  const rows = yield* sql<{ attachment_id: string; attachment_json: string }>`
    SELECT reference.attachment_id, reference.attachment_json
    FROM fork_v2_attachment_references AS reference
    LEFT JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = reference.thread_id
    LEFT JOIN orchestration_v2_legacy_imports AS imported ON imported.thread_id = reference.thread_id
    WHERE ${sql.in("reference.attachment_id", [...attachmentIds, "*"])} AND thread.deleted_at IS NULL
      AND (reference.source <> 'legacy' OR imported.transcript_imported_at IS NULL)
  `;
  const retained = new Set<string>();
  for (const row of rows) {
    const references = attachmentReferences(decodePayload(row.attachment_json));
    // Malformed legacy metadata retains all formats for this ID.
    if (references.length === 0) retained.add(row.attachment_id);
    for (const reference of references) retained.add(reference.relativePath);
  }
  return retained;
});

/** Called inside EventSink's transaction so projection changes and cleanup cannot diverge. */
export const applyWithAttachmentPruning = Effect.fnUntraced(function* (
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
  // Streaming messages with no attachments and non-message items cannot drop paths.
  if (
    event.type === "message.updated" &&
    event.payload.streaming &&
    event.payload.attachments.length === 0
  ) {
    yield* apply;
    return 0;
  }
  if (
    event.type === "turn-item.updated" &&
    ((event.payload.type !== "user_message" &&
      event.payload.type !== "assistant_message" &&
      event.payload.type !== "user_input_request") ||
      (event.payload.type === "assistant_message" &&
        event.payload.streaming &&
        (event.payload.attachments?.length ?? 0) === 0))
  ) {
    yield* apply;
    return 0;
  }
  const sql = yield* SqlClient.SqlClient;
  const oldPayloads = yield* sql<{ payload_json: string }>`
    SELECT reference.attachment_json AS payload_json
    FROM fork_v2_attachment_references AS reference
    LEFT JOIN orchestration_v2_legacy_imports AS imported ON imported.thread_id = reference.thread_id
    WHERE ${
      event.type === "thread.deleted"
        ? sql`reference.thread_id = ${event.threadId}`
        : sql`reference.source = ${event.type === "message.updated" ? "message" : "item"} AND reference.row_id = ${event.payload.id}`
    }
      AND (reference.source <> 'legacy' OR imported.transcript_imported_at IS NULL)
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
  const persisted = yield* sql<{
    command_id: string | null;
  }>`SELECT command_id FROM orchestration_events WHERE event_id = ${event.id}`;
  yield* outbox.enqueue([
    {
      id: `effect:${event.id}:attachment.prune`,
      commandId:
        stored.commandId ??
        CommandId.make(persisted[0]?.command_id ?? `attachment-prune:${event.id}`),
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
