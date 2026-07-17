import {
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { stageValidatedAttachments, type AttachmentStage } from "../attachmentStaging.ts";
import { validateUploadAttachments } from "../attachmentValidation.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export interface NormalizedDispatchCommand {
  readonly command: OrchestrationCommand;
  readonly attachmentStage?: AttachmentStage;
}

export const normalizeDispatchCommand = Effect.fn("normalizeDispatchCommand")(function* (
  command: ClientOrchestrationCommand,
) {
  if (command.type === "project.create") {
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const workspaceRoot = yield* workspacePaths
      .normalizeWorkspaceRoot(command.workspaceRoot, {
        createIfMissing: command.createWorkspaceRootIfMissing === true,
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
        ...command,
        workspaceRoot,
        createWorkspaceRootIfMissing: command.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand,
    };
  }

  if (command.type === "project.meta.update" && command.workspaceRoot !== undefined) {
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(command.workspaceRoot).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: cause.message,
          }),
      ),
    );
    return {
      command: {
        ...command,
        workspaceRoot,
      } satisfies OrchestrationCommand,
    };
  }

  if (command.type !== "thread.turn.start") {
    return { command: command as OrchestrationCommand };
  }

  // Validation deliberately completes for the entire array before this function
  // allocates any attachment IDs or performs any filesystem operation.
  const validatedAttachments = yield* validateUploadAttachments(command.message.attachments);
  if (validatedAttachments.length === 0) {
    return {
      command: {
        ...command,
        message: {
          ...command.message,
          attachments: [],
        },
      } satisfies OrchestrationCommand,
    };
  }

  const staged = yield* stageValidatedAttachments({
    commandId: command.commandId,
    threadId: command.threadId,
    attachments: validatedAttachments,
  });

  return {
    command: {
      ...command,
      message: {
        ...command.message,
        attachments: staged.attachments,
      },
    } satisfies OrchestrationCommand,
    attachmentStage: staged.stage,
  };
});
