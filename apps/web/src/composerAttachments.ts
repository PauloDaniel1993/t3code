import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_PDF_BYTES,
} from "@t3tools/contracts";

import type { ComposerAttachment, PersistedComposerAttachment } from "./composerDraftStore";

export const COMPOSER_ATTACHMENT_ACCEPT = "image/*,application/pdf,.pdf";

export interface PrepareComposerAttachmentsOptions {
  readonly existingCount: number;
  readonly createId: () => string;
  readonly createObjectUrl: (file: File) => string;
}

export interface PreparedComposerAttachments {
  readonly attachments: ComposerAttachment[];
  readonly error: string | null;
}

interface ComposerClipboardEventLike {
  readonly clipboardData: { readonly files: ArrayLike<File> };
  preventDefault: () => void;
}

interface ComposerDropEventLike {
  readonly dataTransfer: {
    readonly files: ArrayLike<File>;
    readonly types: { includes: (type: string) => boolean };
  };
  preventDefault: () => void;
}

interface ComposerAttachmentInputEventLike {
  readonly currentTarget: {
    readonly files: ArrayLike<File> | null;
    value: string;
  };
}

export interface ComposerAttachmentInteractionHandlers {
  readonly onPaste: (event: ComposerClipboardEventLike) => void;
  readonly onDrop: (event: ComposerDropEventLike) => void;
  readonly onInputChange: (event: ComposerAttachmentInputEventLike) => void;
}

/**
 * The concrete picker/paste/drop wiring used by ChatComposer. Keeping the
 * event translation here lets tests exercise each browser entry point instead
 * of calling attachment preparation directly and assuming the handlers match.
 */
export function createComposerAttachmentInteractionHandlers(options: {
  readonly addFiles: (files: File[]) => void;
  readonly focusComposer: () => void;
}): ComposerAttachmentInteractionHandlers {
  return {
    onPaste: (event) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length === 0) return;
      event.preventDefault();
      options.addFiles(files);
    },
    onDrop: (event) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      options.addFiles(Array.from(event.dataTransfer.files));
      options.focusComposer();
    },
    onInputChange: (event) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      options.addFiles(files);
    },
  };
}

export function isPdfFileCandidate(file: Pick<File, "name" | "type">): boolean {
  return (
    file.type.trim().toLowerCase() === "application/pdf" ||
    file.name.trim().toLowerCase().endsWith(".pdf")
  );
}

/** Canonicalize extension-only browser PDF files before draft persistence/upload. */
export function canonicalizePdfFile(file: File): File {
  if (file.type === "application/pdf") {
    return file;
  }
  return new File([file], file.name || "document.pdf", {
    type: "application/pdf",
    lastModified: file.lastModified,
  });
}

export function prepareComposerAttachments(
  files: ReadonlyArray<File>,
  options: PrepareComposerAttachmentsOptions,
): PreparedComposerAttachments {
  const attachments: ComposerAttachment[] = [];
  let nextCount = Math.max(0, options.existingCount);
  let error: string | null = null;

  for (const sourceFile of files) {
    const isPdf = isPdfFileCandidate(sourceFile);
    const isImage = sourceFile.type.toLowerCase().startsWith("image/");
    if (!isPdf && !isImage) {
      error = `Unsupported file type for '${sourceFile.name}'. Please attach images or PDF files.`;
      continue;
    }

    if (nextCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images and PDFs per message.`;
      break;
    }

    const file = isPdf ? canonicalizePdfFile(sourceFile) : sourceFile;
    if (isPdf && file.size > PROVIDER_SEND_TURN_MAX_PDF_BYTES) {
      error = `'${file.name}' exceeds the 10 MiB PDF attachment limit.`;
      continue;
    }
    if (isImage && file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      error = `'${file.name}' exceeds the 10 MiB image attachment limit.`;
      continue;
    }

    const id = options.createId();
    const objectUrl = options.createObjectUrl(file);
    attachments.push(
      isPdf
        ? {
            type: "document",
            id,
            name: file.name || "document.pdf",
            mimeType: "application/pdf",
            sizeBytes: file.size,
            assetUrl: objectUrl,
            file,
          }
        : {
            type: "image",
            id,
            name: file.name || "image",
            mimeType: file.type,
            sizeBytes: file.size,
            previewUrl: objectUrl,
            file,
          },
    );
    nextCount += 1;
  }

  return { attachments, error };
}

export function dispatchComposerAttachmentFiles(
  files: ReadonlyArray<File>,
  options: PrepareComposerAttachmentsOptions & {
    readonly addAttachments: (attachments: ComposerAttachment[]) => void;
    readonly setError: (error: string | null) => void;
  },
): PreparedComposerAttachments {
  const prepared = prepareComposerAttachments(files, options);
  if (prepared.attachments.length > 0) {
    options.addAttachments(prepared.attachments);
  }
  options.setError(prepared.error);
  return prepared;
}

export async function serializeComposerAttachmentsForPersistence(
  attachments: ReadonlyArray<ComposerAttachment>,
  existingPersistedAttachments: ReadonlyArray<PersistedComposerAttachment>,
  readFile: (file: File) => Promise<string>,
): Promise<PersistedComposerAttachment[]> {
  const existingPersistedById = new Map(
    existingPersistedAttachments.map((attachment) => [attachment.id, attachment]),
  );
  const serialized = await Promise.all(
    attachments.map(async (attachment): Promise<PersistedComposerAttachment | null> => {
      try {
        const dataUrl = await readFile(attachment.file);
        return attachment.type === "image"
          ? {
              type: "image",
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              dataUrl,
            }
          : {
              type: "document",
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              dataUrl,
            };
      } catch {
        return existingPersistedById.get(attachment.id) ?? null;
      }
    }),
  );
  return serialized.filter(
    (attachment): attachment is PersistedComposerAttachment => attachment !== null,
  );
}
