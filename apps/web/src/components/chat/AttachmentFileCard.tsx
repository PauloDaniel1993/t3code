import type { ChatDocumentAttachment, ChatFileAttachment } from "@t3tools/contracts";
import { DownloadIcon, ExternalLinkIcon, FileIcon, FileTextIcon, XIcon } from "lucide-react";

import type { ComposerDocumentAttachment, ComposerFileAttachment } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export type DraftFileCardAttachment = ComposerDocumentAttachment | ComposerFileAttachment;
export type PersistedFileCardAttachment = ChatDocumentAttachment | ChatFileAttachment;

export interface AttachmentFileCardProps {
  readonly attachment: DraftFileCardAttachment | PersistedFileCardAttachment;
  readonly variant: "draft" | "persisted";
  readonly openUrl?: string | null | undefined;
  readonly downloadUrl?: string | null | undefined;
  readonly onRemove?: (() => void) | undefined;
  readonly className?: string | undefined;
}

export function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024)
    return `${(sizeBytes / 1024).toFixed(sizeBytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(sizeBytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
}

function extensionBadge(name: string, type: "document" | "file"): string {
  const finalDot = name.lastIndexOf(".");
  const extension = finalDot > 0 && finalDot < name.length - 1 ? name.slice(finalDot + 1) : "";
  return (extension || (type === "document" ? "PDF" : "FILE")).toUpperCase();
}

export function AttachmentFileCard({
  attachment,
  variant,
  openUrl,
  downloadUrl,
  onRemove,
  className,
}: AttachmentFileCardProps) {
  const isPdf = attachment.type === "document";
  const Icon = isPdf ? FileTextIcon : FileIcon;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-lg border border-border/80 bg-background/70 px-2.5 py-2",
        className,
      )}
      data-attachment-kind={attachment.type}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-xs font-medium text-foreground/90"
          title={attachment.name}
        >
          {attachment.name}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="rounded border border-border/70 px-1 font-medium tracking-wide">
            {extensionBadge(attachment.name, attachment.type)}
          </span>
          <span>{formatAttachmentSize(attachment.sizeBytes)}</span>
        </span>
      </span>
      {variant === "draft" && onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onRemove}
          aria-label={`Remove ${attachment.name}`}
        >
          <XIcon />
        </Button>
      ) : null}
      {variant === "persisted" && isPdf && openUrl ? (
        <Button
          render={
            <a
              href={openUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${attachment.name}`}
            />
          }
          variant="ghost"
          size="icon-xs"
        >
          <ExternalLinkIcon />
        </Button>
      ) : null}
      {variant === "persisted" && downloadUrl ? (
        <Button
          render={
            <a
              href={downloadUrl}
              download={attachment.name}
              aria-label={`Download ${attachment.name}`}
            />
          }
          variant="ghost"
          size="icon-xs"
        >
          <DownloadIcon />
        </Button>
      ) : null}
    </div>
  );
}
