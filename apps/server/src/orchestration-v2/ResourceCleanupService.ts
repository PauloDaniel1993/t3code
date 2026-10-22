import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { referencedAttachmentPaths } from "./AttachmentReferences.ts";
import * as ServerConfig from "../config.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["terminal", "preview", "attachment", "scheduled-tasks"]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export const ATTACHMENT_CLEANUP_BATCH_SIZE = 128;
export interface AttachmentCleanupContinuation {
  readonly attachmentIds: ReadonlyArray<string>;
  readonly relativePaths?: ReadonlyArray<string>;
}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupScheduledTasks: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupPreviews: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
    relativePaths?: ReadonlyArray<string>,
  ) => Effect.Effect<void | AttachmentCleanupContinuation, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupScheduledTasks: () => Effect.void,
    cleanupTerminals: () => Effect.void,
    cleanupPreviews: () => Effect.void,
    cleanupAttachments: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const previews = yield* PreviewManager.PreviewManager;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    return {
      cleanupScheduledTasks: (threadId: ThreadId) =>
        scheduledTasks
          .deleteForThread(threadId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ResourceCleanupError({ operation: "scheduled-tasks", threadId, cause }),
            ),
          ),
      cleanupTerminals: (threadId: string) =>
        terminals
          .close({ threadId, deleteHistory: true })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
            ),
          ),
      cleanupPreviews: (threadId: string) =>
        previews
          .close({ threadId: ThreadId.make(threadId) })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
            ),
          ),
      // Delete only after the verified reference index reports no remaining reference.
      cleanupAttachments: (
        attachmentIds: ReadonlyArray<string>,
        relativePaths?: ReadonlyArray<string>,
      ) =>
        Effect.gen(function* () {
          const inputs = relativePaths ?? attachmentIds;
          const batch = inputs.slice(0, ATTACHMENT_CLEANUP_BATCH_SIZE);
          const remaining = inputs.slice(ATTACHMENT_CLEANUP_BATCH_SIZE);
          const idSet = new Set(attachmentIds);
          const paths = batch
            .flatMap((value) => {
              if (relativePaths !== undefined) return [value];
              const resolved = resolveAttachmentPathById({
                attachmentsDir: config.attachmentsDir,
                attachmentId: value,
              });
              return resolved === null ? [] : [path.relative(config.attachmentsDir, resolved)];
            })
            .flatMap((relativePath) => {
              const attachmentId = relativePath.slice(0, relativePath.lastIndexOf("."));
              if (
                !idSet.has(attachmentId) ||
                relativePath.includes("/") ||
                relativePath.includes("\\")
              )
                return [];
              const resolved = resolveAttachmentRelativePath({
                attachmentsDir: config.attachmentsDir,
                relativePath,
              });
              return resolved === null ? [] : [{ attachmentId, relativePath, resolved }];
            });
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const retained = yield* referencedAttachmentPaths(
                Array.from(new Set(paths.map((entry) => entry.attachmentId))),
              );
              for (const entry of paths) {
                const id = entry.attachmentId.toLowerCase();
                const name = entry.relativePath.toLowerCase();
                if (!retained.has("*") && !retained.has(id) && !retained.has(name))
                  yield* fileSystem.remove(entry.resolved, { force: true });
              }
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          );
          if (remaining.length === 0) return;
          return relativePaths === undefined
            ? { attachmentIds: remaining }
            : {
                attachmentIds: Array.from(
                  new Set(
                    remaining
                      .map((value) => value.slice(0, value.lastIndexOf(".")))
                      .filter((id) => idSet.has(id)),
                  ),
                ),
                relativePaths: remaining,
              };
        }).pipe(
          Effect.mapError((cause) => new ResourceCleanupError({ operation: "attachment", cause })),
        ),
    };
  }),
);
