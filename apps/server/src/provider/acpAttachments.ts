import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ProviderAttachmentAccessError, resolveProviderAttachment } from "./attachmentDelivery.ts";

export type AcpAttachmentMappingError = ProviderAttachmentAccessError;

/**
 * Maps persisted attachments to ACP prompt blocks while preserving input order.
 * Every known kind is resolved and read before the caller dispatches the prompt,
 * so a missing, unowned, or unreadable file rejects the complete mapping.
 */
export const mapAcpAttachments = Effect.fn("mapAcpAttachments")(function* (input: {
  readonly attachmentsDir: string;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  const parts: Array<EffectAcpSchema.ContentBlock> = [];
  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image" && attachment.type !== "file") {
      continue;
    }
    const resolved = yield* resolveProviderAttachment({
      attachmentsDir: input.attachmentsDir,
      attachment,
      fileSystem: input.fileSystem,
    });
    parts.push(
      attachment.type === "image"
        ? {
            type: "image",
            data: Buffer.from(resolved.bytes).toString("base64"),
            mimeType: attachment.mimeType,
          }
        : {
            type: "resource_link",
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.sizeBytes,
            uri: resolved.fileUri,
          },
    );
  }
  return parts;
});
