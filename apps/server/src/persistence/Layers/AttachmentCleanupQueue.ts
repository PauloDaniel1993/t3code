import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  AttachmentCleanupFailureUpdate,
  AttachmentCleanupIntent,
  AttachmentCleanupIntentIdInput,
  AttachmentCleanupQueueRepository,
  type AttachmentCleanupQueueRepositoryShape,
  EnqueueAttachmentCleanupInput,
  ListPendingAttachmentCleanupInput,
  RecordAttachmentCleanupFailureInput,
} from "../Services/AttachmentCleanupQueue.ts";

const makeAttachmentCleanupQueueRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const enqueueIntent = SqlSchema.void({
    Request: EnqueueAttachmentCleanupInput,
    execute: (input) =>
      sql`
        INSERT INTO attachment_cleanup_queue (
          operation,
          thread_id,
          relative_path,
          created_at
        )
        VALUES (
          ${input.operation},
          ${input.threadId},
          ${input.relativePath},
          ${input.createdAt}
        )
        ON CONFLICT (operation, thread_id, relative_path) DO NOTHING
      `,
  });

  const listPendingIntents = SqlSchema.findAll({
    Request: ListPendingAttachmentCleanupInput,
    Result: AttachmentCleanupIntent,
    execute: ({ limit }) =>
      sql`
        SELECT
          id,
          operation,
          thread_id AS "threadId",
          relative_path AS "relativePath",
          attempt_count AS "attemptCount",
          created_at AS "createdAt",
          last_attempt_at AS "lastAttemptAt",
          last_error AS "lastError"
        FROM attachment_cleanup_queue
        ORDER BY attempt_count ASC, created_at ASC, id ASC
        LIMIT ${limit}
      `,
  });

  const deleteIntent = SqlSchema.void({
    Request: AttachmentCleanupIntentIdInput,
    execute: ({ id }) =>
      sql`
        DELETE FROM attachment_cleanup_queue
        WHERE id = ${id}
      `,
  });

  const updateFailedIntent = SqlSchema.findOneOption({
    Request: RecordAttachmentCleanupFailureInput,
    Result: AttachmentCleanupFailureUpdate,
    execute: ({ id, attemptedAt, error }) =>
      sql`
        UPDATE attachment_cleanup_queue
        SET
          attempt_count = attempt_count + 1,
          last_attempt_at = ${attemptedAt},
          last_error = ${error}
        WHERE id = ${id}
        RETURNING attempt_count AS "attemptCount"
      `,
  });

  const enqueue: AttachmentCleanupQueueRepositoryShape["enqueue"] = (input) =>
    enqueueIntent(input).pipe(
      Effect.mapError(toPersistenceSqlError("AttachmentCleanupQueueRepository.enqueue:query")),
    );

  const listPending: AttachmentCleanupQueueRepositoryShape["listPending"] = (input) =>
    listPendingIntents(input).pipe(
      Effect.mapError(toPersistenceSqlError("AttachmentCleanupQueueRepository.listPending:query")),
    );

  const markSucceeded: AttachmentCleanupQueueRepositoryShape["markSucceeded"] = (input) =>
    deleteIntent(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AttachmentCleanupQueueRepository.markSucceeded:query"),
      ),
    );

  const recordFailure: AttachmentCleanupQueueRepositoryShape["recordFailure"] = (input) =>
    updateFailedIntent(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AttachmentCleanupQueueRepository.recordFailure:query"),
      ),
    );

  const discard: AttachmentCleanupQueueRepositoryShape["discard"] = (input) =>
    deleteIntent(input).pipe(
      Effect.mapError(toPersistenceSqlError("AttachmentCleanupQueueRepository.discard:query")),
    );

  return {
    enqueue,
    listPending,
    markSucceeded,
    recordFailure,
    discard,
  } satisfies AttachmentCleanupQueueRepositoryShape;
});

export const AttachmentCleanupQueueRepositoryLive = Layer.effect(
  AttachmentCleanupQueueRepository,
  makeAttachmentCleanupQueueRepository,
);
