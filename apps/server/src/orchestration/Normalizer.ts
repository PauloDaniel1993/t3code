import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  type ClientOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";

import { stageValidatedAttachments, type AttachmentStage } from "../attachmentStaging.ts";
import { validateUploadAttachments } from "../attachmentValidation.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

export interface NormalizedDispatchCommand {
  readonly command: OrchestrationCommand;
  readonly attachmentStage?: AttachmentStage;
}

export const normalizeDispatchCommand = Effect.fn("normalizeDispatchCommand")(function* (
  command: ClientOrchestrationCommand,
) {
  const receivedAt = DateTime.formatIso(yield* DateTime.now);
  const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);

  if (canonicalCommand.type === "project.create") {
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const workspaceRoot = yield* workspacePaths
      .normalizeWorkspaceRoot(canonicalCommand.workspaceRoot, {
        createIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );
    return {
      command: {
        ...canonicalCommand,
        workspaceRoot,
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand,
    };
  }

  if (
    canonicalCommand.type === "project.meta.update" &&
    canonicalCommand.workspaceRoot !== undefined
  ) {
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const workspaceRoot = yield* workspacePaths
      .normalizeWorkspaceRoot(canonicalCommand.workspaceRoot)
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );
    return {
      command: {
        ...canonicalCommand,
        workspaceRoot,
      } satisfies OrchestrationCommand,
    };
  }

  if (canonicalCommand.type !== "thread.turn.start") {
    return { command: canonicalCommand as OrchestrationCommand };
  }

  // Validation deliberately completes for the entire array before this function
  // allocates any attachment IDs or performs any filesystem operation.
  const validatedAttachments = yield* validateUploadAttachments(
    canonicalCommand.message.attachments,
  );
  if (validatedAttachments.length === 0) {
    return {
      command: {
        ...canonicalCommand,
        message: {
          ...canonicalCommand.message,
          attachments: [],
        },
      } satisfies OrchestrationCommand,
    };
  }

  const staged = yield* stageValidatedAttachments({
    commandId: canonicalCommand.commandId,
    threadId: canonicalCommand.threadId,
    attachments: validatedAttachments,
  });

  return {
    command: {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: staged.attachments,
      },
    } satisfies OrchestrationCommand,
    attachmentStage: staged.stage,
  };
});
