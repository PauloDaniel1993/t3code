import { DownloadIcon, ExternalLinkIcon, FileTextIcon, XIcon } from "lucide-react";
import {
  attachmentDownloadUrl,
  formatAttachmentSize,
} from "@t3tools/client-runtime/state/attachments";

import type { ChatDocumentAttachment } from "../../types";
import { cn } from "~/lib/utils";

export interface PdfAttachmentCardProps {
  readonly attachment: ChatDocumentAttachment;
  readonly mode: "draft" | "history";
  readonly onRemove?: (() => void) | undefined;
  readonly persistenceWarning?: boolean | undefined;
  readonly className?: string | undefined;
}

const actionClassName =
  "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35";

export function PdfAttachmentCard({
  attachment,
  mode,
  onRemove,
  persistenceWarning = false,
  className,
}: PdfAttachmentCardProps) {
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
      data-pdf-attachment-card="true"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-red-500/10 text-red-600 dark:text-red-400">
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
          PDF · {formatAttachmentSize(attachment.sizeBytes)}
          {persistenceWarning ? " · may not persist" : ""}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        {url ? (
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
        )}
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
