import type { ChatAttachment, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ProviderAttachmentAccessError, resolveProviderAttachment } from "./attachmentDelivery.ts";

export class UnsupportedAcpAttachmentError extends Schema.TaggedErrorClass<UnsupportedAcpAttachmentError>()(
  "UnsupportedAcpAttachmentError",
  {
    attachmentType: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Unsupported ACP attachment kind '${String(this.attachmentType)}'.`;
  }
}

export type AcpAttachmentMappingError =
  | ProviderAttachmentAccessError
  | UnsupportedAcpAttachmentError;

function unsupportedAcpAttachment(attachment: never): UnsupportedAcpAttachmentError {
  return new UnsupportedAcpAttachmentError({
    attachmentType: (attachment as unknown as { readonly type?: unknown }).type,
  });
}

/**
 * Maps persisted attachments to ACP prompt blocks while preserving input order.
 * Every known kind is resolved and read before the caller dispatches the prompt,
 * so a missing, unowned, or unreadable file rejects the complete mapping.
 */
export const mapAcpAttachments = Effect.fn("mapAcpAttachments")(function* (input: {
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  return yield* Effect.forEach(
    input.attachments ?? [],
    (attachment): Effect.Effect<EffectAcpSchema.ContentBlock, AcpAttachmentMappingError> =>
      Effect.gen(function* () {
        switch (attachment.type) {
          case "image": {
            const resolved = yield* resolveProviderAttachment({
              attachmentsDir: input.attachmentsDir,
              threadId: input.threadId,
              attachment,
              fileSystem: input.fileSystem,
            });
            return {
              type: "image",
              data: Buffer.from(resolved.bytes).toString("base64"),
              mimeType: attachment.mimeType,
            };
          }
          case "document":
          case "file": {
            const resolved = yield* resolveProviderAttachment({
              attachmentsDir: input.attachmentsDir,
              threadId: input.threadId,
              attachment,
              fileSystem: input.fileSystem,
            });
            return {
              type: "resource_link",
              name: attachment.name,
              mimeType: attachment.mimeType,
              size: attachment.sizeBytes,
              uri: resolved.fileUri,
            };
          }
          default:
            return yield* unsupportedAcpAttachment(attachment);
        }
      }),
    { concurrency: 1 },
  );
});
