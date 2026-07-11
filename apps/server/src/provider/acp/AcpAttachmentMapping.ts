// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";

import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";

export interface MapAcpAttachmentInput {
  readonly provider: string;
  readonly method: string;
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
  readonly fileSystem: FileSystem.FileSystem;
}

export const mapAcpAttachment = Effect.fn("mapAcpAttachment")(function* (
  input: MapAcpAttachmentInput,
) {
  const { attachment } = input;
  const attachmentType: string = attachment.type;
  if (attachmentType !== "image" && attachmentType !== "document") {
    return yield* new ProviderAdapterRequestError({
      provider: input.provider,
      method: input.method,
      detail: `Unsupported attachment type '${attachmentType}'.`,
    });
  }
  const attachmentPath = resolveAttachmentPath({
    attachmentsDir: input.attachmentsDir,
    attachment,
  });
  if (!attachmentPath) {
    return yield* new ProviderAdapterRequestError({
      provider: input.provider,
      method: input.method,
      detail: `Invalid attachment id '${attachment.id}'.`,
    });
  }

  switch (attachment.type) {
    case "image": {
      const bytes = yield* input.fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: input.provider,
              method: input.method,
              detail: `Failed to read attachment '${attachment.name}': ${cause.message}`,
              cause,
            }),
        ),
      );
      return {
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType: attachment.mimeType,
      } satisfies EffectAcpSchema.ContentBlock;
    }
    case "document": {
      const fileInfo = yield* input.fileSystem.stat(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: input.provider,
              method: input.method,
              detail: `Failed to read attachment '${attachment.name}': ${cause.message}`,
              cause,
            }),
        ),
      );
      if (fileInfo.type !== "File") {
        return yield* new ProviderAdapterRequestError({
          provider: input.provider,
          method: input.method,
          detail: `Attachment '${attachment.name}' is not a file.`,
        });
      }
      return {
        type: "resource_link",
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.sizeBytes,
        uri: NodeURL.pathToFileURL(attachmentPath).href,
      } satisfies EffectAcpSchema.ContentBlock;
    }
  }
});

export const mapAcpAttachments = Effect.fn("mapAcpAttachments")(function* (input: {
  readonly provider: string;
  readonly method: string;
  readonly attachmentsDir: string;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  return yield* Effect.forEach(
    input.attachments ?? [],
    (attachment) => mapAcpAttachment({ ...input, attachment }),
    { concurrency: 1 },
  );
});
