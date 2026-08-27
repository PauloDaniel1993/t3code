import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  type ChatImageAttachment,
  type ClientOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  type UploadChatAttachment,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";

import { stageValidatedAttachments, type AttachmentStage } from "../attachmentStaging.ts";
import {
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import { validateUploadAttachments, type ValidatedAttachment } from "../attachmentValidation.ts";
import { ServerConfig } from "../config.ts";
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

function attachmentError(name: string, detail: string, cause?: unknown) {
  return new OrchestrationDispatchCommandError({
    message: `Attachment '${name}' cannot be sent: ${detail}.`,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const validatePendingImageAttachment = Effect.fn("Normalizer.validatePendingImageAttachment")(
  function* (attachment: ChatImageAttachment, attachmentsDir: string) {
    if (parseThreadSegmentFromAttachmentId(attachment.id) !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
      return yield* attachmentError(attachment.name, "attachment must be a pending upload");
    }

    const currentPath = resolveAttachmentPathById({
      attachmentsDir,
      attachmentId: attachment.id,
    });
    if (!currentPath) {
      return yield* attachmentError(attachment.name, "attachment not found (removed or expired)");
    }

    const normalizedAttachment = {
      ...attachment,
      mimeType: attachment.mimeType.toLowerCase(),
    };
    const expectedPath = resolveAttachmentPath({
      attachmentsDir,
      attachment: normalizedAttachment,
    });
    if (expectedPath !== currentPath) {
      return yield* attachmentError(attachment.name, "image type does not match the upload");
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* fileSystem
      .stat(currentPath)
      .pipe(
        Effect.mapError((cause) => attachmentError(attachment.name, "attachment not found", cause)),
      );
    if (info.type !== "File" || Number(info.size) !== attachment.sizeBytes) {
      return yield* attachmentError(attachment.name, "stored size does not match");
    }

    const bytes = yield* fileSystem
      .readFile(currentPath)
      .pipe(
        Effect.mapError((cause) => attachmentError(attachment.name, "attachment not found", cause)),
      );
    if (bytes.byteLength !== attachment.sizeBytes) {
      return yield* attachmentError(attachment.name, "stored size does not match");
    }

    return {
      type: "image",
      name: attachment.name,
      mimeType: normalizedAttachment.mimeType,
      sizeBytes: bytes.byteLength,
      bytes,
    } satisfies ValidatedAttachment;
  },
);

export const normalizeDispatchCommand = Effect.fn("Normalizer.normalizeDispatchCommand")(function* (
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

  // Authorship is server-authored so a client cannot claim a task was the
  // agent's idea. The client command carries no `createdBy` at all, so it is
  // stamped here rather than defaulted at decode.
  if (canonicalCommand.type === "thread.task.create") {
    return {
      command: {
        ...canonicalCommand,
        createdBy: "user",
      } satisfies OrchestrationCommand,
    };
  }

  if (canonicalCommand.type !== "thread.turn.start") {
    return { command: canonicalCommand as OrchestrationCommand };
  }

  const serverConfig = yield* ServerConfig;
  const inlineAttachments: UploadChatAttachment[] = [];
  const validatedByIndex: Array<ValidatedAttachment | null> = [];

  // Pending uploads require filesystem reads, but no attachment id is
  // allocated and no file is written until every attachment has validated.
  for (const attachment of canonicalCommand.message.attachments) {
    if ("dataUrl" in attachment) {
      inlineAttachments.push(attachment);
      validatedByIndex.push(null);
    } else {
      validatedByIndex.push(
        yield* validatePendingImageAttachment(attachment, serverConfig.attachmentsDir),
      );
    }
  }

  const validatedInlineAttachments = yield* validateUploadAttachments(inlineAttachments);
  let inlineIndex = 0;
  const validatedAttachments: ValidatedAttachment[] = [];
  for (const attachment of validatedByIndex) {
    if (attachment !== null) {
      validatedAttachments.push(attachment);
      continue;
    }
    const inlineAttachment = validatedInlineAttachments[inlineIndex];
    inlineIndex += 1;
    if (!inlineAttachment) {
      return yield* new OrchestrationDispatchCommandError({
        message: "Validated attachment order did not match the client command.",
      });
    }
    validatedAttachments.push(inlineAttachment);
  }

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
  } satisfies NormalizedDispatchCommand;
});
