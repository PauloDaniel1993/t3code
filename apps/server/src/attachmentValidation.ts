import {
  type UploadChatAttachment,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const DATA_URL_CHARS_ROUNDING = 1_000_000;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MEDIA_TYPE_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PARAMETER_PATTERN =
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"\r\n]*")$/;

export type ValidatedAttachment =
  | {
      readonly type: "image";
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly type: "file";
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
      readonly bytes: Uint8Array;
    };

function attachmentError(name: string, detail: string, cause?: unknown) {
  return new OrchestrationDispatchCommandError({
    message: `Attachment '${name}' ${detail}`,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function maximumDataUrlChars(maximumBytes: number): number {
  return Math.ceil((maximumBytes * 4) / (3 * DATA_URL_CHARS_ROUNDING)) * DATA_URL_CHARS_ROUNDING;
}

function maximumBase64Chars(maximumBytes: number): number {
  return 4 * Math.ceil(maximumBytes / 3);
}

function decodeStrictBase64DataUrl(
  attachment: UploadChatAttachment,
): Effect.Effect<
  { readonly mimeType: string; readonly bytes: Uint8Array },
  OrchestrationDispatchCommandError
> {
  return Effect.gen(function* () {
    const maximumBytes = PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;
    if (attachment.dataUrl.length > maximumDataUrlChars(maximumBytes)) {
      return yield* attachmentError(
        attachment.name,
        `has an encoded payload exceeding the ${maximumBytes}-byte limit.`,
      );
    }

    const dataUrl = attachment.dataUrl.trim();
    if (!dataUrl.toLowerCase().startsWith("data:")) {
      return yield* attachmentError(attachment.name, "has a malformed base64 data URL.");
    }

    const commaIndex = dataUrl.indexOf(",");
    if (commaIndex < 0 || dataUrl.indexOf(",", commaIndex + 1) >= 0) {
      return yield* attachmentError(attachment.name, "has a malformed base64 data URL.");
    }

    const header = dataUrl.slice(5, commaIndex);
    const rawPayload = dataUrl.slice(commaIndex + 1);
    const headerParts = header.split(";").map((part) => part.trim());
    if (
      headerParts.length < 2 ||
      headerParts.some((part) => part.length === 0) ||
      headerParts.at(-1)?.toLowerCase() !== "base64"
    ) {
      return yield* attachmentError(attachment.name, "has a malformed base64 data URL header.");
    }

    const mimeType = headerParts[0]?.toLowerCase();
    if (!mimeType || !MEDIA_TYPE_PATTERN.test(mimeType)) {
      return yield* attachmentError(attachment.name, "has a malformed base64 data URL MIME type.");
    }
    for (const parameter of headerParts.slice(1, -1)) {
      if (!PARAMETER_PATTERN.test(parameter)) {
        return yield* attachmentError(
          attachment.name,
          "has a malformed base64 data URL parameter.",
        );
      }
    }

    if (rawPayload.length === 0 || rawPayload.trim().length === 0) {
      return yield* attachmentError(attachment.name, "has an empty base64 payload.");
    }
    if (!/^[A-Za-z0-9+/=\r\n ]+$/.test(rawPayload)) {
      return yield* attachmentError(attachment.name, "has invalid base64 data.");
    }

    const base64 = rawPayload.replace(/[\r\n ]+/g, "");
    if (base64.length === 0) {
      return yield* attachmentError(attachment.name, "has an empty base64 payload.");
    }
    if (base64.length > maximumBase64Chars(maximumBytes)) {
      return yield* attachmentError(
        attachment.name,
        `has an encoded payload exceeding the ${maximumBytes}-byte limit.`,
      );
    }
    if (base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) {
      return yield* attachmentError(attachment.name, "has invalid or non-canonical base64 data.");
    }

    const paddingBytes = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    const expectedDecodedBytes = (base64.length / 4) * 3 - paddingBytes;
    if (expectedDecodedBytes < 1 || expectedDecodedBytes > maximumBytes) {
      return yield* attachmentError(
        attachment.name,
        `must contain between 1 and ${maximumBytes} decoded bytes.`,
      );
    }
    if (
      !Number.isSafeInteger(attachment.sizeBytes) ||
      attachment.sizeBytes !== expectedDecodedBytes
    ) {
      return yield* attachmentError(
        attachment.name,
        `declares ${attachment.sizeBytes} bytes but decodes to ${expectedDecodedBytes} bytes.`,
      );
    }

    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength !== expectedDecodedBytes || bytes.toString("base64") !== base64) {
      return yield* attachmentError(attachment.name, "has invalid or non-canonical base64 data.");
    }

    return { mimeType, bytes };
  });
}

export const validateUploadAttachments = Effect.fn("validateUploadAttachments")(function* (
  attachments: ReadonlyArray<UploadChatAttachment>,
) {
  const validated: ValidatedAttachment[] = [];

  for (const attachment of attachments) {
    const decoded = yield* decodeStrictBase64DataUrl(attachment);

    if (!decoded.mimeType.startsWith("image/")) {
      return yield* attachmentError(
        attachment.name,
        "does not contain an image MIME type in its data URL.",
      );
    }
    validated.push({
      type: "image",
      name: attachment.name,
      mimeType: decoded.mimeType,
      sizeBytes: decoded.bytes.byteLength,
      bytes: decoded.bytes,
    });
  }

  return validated;
});
