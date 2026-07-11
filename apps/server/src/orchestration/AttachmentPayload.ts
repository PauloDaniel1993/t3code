import {
  type ChatAttachment,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_PDF_BYTES,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { parseBase64DataUrl, parseBase64DataUrlWithOptionalMimeType } from "../imageMime.ts";

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

export interface ValidatedAttachmentPayload {
  readonly attachment: WithoutId<ChatAttachment>;
  readonly bytes: Uint8Array;
}

const PDF_MIME_TYPE = "application/pdf";
const GENERIC_BINARY_MIME_TYPE = "application/octet-stream";
const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");
const PDF_SIGNATURE_SCAN_BYTES = 1_024;
const MAX_PDF_BASE64_CHARS = Math.ceil(PROVIDER_SEND_TURN_MAX_PDF_BYTES / 3) * 4;

function hasPdfFileName(name: string): boolean {
  return name.trim().toLowerCase().endsWith(".pdf");
}

function isPdfMimeCandidate(mimeType: string | null, name: string): boolean {
  const normalizedMimeType = mimeType?.trim().toLowerCase() ?? "";
  return (
    normalizedMimeType === PDF_MIME_TYPE ||
    ((normalizedMimeType.length === 0 || normalizedMimeType === GENERIC_BINARY_MIME_TYPE) &&
      hasPdfFileName(name))
  );
}

function isBase64DataCharacter(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f
  );
}

function hasStrictBase64Syntax(base64: string): boolean {
  if (base64.length === 0 || base64.length % 4 !== 0) {
    return false;
  }
  const paddingLength = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const dataLength = base64.length - paddingLength;
  for (let index = 0; index < dataLength; index += 1) {
    if (!isBase64DataCharacter(base64.charCodeAt(index))) {
      return false;
    }
  }
  for (let index = dataLength; index < base64.length; index += 1) {
    if (base64.charCodeAt(index) !== 0x3d) {
      return false;
    }
  }
  return true;
}

function decodePdfBase64(base64: string): Buffer | null {
  if (
    base64.length === 0 ||
    base64.length > MAX_PDF_BASE64_CHARS ||
    !hasStrictBase64Syntax(base64)
  ) {
    return null;
  }
  return Buffer.from(base64, "base64");
}

const validateImageAttachmentPayload = Effect.fn("validateImageAttachmentPayload")(function* (
  attachment: Extract<UploadChatAttachment, { readonly type: "image" }>,
): Effect.fn.Return<ValidatedAttachmentPayload, OrchestrationDispatchCommandError> {
  const parsed = parseBase64DataUrl(attachment.dataUrl);
  if (!parsed || !parsed.mimeType.startsWith("image/")) {
    return yield* new OrchestrationDispatchCommandError({
      message: `Invalid image attachment payload for '${attachment.name}'.`,
    });
  }

  const bytes = Buffer.from(parsed.base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    return yield* new OrchestrationDispatchCommandError({
      message: `Image attachment '${attachment.name}' is empty or too large.`,
    });
  }

  return {
    attachment: {
      type: "image",
      name: attachment.name,
      mimeType: parsed.mimeType.toLowerCase(),
      sizeBytes: bytes.byteLength,
    },
    bytes,
  };
});

const validateDocumentAttachmentPayload = Effect.fn("validateDocumentAttachmentPayload")(function* (
  attachment: Extract<UploadChatAttachment, { readonly type: "document" }>,
): Effect.fn.Return<ValidatedAttachmentPayload, OrchestrationDispatchCommandError> {
  const declaredMimeType = String(attachment.mimeType).trim().toLowerCase();
  if (!isPdfMimeCandidate(declaredMimeType, attachment.name)) {
    return yield* new OrchestrationDispatchCommandError({
      message: `PDF attachment '${attachment.name}' must use application/pdf.`,
    });
  }

  const parsed = parseBase64DataUrlWithOptionalMimeType(attachment.dataUrl);
  if (!parsed || !isPdfMimeCandidate(parsed.mimeType, attachment.name)) {
    return yield* new OrchestrationDispatchCommandError({
      message: `Invalid PDF attachment payload for '${attachment.name}'.`,
    });
  }

  const bytes = decodePdfBase64(parsed.base64);
  if (!bytes) {
    return yield* new OrchestrationDispatchCommandError({
      message: `Invalid base64 payload for PDF attachment '${attachment.name}'.`,
    });
  }
  if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_PDF_BYTES) {
    return yield* new OrchestrationDispatchCommandError({
      message: `PDF attachment '${attachment.name}' is empty or exceeds the 10 MiB limit.`,
    });
  }
  if (bytes.byteLength !== attachment.sizeBytes) {
    return yield* new OrchestrationDispatchCommandError({
      message: `PDF attachment '${attachment.name}' declared size does not match decoded size.`,
    });
  }
  if (bytes.subarray(0, PDF_SIGNATURE_SCAN_BYTES).indexOf(PDF_SIGNATURE) < 0) {
    return yield* new OrchestrationDispatchCommandError({
      message: `PDF attachment '${attachment.name}' does not contain a valid PDF signature.`,
    });
  }

  return {
    attachment: {
      type: "document",
      name: attachment.name,
      mimeType: PDF_MIME_TYPE,
      sizeBytes: bytes.byteLength,
    },
    bytes,
  };
});

export const validateAttachmentPayload = Effect.fn("validateAttachmentPayload")(function* (
  attachment: UploadChatAttachment,
): Effect.fn.Return<ValidatedAttachmentPayload, OrchestrationDispatchCommandError> {
  switch (attachment.type) {
    case "image":
      return yield* validateImageAttachmentPayload(attachment);
    case "document":
      return yield* validateDocumentAttachmentPayload(attachment);
  }
});
