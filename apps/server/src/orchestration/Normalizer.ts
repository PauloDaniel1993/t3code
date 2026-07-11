import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  type ChatAttachment,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { writeFileAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { validateAttachmentPayload } from "./AttachmentPayload.ts";

export interface NormalizedDispatchCommand {
  readonly command: OrchestrationCommand;
  /** Files created while normalizing this command whose ownership transfers on dispatch success. */
  readonly freshAttachmentPaths: ReadonlyArray<string>;
}

const removeFreshAttachmentPaths = Effect.fn("removeFreshAttachmentPaths")(function* (
  paths: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* Effect.forEach(
    paths,
    (filePath) => fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore),
    { concurrency: 1, discard: true },
  );
});

/**
 * Dispatch a normalized command and transfer ownership of any freshly-created
 * attachment files only when dispatch succeeds. Failures and interruption keep
 * cleanup scoped to the files created by this normalization attempt.
 */
export const dispatchNormalizedCommandWithCleanup = Effect.fn(
  "dispatchNormalizedCommandWithCleanup",
)(function* <A, E, R>(
  normalized: NormalizedDispatchCommand,
  dispatch: (command: OrchestrationCommand) => Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E, R | FileSystem.FileSystem> {
  return yield* dispatch(normalized.command).pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? removeFreshAttachmentPaths(normalized.freshAttachmentPaths)
        : Effect.void,
    ),
  );
});

export const normalizeDispatchCommand = Effect.fn("normalizeDispatchCommand")(function* (
  command: ClientOrchestrationCommand,
): Effect.fn.Return<
  NormalizedDispatchCommand,
  OrchestrationDispatchCommandError,
  FileSystem.FileSystem | Path.Path | ServerConfig | WorkspacePaths.WorkspacePaths
> {
  const serverConfig = yield* ServerConfig;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

  const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
    workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: cause.message,
          }),
      ),
    );

  const normalizeProjectWorkspaceRootForCreate = (
    workspaceRoot: string,
    createIfMissing: boolean | undefined,
  ) =>
    workspacePaths
      .normalizeWorkspaceRoot(workspaceRoot, {
        createIfMissing: createIfMissing === true,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

  if (command.type === "project.create") {
    return {
      command: {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          command.workspaceRoot,
          command.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: command.createWorkspaceRootIfMissing === true,
      },
      freshAttachmentPaths: [],
    } satisfies NormalizedDispatchCommand;
  }

  if (command.type === "project.meta.update" && command.workspaceRoot !== undefined) {
    return {
      command: {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(command.workspaceRoot),
      },
      freshAttachmentPaths: [],
    } satisfies NormalizedDispatchCommand;
  }

  if (command.type !== "thread.turn.start") {
    return {
      command: command as OrchestrationCommand,
      freshAttachmentPaths: [],
    } satisfies NormalizedDispatchCommand;
  }

  const validatedAttachments = yield* Effect.forEach(
    command.message.attachments,
    validateAttachmentPayload,
    { concurrency: 1 },
  );

  const preparedAttachments = yield* Effect.forEach(
    validatedAttachments,
    (validated) =>
      Effect.gen(function* () {
        const attachmentId = createAttachmentId(command.threadId);
        if (!attachmentId) {
          return yield* new OrchestrationDispatchCommandError({
            message: "Failed to create a safe attachment id.",
          });
        }

        const attachment = {
          ...validated.attachment,
          id: attachmentId,
        } as ChatAttachment;
        const filePath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!filePath) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Failed to resolve persisted path for '${attachment.name}'.`,
          });
        }

        return { attachment, bytes: validated.bytes, filePath };
      }),
    { concurrency: 1 },
  );

  const freshAttachmentPaths = preparedAttachments.map(({ filePath }) => filePath);

  yield* Effect.forEach(
    preparedAttachments,
    ({ attachment, bytes, filePath }) =>
      writeFileAtomically({ filePath, contents: bytes }).pipe(
        Effect.mapError(
          () =>
            new OrchestrationDispatchCommandError({
              message: `Failed to persist attachment '${attachment.name}'.`,
            }),
        ),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? removeFreshAttachmentPaths(freshAttachmentPaths) : Effect.void,
    ),
  );

  return {
    command: {
      ...command,
      message: {
        ...command.message,
        attachments: preparedAttachments.map(({ attachment }) => attachment),
      },
    },
    freshAttachmentPaths,
  } satisfies NormalizedDispatchCommand;
});
