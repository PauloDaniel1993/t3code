import { DownloadIcon, ExternalLinkIcon, FileTextIcon, XIcon } from "lucide-react";
import {
  attachmentDownloadUrl,
  formatAttachmentSize,
} from "@t3tools/client-runtime/state/attachments";

import type { ChatDocumentAttachment, ChatFileAttachment } from "../../types";
import { cn } from "~/lib/utils";

export interface FileAttachmentCardProps {
  readonly attachment: ChatDocumentAttachment | ChatFileAttachment;
  readonly mode: "draft" | "history";
  readonly onRemove?: (() => void) | undefined;
  readonly persistenceWarning?: boolean | undefined;
  readonly className?: string | undefined;
}

const actionClassName =
  "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35";

function attachmentBadge(attachment: ChatDocumentAttachment | ChatFileAttachment): string {
  if (attachment.type === "document") {
    return "PDF";
  }
  const extensionIndex = attachment.name.lastIndexOf(".");
  if (extensionIndex <= 0 || extensionIndex === attachment.name.length - 1) {
    return "FILE";
  }
  return attachment.name.slice(extensionIndex + 1).toUpperCase();
}

export function FileAttachmentCard({
  attachment,
  mode,
  onRemove,
  persistenceWarning = false,
  className,
}: FileAttachmentCardProps) {
  const isPdf = attachment.type === "document";
  const url = attachment.assetUrl;
  const downloadUrl = url ? attachmentDownloadUrl(url, attachment.name) : null;
  const openLabel = `Open ${attachment.name}`;
  const downloadLabel = `Download ${attachment.name}`;

  return (
    <div
      className={cn(
        "flex min-w-0 max-w-[22rem] items-center gap-2 rounded-lg border border-border/80 bg-background/80 px-2.5 py-2",
        className,
      )}
      data-file-attachment-card={attachment.type}
      data-pdf-attachment-card={isPdf ? "true" : undefined}
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-md",
          isPdf ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-muted text-muted-foreground",
        )}
      >
        <FileTextIcon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-xs font-medium text-foreground"
          title={attachment.name}
        >
          {attachment.name}
        </span>
        <span className="block text-[11px] text-muted-foreground">
          {attachmentBadge(attachment)} · {formatAttachmentSize(attachment.sizeBytes)}
          {persistenceWarning ? " · may not persist" : ""}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        {isPdf ? (
          url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className={actionClassName}
              aria-label={openLabel}
            >
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            </a>
          ) : (
            <button type="button" disabled className={actionClassName} aria-label={openLabel}>
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            </button>
          )
        ) : null}
        {mode === "history" ? (
          downloadUrl ? (
            <a
              href={downloadUrl}
              download={attachment.name}
              className={actionClassName}
              aria-label={downloadLabel}
            >
              <DownloadIcon className="size-3.5" aria-hidden="true" />
            </a>
          ) : (
            <button type="button" disabled className={actionClassName} aria-label={downloadLabel}>
              <DownloadIcon className="size-3.5" aria-hidden="true" />
            </button>
          )
        ) : null}
        {mode === "draft" && onRemove ? (
          <button
            type="button"
            className={actionClassName}
            aria-label={`Remove ${attachment.name}`}
            onClick={onRemove}
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </span>
    </div>
  );
}
