// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";

import { ChatAttachment, PROVIDER_INLINE_FILE_MAX_CHARS, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { resolveAttachmentPath } from "../attachmentStore.ts";

export interface ResolvedProviderAttachment {
  readonly attachment: ChatAttachment;
  readonly absolutePath: string;
  readonly fileUri: string;
  readonly bytes: Uint8Array;
}

export class ProviderAttachmentAccessError extends Schema.TaggedErrorClass<ProviderAttachmentAccessError>()(
  "ProviderAttachmentAccessError",
  {
    attachment: ChatAttachment,
    reason: Schema.Literals(["invalid-or-unowned", "unreadable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "invalid-or-unowned"
      ? `Attachment '${this.attachment.name}' could not be resolved in the contained attachment store.`
      : `Attachment '${this.attachment.name}' could not be read from the contained attachment store.`;
  }
}

/**
 * Converts an absolute native path into an encoded file URI. The optional
 * platform override exists for deterministic cross-platform regression tests;
 * production callers use Node's current-platform behavior.
 */
export function providerFileUri(
  absolutePath: string,
  options?: { readonly windows?: boolean },
): string {
  return NodeURL.pathToFileURL(absolutePath, options).href;
}

/**
 * Resolves only metadata-derived, thread-owned attachment paths and verifies
 * readability before a provider can dispatch any part of the turn.
 */
export const resolveProviderAttachment = Effect.fn("resolveProviderAttachment")(function* (input: {
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  readonly attachment: ChatAttachment;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  const absolutePath = resolveAttachmentPath({
    attachmentsDir: input.attachmentsDir,
    attachment: input.attachment,
    threadId: input.threadId,
  });
  if (!absolutePath) {
    return yield* new ProviderAttachmentAccessError({
      attachment: input.attachment,
      reason: "invalid-or-unowned",
    });
  }

  const bytes = yield* input.fileSystem.readFile(absolutePath).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAttachmentAccessError({
          attachment: input.attachment,
          reason: "unreadable",
          cause,
        }),
    ),
  );

  return {
    attachment: input.attachment,
    absolutePath,
    fileUri: providerFileUri(absolutePath),
    bytes,
  } satisfies ResolvedProviderAttachment;
});

export class ProviderTextDecodingError extends Schema.TaggedErrorClass<ProviderTextDecodingError>()(
  "ProviderTextDecodingError",
  {
    fileName: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Attachment '${this.fileName}' is not valid UTF-8 or BOM-marked UTF-16 text.`;
  }
}

/**
 * Decodes provider-inline text as UTF-8 by default, or UTF-16 LE/BE when a BOM
 * is present. BOM bytes are excluded from the returned text and malformed byte
 * sequences fail instead of being replacement-decoded.
 */
export function decodeProviderText(bytes: Uint8Array, fileName: string): string {
  let encoding: "utf-8" | "utf-16" = "utf-8";
  let payload = bytes;

  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16";
    payload = bytes.subarray(2);
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16";
    const bigEndianPayload = bytes.subarray(2);
    payload = new Uint8Array(bigEndianPayload.length);
    for (let index = 0; index < bigEndianPayload.length; index += 2) {
      payload[index] = bigEndianPayload[index + 1] ?? 0;
      payload[index + 1] = bigEndianPayload[index] ?? 0;
    }
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    payload = bytes.subarray(3);
  }

  try {
    return new TextDecoder(encoding, { fatal: true }).decode(payload);
  } catch (cause) {
    throw new ProviderTextDecodingError({ fileName, cause });
  }
}

export class ProviderInlineTextBudgetError extends Schema.TaggedErrorClass<ProviderInlineTextBudgetError>()(
  "ProviderInlineTextBudgetError",
  {
    fileName: Schema.String,
    limit: Schema.Number,
  },
) {
  override get message(): string {
    return `Inlining attachment '${this.fileName}' would exceed the ${this.limit / 1024} KiB (${this.limit} UTF-16 code units) per-turn limit.`;
  }
}

/**
 * Tracks decoded JavaScript string length (UTF-16 code units) cumulatively for
 * one provider turn. A rejected addition does not consume budget.
 */
export class ProviderInlineTextBudget {
  private usedChars = 0;
  readonly limit: number;

  constructor(limit = PROVIDER_INLINE_FILE_MAX_CHARS) {
    this.limit = limit;
  }

  add(fileName: string, text: string): void {
    if (this.usedChars + text.length > this.limit) {
      throw new ProviderInlineTextBudgetError({ fileName, limit: this.limit });
    }
    this.usedChars += text.length;
  }

  get used(): number {
    return this.usedChars;
  }
}
