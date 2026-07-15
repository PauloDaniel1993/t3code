import type {
  ChatDocumentAttachment as ContractChatDocumentAttachment,
  ChatFileAttachment as ContractChatFileAttachment,
  ChatImageAttachment as ContractChatImageAttachment,
} from "@t3tools/contracts";

/** Client-only image metadata used while an image preview is available. */
export interface ClientChatImageAttachment extends ContractChatImageAttachment {
  readonly previewUrl?: string;
}

/** Client-only document metadata used while a PDF asset can be opened. */
export interface ClientChatDocumentAttachment extends ContractChatDocumentAttachment {
  readonly assetUrl?: string;
}

/** Client-only generic file metadata used while the asset can be downloaded. */
export interface ClientChatFileAttachment extends ContractChatFileAttachment {
  readonly assetUrl?: string;
}

export type ClientChatAttachment =
  | ClientChatImageAttachment
  | ClientChatDocumentAttachment
  | ClientChatFileAttachment;

export interface PartitionedClientChatAttachments {
  readonly images: ReadonlyArray<ClientChatImageAttachment>;
  readonly documents: ReadonlyArray<ClientChatDocumentAttachment>;
  readonly files: ReadonlyArray<ClientChatFileAttachment>;
}

export function formatAttachmentSize(sizeBytes: number): string {
  const bytes = Math.max(0, sizeBytes);
  if (bytes < 1_024) return `${bytes} B`;
  const kibibytes = bytes / 1_024;
  if (kibibytes < 1_024) {
    return `${kibibytes >= 10 ? Math.round(kibibytes) : Number(kibibytes.toFixed(1))} KB`;
  }
  const mebibytes = kibibytes / 1_024;
  return `${mebibytes >= 10 ? Math.round(mebibytes) : Number(mebibytes.toFixed(1))} MB`;
}

/**
 * Ask the signed asset route for an original-name download. Non-HTTP URLs
 * (notably optimistic `blob:` URLs) remain untouched so the anchor's
 * `download` attribute can keep handling local drafts.
 */
export function attachmentDownloadUrl(assetUrl: string, originalName: string): string {
  try {
    const url = new URL(assetUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return assetUrl;
    }
    const lastSlashIndex = url.pathname.lastIndexOf("/");
    if (lastSlashIndex < 0) {
      return assetUrl;
    }
    url.pathname = `${url.pathname.slice(0, lastSlashIndex + 1)}${encodeURIComponent(originalName)}`;
    url.searchParams.set("download", "1");
    url.hash = "";
    return url.toString();
  } catch {
    return assetUrl;
  }
}

/**
 * Partition attachments without weakening their discriminated variants. This
 * keeps image-only preview and annotation paths from accidentally receiving
 * document attachments.
 */
export function partitionClientChatAttachments(
  attachments: ReadonlyArray<ClientChatAttachment>,
): PartitionedClientChatAttachments {
  const images: ClientChatImageAttachment[] = [];
  const documents: ClientChatDocumentAttachment[] = [];
  const files: ClientChatFileAttachment[] = [];

  for (const attachment of attachments) {
    switch (attachment.type) {
      case "image":
        images.push(attachment);
        break;
      case "document":
        documents.push(attachment);
        break;
      case "file":
        files.push(attachment);
        break;
    }
  }

  return { images, documents, files };
}
