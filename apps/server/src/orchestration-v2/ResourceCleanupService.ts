/** Delete files only when the reference index is verified complete and reports no reference. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { referencedAttachmentPaths } from "./AttachmentReferences.ts";
import * as ServerConfig from "../config.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["terminal", "attachment"]),
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
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
    relativePaths?: ReadonlyArray<string>,
  ) => Effect.Effect<void | AttachmentCleanupContinuation, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupTerminals: () => Effect.void,
    cleanupAttachments: () => Effect.void,
  }),
}) {}

export const live = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    return {
      cleanupTerminals: (threadId: string) =>
        terminals
          .close({ threadId, deleteHistory: true })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
            ),
          ),
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
          // Test the actual store, including case-sensitive volumes on Windows/macOS.
          let caseInsensitive = false;
          for (const entry of paths) {
            const alternate = entry.relativePath.replace(/[a-zA-Z]/, (letter) =>
              letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
            );
            if (alternate === entry.relativePath) continue;
            const original = yield* fileSystem
              .stat(entry.resolved)
              .pipe(
                Effect.catchTag("PlatformError", (error) =>
                  error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
                ),
              );
            if (original === undefined) continue;
            const alias = yield* fileSystem
              .stat(path.join(config.attachmentsDir, alternate))
              .pipe(
                Effect.catchTag("PlatformError", (error) =>
                  error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
                ),
              );
            if (
              alias !== undefined &&
              original.dev === alias.dev &&
              (Option.isNone(original.ino) ||
                Option.isNone(alias.ino) ||
                original.ino.value === alias.ino.value)
            ) {
              caseInsensitive = true;
              break;
            }
          }
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const retained = yield* referencedAttachmentPaths(
                Array.from(new Set(paths.map((entry) => entry.attachmentId))),
                caseInsensitive,
              );
              for (const entry of paths) {
                const id = caseInsensitive ? entry.attachmentId.toLowerCase() : entry.attachmentId;
                const name = caseInsensitive
                  ? entry.relativePath.toLowerCase()
                  : entry.relativePath;
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
