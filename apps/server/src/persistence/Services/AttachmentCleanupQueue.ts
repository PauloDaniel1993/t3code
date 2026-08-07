import { IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const AttachmentCleanupOperation = Schema.Literals(["delete-thread", "delete-path"]);
export type AttachmentCleanupOperation = typeof AttachmentCleanupOperation.Type;

const AttachmentCleanupIntentFields = {
  id: NonNegativeInt,
  threadId: ThreadId,
  attemptCount: NonNegativeInt,
  createdAt: IsoDateTime,
  lastAttemptAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
} as const;

export const AttachmentCleanupIntent = Schema.Union([
  Schema.Struct({
    ...AttachmentCleanupIntentFields,
    operation: Schema.Literal("delete-thread"),
    relativePath: Schema.Literal(""),
  }),
  Schema.Struct({
    ...AttachmentCleanupIntentFields,
    operation: Schema.Literal("delete-path"),
    relativePath: Schema.String.check(Schema.isMinLength(1)),
  }),
]);
export type AttachmentCleanupIntent = typeof AttachmentCleanupIntent.Type;

export const EnqueueAttachmentCleanupInput = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("delete-thread"),
    threadId: ThreadId,
    relativePath: Schema.Literal(""),
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    operation: Schema.Literal("delete-path"),
    threadId: ThreadId,
    relativePath: Schema.String.check(Schema.isMinLength(1)),
    createdAt: IsoDateTime,
  }),
]);
export type EnqueueAttachmentCleanupInput = typeof EnqueueAttachmentCleanupInput.Type;

export const ListPendingAttachmentCleanupInput = Schema.Struct({
  limit: NonNegativeInt,
});
export type ListPendingAttachmentCleanupInput = typeof ListPendingAttachmentCleanupInput.Type;

export const AttachmentCleanupIntentIdInput = Schema.Struct({
  id: NonNegativeInt,
});
export type AttachmentCleanupIntentIdInput = typeof AttachmentCleanupIntentIdInput.Type;

export const RecordAttachmentCleanupFailureInput = Schema.Struct({
  id: NonNegativeInt,
  attemptedAt: IsoDateTime,
  error: Schema.String,
});
export type RecordAttachmentCleanupFailureInput = typeof RecordAttachmentCleanupFailureInput.Type;

export const AttachmentCleanupFailureUpdate = Schema.Struct({
  attemptCount: NonNegativeInt,
});
export type AttachmentCleanupFailureUpdate = typeof AttachmentCleanupFailureUpdate.Type;

export interface AttachmentCleanupQueueRepositoryShape {
  readonly enqueue: (
    input: EnqueueAttachmentCleanupInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listPending: (
    input: ListPendingAttachmentCleanupInput,
  ) => Effect.Effect<ReadonlyArray<AttachmentCleanupIntent>, ProjectionRepositoryError>;
  readonly markSucceeded: (
    input: AttachmentCleanupIntentIdInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly recordFailure: (
    input: RecordAttachmentCleanupFailureInput,
  ) => Effect.Effect<Option.Option<AttachmentCleanupFailureUpdate>, ProjectionRepositoryError>;
}

export class AttachmentCleanupQueueRepository extends Context.Service<
  AttachmentCleanupQueueRepository,
  AttachmentCleanupQueueRepositoryShape
>()("t3/persistence/Services/AttachmentCleanupQueue/AttachmentCleanupQueueRepository") {}
