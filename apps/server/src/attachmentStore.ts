// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";
import {
  getAttachmentFileExtension,
  lookupAttachmentFileType,
} from "@t3tools/shared/attachmentFileTypes";

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

export const PENDING_ATTACHMENT_THREAD_SEGMENT = "pending";
export const PENDING_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PARTIAL_UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

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
  return segment === PENDING_ATTACHMENT_THREAD_SEGMENT ? "_pending" : segment;
}

export function createPendingAttachmentId(): string {
  return `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${NodeCrypto.randomUUID()}`;
}

export function parseAttachmentUuid(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  return normalizedId.match(ATTACHMENT_ID_PATTERN)?.[2]?.toLowerCase() ?? null;
}

export function toCanonicalThreadAttachmentSegment(threadId: string): string | null {
  const segment = toSafeThreadAttachmentSegment(threadId);
  return segment === threadId ? segment : null;
}

export function createAttachmentId(threadId: string): string | null {
  const threadSegment = toCanonicalThreadAttachmentSegment(threadId);
  if (!threadSegment) return null;
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
  const expectedThreadSegment = toCanonicalThreadAttachmentSegment(input.threadId);
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
    case "document": {
      if (getAttachmentFileExtension(attachment.name) !== "pdf") {
        throw new Error(`Attachment '${attachment.name}' does not have a .pdf final extension.`);
      }
      return `${attachment.id}.pdf`;
    }
    case "file": {
      const fileType = lookupAttachmentFileType(attachment.name);
      const extension = getAttachmentFileExtension(attachment.name);
      if (!fileType || !extension) {
        throw new Error(`Attachment '${attachment.name}' does not have a registered extension.`);
      }
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

export type AttachmentClaimPlan =
  | {
      readonly ok: true;
      readonly finalId: string;
      readonly currentPath: string;
      readonly finalPath: string;
    }
  | { readonly ok: false; readonly reason: string };

export function planAttachmentClaim(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly attachmentId: string;
}): AttachmentClaimPlan {
  const uuid = parseAttachmentUuid(input.attachmentId);
  const requestedSegment = parseThreadSegmentFromAttachmentId(input.attachmentId);
  if (!uuid || !requestedSegment) {
    return { ok: false, reason: "invalid attachment id" };
  }

  if (!toCanonicalThreadAttachmentSegment(input.threadId)) {
    return { ok: false, reason: "invalid thread id" };
  }
  if (requestedSegment !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
    return { ok: false, reason: "attachment must be a pending upload" };
  }

  const currentPath = resolveAttachmentPathById({
    attachmentsDir: input.attachmentsDir,
    attachmentId: input.attachmentId,
  });
  if (!currentPath) {
    return { ok: false, reason: "attachment not found (removed or expired)" };
  }
  const finalId = createAttachmentId(input.threadId);
  if (!finalId) {
    return { ok: false, reason: "failed to create attachment id" };
  }

  const expectedFinalPath = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: `${finalId}${NodePath.extname(currentPath)}`,
  });
  if (!expectedFinalPath) {
    return { ok: false, reason: "failed to resolve attachment path" };
  }
  return {
    ok: true,
    finalId,
    currentPath,
    finalPath: expectedFinalPath,
  };
}

export function sweepStalePendingAttachments(input: {
  readonly attachmentsDir: string;
  readonly nowMs: number;
}): { readonly deleted: number } {
  let entries: string[];
  try {
    entries = NodeFS.readdirSync(input.attachmentsDir);
  } catch {
    return { deleted: 0 };
  }

  let deleted = 0;
  for (const entry of entries) {
    const isPartial = entry.endsWith(".part");
    if (!isPartial) {
      const attachmentId = parseAttachmentIdFromRelativePath(entry);
      if (
        !attachmentId ||
        parseThreadSegmentFromAttachmentId(attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT
      ) {
        continue;
      }
    }

    const resolved = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: entry,
    });
    if (!resolved) {
      continue;
    }
    try {
      const maxAgeMs = isPartial ? PARTIAL_UPLOAD_MAX_AGE_MS : PENDING_ATTACHMENT_MAX_AGE_MS;
      if (input.nowMs - NodeFS.statSync(resolved).mtimeMs > maxAgeMs) {
        NodeFS.unlinkSync(resolved);
        deleted += 1;
      }
    } catch {
      continue;
    }
  }

  return { deleted };
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
