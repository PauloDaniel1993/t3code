import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_DOCUMENT_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import {
  getAttachmentFileInputAccept,
  lookupAttachmentFileType,
} from "@t3tools/shared/attachmentFileTypes";

import type { ComposerAttachment } from "./composerDraftStore";

export const COMPOSER_ATTACHMENT_INPUT_ACCEPT = [
  "image/*",
  "application/pdf",
  ".pdf",
  getAttachmentFileInputAccept(),
].join(",");

export type AttachmentPreparationRejectionReason = "unsupported" | "empty" | "oversized" | "count";

export interface AttachmentPreparationRejection {
  readonly fileName: string;
  readonly reason: AttachmentPreparationRejectionReason;
  readonly message: string;
}

export interface AttachmentPreparationResult {
  readonly attachments: ComposerAttachment[];
  readonly rejections: AttachmentPreparationRejection[];
}

function sizeLimitLabel(limit: number): string {
  return `${Math.round(limit / (1024 * 1024))} MiB`;
}

function displayName(file: File): string {
  return file.name || "attachment";
}

function classifyFile(
  file: File,
):
  | { readonly type: "image"; readonly mimeType: string; readonly maxBytes: number }
  | { readonly type: "document"; readonly mimeType: "application/pdf"; readonly maxBytes: number }
  | { readonly type: "file"; readonly mimeType: string; readonly maxBytes: number }
  | null {
  if (file.type.toLowerCase().startsWith("image/")) {
    return {
      type: "image",
      mimeType: file.type,
      maxBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
    };
  }
  if (file.type.toLowerCase() === "application/pdf" || /\.pdf$/i.test(file.name)) {
    return {
      type: "document",
      mimeType: "application/pdf",
      maxBytes: PROVIDER_SEND_TURN_MAX_DOCUMENT_BYTES,
    };
  }
  const registered = lookupAttachmentFileType(file.name);
  return registered
    ? {
        type: "file",
        mimeType: registered.mimeType,
        maxBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
      }
    : null;
}

export function prepareComposerAttachments(
  files: ReadonlyArray<File>,
  options: {
    readonly existingCount: number;
    readonly createId: () => string;
    readonly createImagePreviewUrl?: (file: File) => string;
  },
): AttachmentPreparationResult {
  const attachments: ComposerAttachment[] = [];
  const rejections: AttachmentPreparationRejection[] = [];
  let count = Math.max(0, options.existingCount);

  for (const file of files) {
    const name = displayName(file);
    const classification = classifyFile(file);
    if (!classification) {
      rejections.push({
        fileName: name,
        reason: "unsupported",
        message: `'${name}' is unsupported. Attach images, PDFs, or supported text, code, data, and spreadsheet files.`,
      });
      continue;
    }
    if (classification.type !== "image" && file.size === 0) {
      const category = classification.type === "document" ? "PDF" : "file";
      rejections.push({
        fileName: name,
        reason: "empty",
        message: `'${name}' is an empty ${category} and cannot be attached.`,
      });
      continue;
    }
    if (file.size > classification.maxBytes) {
      const category =
        classification.type === "image"
          ? "image"
          : classification.type === "document"
            ? "PDF"
            : "file";
      rejections.push({
        fileName: name,
        reason: "oversized",
        message: `'${name}' exceeds the ${sizeLimitLabel(classification.maxBytes)} ${category} limit.`,
      });
      continue;
    }
    if (count >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      rejections.push({
        fileName: name,
        reason: "count",
        message: `'${name}' was not attached because a message can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      });
      continue;
    }

    const base = {
      id: options.createId(),
      name,
      mimeType: classification.mimeType,
      sizeBytes: file.size,
      file,
    };
    if (classification.type === "image") {
      let previewUrl: string;
      try {
        previewUrl = options.createImagePreviewUrl?.(file) ?? URL.createObjectURL(file);
      } catch {
        rejections.push({
          fileName: name,
          reason: "unsupported",
          message: `'${name}' could not be prepared as an image attachment.`,
        });
        continue;
      }
      attachments.push({ ...base, type: "image", previewUrl });
    } else if (classification.type === "document") {
      attachments.push({ ...base, type: "document" } as ComposerAttachment);
    } else {
      attachments.push({ ...base, type: "file" } as ComposerAttachment);
    }
    count += 1;
  }

  return { attachments, rejections };
}

export function formatAttachmentPreparationError(
  rejections: ReadonlyArray<AttachmentPreparationRejection>,
): string | null {
  return rejections.length > 0 ? rejections.map((rejection) => rejection.message).join("\n") : null;
}
