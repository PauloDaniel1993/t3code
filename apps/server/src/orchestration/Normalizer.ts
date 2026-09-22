import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  type ChatAttachment,
  type ClientOrchestrationCommand,
  getProviderAttachmentLimitError,
  type IsoDateTime,
  type OrchestrationCommand,
  type UserInputAttachments,
  type UploadChatAttachment,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";

import {
  stageValidatedAttachments,
  type AttachmentStage,
  type StageableAttachment,
} from "../attachmentStaging.ts";
import {
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import { validateUploadAttachments } from "../attachmentValidation.ts";
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

const validatePendingAttachment = Effect.fn("Normalizer.validatePendingAttachment")(function* (
  attachment: ChatAttachment,
  attachmentsDir: string,
) {
  if (attachment.type !== "image" && attachment.type !== "file") {
    return yield* attachmentError(attachment.name, "unsupported attachment type");
  }
  const attachmentType: "image" | "file" = attachment.type;
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
    return yield* attachmentError(attachment.name, "attachment type does not match the upload");
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

  return {
    type: attachmentType,
    name: attachment.name,
    mimeType: normalizedAttachment.mimeType,
    sizeBytes: Number(info.size),
    sourcePath: currentPath,
  };
});

function preserveAttachmentSource(
  original: ChatAttachment | UploadChatAttachment,
  persisted: ChatAttachment,
): ChatAttachment {
  if (
    original.type === "image" &&
    "source" in original &&
    persisted.type === "image" &&
    original.source !== undefined
  ) {
    return {
      type: "image",
      id: persisted.id,
      name: persisted.name,
      mimeType: persisted.mimeType,
      sizeBytes: persisted.sizeBytes,
      source: original.source,
    };
  }
  if (
    original.type === "file" &&
    "source" in original &&
    persisted.type === "file" &&
    original.source !== undefined
  ) {
    return {
      type: "file",
      id: persisted.id,
      name: persisted.name,
      mimeType: persisted.mimeType,
      sizeBytes: persisted.sizeBytes,
      source: original.source,
    };
  }
  return persisted;
}

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

  if (
    canonicalCommand.type !== "thread.turn.start" &&
    canonicalCommand.type !== "thread.user-input.respond"
  ) {
    return { command: canonicalCommand as OrchestrationCommand };
  }

  const attachments =
    canonicalCommand.type === "thread.turn.start"
      ? canonicalCommand.message.attachments
      : Object.values(canonicalCommand.attachmentsByQuestionId ?? {}).flat();
  const attachmentLimitError = getProviderAttachmentLimitError(attachments);
  if (attachmentLimitError) {
    return yield* new OrchestrationDispatchCommandError({ message: attachmentLimitError });
  }
  if (canonicalCommand.type === "thread.turn.start") {
    const clientAttachmentIds = new Set<string>();
    for (const attachment of attachments) {
      if (attachment.id === undefined) continue;
      if (clientAttachmentIds.has(attachment.id)) {
        return yield* new OrchestrationDispatchCommandError({
          message: `Attachment '${attachment.name}' cannot be sent: duplicate attachment id.`,
        });
      }
      clientAttachmentIds.add(attachment.id);
    }
  }

  const serverConfig = yield* ServerConfig;
  const inlineAttachments: UploadChatAttachment[] = [];
  const validatedByIndex: Array<StageableAttachment | null> = [];

  // Pending uploads require filesystem reads, but no attachment id is
  // allocated and no file is written until every attachment has validated.
  for (const attachment of attachments) {
    if ("dataUrl" in attachment) {
      inlineAttachments.push(attachment);
      validatedByIndex.push(null);
    } else {
      validatedByIndex.push(
        yield* validatePendingAttachment(attachment, serverConfig.attachmentsDir),
      );
    }
  }

  const validatedInlineAttachments = yield* validateUploadAttachments(inlineAttachments);
  let inlineIndex = 0;
  const validatedAttachments: StageableAttachment[] = [];
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

  const decodedAttachmentLimitError = getProviderAttachmentLimitError(validatedAttachments);
  if (decodedAttachmentLimitError) {
    return yield* new OrchestrationDispatchCommandError({ message: decodedAttachmentLimitError });
  }

  if (validatedAttachments.length === 0) {
    return {
      command:
        canonicalCommand.type === "thread.turn.start"
          ? ({
              ...canonicalCommand,
              message: {
                ...canonicalCommand.message,
                attachments: [],
              },
            } satisfies OrchestrationCommand)
          : (canonicalCommand satisfies OrchestrationCommand),
    };
  }

  const staged = yield* stageValidatedAttachments({
    commandId: canonicalCommand.commandId,
    threadId: canonicalCommand.threadId,
    attachments: validatedAttachments,
  });
  const normalizedAttachments = staged.attachments.map((attachment, index) => {
    const original = attachments[index];
    return original === undefined ? attachment : preserveAttachmentSource(original, attachment);
  });

  if (canonicalCommand.type === "thread.user-input.respond") {
    let index = 0;
    const attachmentsByQuestionId = Object.fromEntries(
      Object.entries(canonicalCommand.attachmentsByQuestionId ?? {}).map(
        ([questionId, original]) => {
          const claimed = normalizedAttachments.slice(
            index,
            index + original.length,
          ) as UserInputAttachments[string];
          index += original.length;
          return [questionId, claimed];
        },
      ),
    );
    return {
      command: {
        ...canonicalCommand,
        attachmentsByQuestionId,
      } satisfies OrchestrationCommand,
      attachmentStage: staged.stage,
    } satisfies NormalizedDispatchCommand;
  }

  const finalAttachmentIdByClientId = new Map<string, string>();
  for (const [index, attachment] of attachments.entries()) {
    if (attachment.id === undefined) continue;
    const persisted = normalizedAttachments[index];
    if (persisted !== undefined) {
      finalAttachmentIdByClientId.set(attachment.id, persisted.id);
    }
  }
  const context = canonicalCommand.message.context;
  const normalizedContext =
    context === undefined
      ? undefined
      : {
          ...context,
          records: context.records.map((record) =>
            (record.kind === "image" || record.kind === "file") && "attachmentId" in record
              ? {
                  ...record,
                  attachmentId:
                    finalAttachmentIdByClientId.get(record.attachmentId) ?? record.attachmentId,
                }
              : record,
          ),
        };

  return {
    command: {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: normalizedAttachments,
        ...(normalizedContext !== undefined ? { context: normalizedContext } : {}),
      },
    } satisfies OrchestrationCommand,
    attachmentStage: staged.stage,
  } satisfies NormalizedDispatchCommand;
});

export const cleanupFailedUploadedAttachments = Effect.fn(
  "Normalizer.cleanupFailedUploadedAttachments",
)(function* (_command: ClientOrchestrationCommand, normalized: NormalizedDispatchCommand) {
  yield* normalized.attachmentStage?.abort ?? Effect.void;
});
