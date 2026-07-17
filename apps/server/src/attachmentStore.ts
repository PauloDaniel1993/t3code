// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import type { ChatAttachment } from "@t3tools/contracts";
import { lookupAttachmentFileType } from "@t3tools/shared/attachmentFileTypes";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

const LEGACY_IMAGE_FILENAME_EXTENSIONS = [...SAFE_IMAGE_FILE_EXTENSIONS, ".bin"];
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const ATTACHMENT_ID_THREAD_ID_CONSTRAINT_MESSAGE =
  "Attachment staging requires a thread ID with only lowercase letters, digits, underscores, and single hyphens; it cannot begin or end with a separator and must be at most 80 characters.";
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})$`,
  "i",
);

export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment;
}

export function createAttachmentId(threadId: string): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (threadSegment !== threadId) {
    return null;
  }
  return `${threadSegment}-${NodeCrypto.randomUUID()}`;
}

export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const match = normalizedId.match(ATTACHMENT_ID_PATTERN);
  if (!match) {
    return null;
  }
  return match[1]?.toLowerCase() ?? null;
}

export function isAttachmentOwnedByThread(input: {
  readonly attachmentId: string;
  readonly threadId: string;
}): boolean {
  const expectedThreadSegment = toSafeThreadAttachmentSegment(input.threadId);
  const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(input.attachmentId);
  return expectedThreadSegment !== null && attachmentThreadSegment === expectedThreadSegment;
}

export function attachmentRelativePath(attachment: ChatAttachment): string {
  switch (attachment.type) {
    case "image": {
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
    case "document":
      return `${attachment.id}.pdf`;
    case "file": {
      const fileType = lookupAttachmentFileType(attachment.name);
      const extensionIndex = attachment.name.lastIndexOf(".");
      if (!fileType || extensionIndex <= 0 || extensionIndex === attachment.name.length - 1) {
        throw new Error(`Attachment '${attachment.name}' does not have a registered extension.`);
      }
      const extension = attachment.name.slice(extensionIndex + 1).toLowerCase();
      return `${attachment.id}.${extension}`;
    }
  }
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
  readonly threadId?: string;
}): string | null {
  if (
    input.threadId !== undefined &&
    !isAttachmentOwnedByThread({ attachmentId: input.attachment.id, threadId: input.threadId })
  ) {
    return null;
  }

  try {
    return resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: attachmentRelativePath(input.attachment),
    });
  } catch {
    return null;
  }
}

/** Legacy image-only lookup for claims issued before typed attachment metadata was signed. */
export function resolveAttachmentPathById(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
  readonly threadId?: string;
}): string | null {
  if (
    input.threadId !== undefined &&
    !isAttachmentOwnedByThread({ attachmentId: input.attachmentId, threadId: input.threadId })
  ) {
    return null;
  }

  const normalizedId = normalizeAttachmentRelativePath(input.attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  for (const extension of LEGACY_IMAGE_FILENAME_EXTENSIONS) {
    const maybePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}${extension}`,
    });
    if (maybePath && NodeFS.existsSync(maybePath)) {
      return maybePath;
    }
  }
  return null;
}

export function parseAttachmentIdFromRelativePath(relativePath: string): string | null {
  const normalized = normalizeAttachmentRelativePath(relativePath);
  if (!normalized || normalized.includes("/")) {
    return null;
  }
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return null;
  }
  const id = normalized.slice(0, extensionIndex);
  return id.length > 0 && !id.includes(".") ? id : null;
}
