import {
  type UploadChatAttachment,
  PROVIDER_SEND_TURN_MAX_DOCUMENT_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import {
  getAttachmentFileExtension,
  lookupAttachmentFileType,
} from "@t3tools/shared/attachmentFileTypes";
import * as Effect from "effect/Effect";

const DATA_URL_CHARS_ROUNDING = 1_000_000;
const PDF_HEADER_SCAN_BYTES = 1_024;
const TEXT_NUL_SCAN_BYTES = 8 * 1_024;
const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");
const XLSX_SIGNATURE = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
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
      readonly type: "document";
      readonly name: string;
      readonly mimeType: "application/pdf";
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

function maximumBytesFor(attachment: UploadChatAttachment): number {
  switch (attachment.type) {
    case "image":
      return PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;
    case "document":
      return PROVIDER_SEND_TURN_MAX_DOCUMENT_BYTES;
    case "file":
      return PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  }
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
    const maximumBytes = maximumBytesFor(attachment);
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

function hasPdfSignature(bytes: Uint8Array): boolean {
  return (
    Buffer.from(bytes)
      .subarray(0, Math.min(PDF_HEADER_SCAN_BYTES, bytes.byteLength))
      .indexOf(PDF_SIGNATURE) >= 0
  );
}

function hasXlsxSignature(bytes: Uint8Array): boolean {
  return XLSX_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function hasNulInTextSniff(bytes: Uint8Array): boolean {
  const scanLength = Math.min(TEXT_NUL_SCAN_BYTES, bytes.byteLength);
  for (let index = 0; index < scanLength; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

function textContentFailure(bytes: Uint8Array): "nul" | "encoding" | null {
  let encoding: "utf-8" | "utf-16be" | "utf-16" = "utf-8";
  let payload = bytes;

  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    // FF FE 00 00 is UTF-32 LE, not UTF-16 LE.
    if (bytes[2] === 0x00 && bytes[3] === 0x00) return "nul";
    encoding = "utf-16";
    payload = bytes.subarray(2);
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    payload = bytes.subarray(2);
  } else if (hasNulInTextSniff(bytes)) {
    return "nul";
  }

  try {
    if (encoding === "utf-16be") {
      if (payload.byteLength % 2 !== 0) return "encoding";
      const littleEndianPayload = new Uint8Array(payload.byteLength);
      for (let index = 0; index < payload.byteLength; index += 2) {
        littleEndianPayload[index] = payload[index + 1]!;
        littleEndianPayload[index + 1] = payload[index]!;
      }
      new TextDecoder("utf-16", { fatal: true }).decode(littleEndianPayload);
    } else {
      new TextDecoder(encoding, { fatal: true }).decode(payload);
    }
    return null;
  } catch {
    return "encoding";
  }
}

export const validateUploadAttachments = Effect.fn("validateUploadAttachments")(function* (
  attachments: ReadonlyArray<UploadChatAttachment>,
) {
  const validated: ValidatedAttachment[] = [];

  for (const attachment of attachments) {
    const finalExtension = getAttachmentFileExtension(attachment.name);
    const registeredFileType = lookupAttachmentFileType(attachment.name);
    if (finalExtension === "pdf" && attachment.type !== "document") {
      return yield* attachmentError(
        attachment.name,
        "uses the .pdf extension and must be uploaded as a document.",
      );
    }
    if (registeredFileType && attachment.type !== "file") {
      return yield* attachmentError(
        attachment.name,
        `uses the registered .${finalExtension} extension and must be uploaded as a file.`,
      );
    }
    if (attachment.type === "document" && finalExtension !== "pdf") {
      return yield* attachmentError(
        attachment.name,
        "must use .pdf as its final extension when uploaded as a document.",
      );
    }
    if (attachment.type === "file" && !registeredFileType) {
      return yield* attachmentError(
        attachment.name,
        "does not have a supported registered final extension.",
      );
    }

    const decoded = yield* decodeStrictBase64DataUrl(attachment);

    switch (attachment.type) {
      case "image": {
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
        break;
      }

      case "document": {
        if (!hasPdfSignature(decoded.bytes)) {
          return yield* attachmentError(
            attachment.name,
            "is not a PDF because '%PDF-' is absent from its first 1024 bytes.",
          );
        }
        validated.push({
          type: "document",
          name: attachment.name,
          mimeType: "application/pdf",
          sizeBytes: decoded.bytes.byteLength,
          bytes: decoded.bytes,
        });
        break;
      }

      case "file": {
        const fileType = registeredFileType;
        if (!fileType) {
          return yield* attachmentError(
            attachment.name,
            "does not have a supported registered final extension.",
          );
        }
        if (fileType.contentKind === "text") {
          const contentFailure = textContentFailure(decoded.bytes);
          if (contentFailure === "nul") {
            return yield* attachmentError(
              attachment.name,
              "contains unexplained NUL bytes in its first 8192 bytes and is not readable text.",
            );
          }
          if (contentFailure === "encoding") {
            return yield* attachmentError(
              attachment.name,
              "is not valid UTF-8 or BOM-marked UTF-16 text.",
            );
          }
        } else if (!hasXlsxSignature(decoded.bytes)) {
          return yield* attachmentError(
            attachment.name,
            "is not a valid .xlsx upload because it does not begin with PK\\x03\\x04.",
          );
        }
        validated.push({
          type: "file",
          name: attachment.name,
          mimeType: fileType.mimeType,
          sizeBytes: decoded.bytes.byteLength,
          bytes: decoded.bytes,
        });
        break;
      }
    }
  }

  return validated;
});
