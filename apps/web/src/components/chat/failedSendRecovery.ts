import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";

import {
  composerDraftHasUserContent,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { readAttachmentUpload } from "../../lib/attachmentUploadQueue";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails } from "../../state/threads";
import type { ChatMessage } from "../../types";
import {
  cloneComposerImageForRetry,
  readFileAsDataUrl,
  revokeUserMessagePreviewUrls,
} from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import { stackedThreadToast } from "../ui/toastHelpers";

export type FailedSendDraft = Pick<
  ComposerThreadDraftState,
  | "prompt"
  | "images"
  | "files"
  | "terminalContexts"
  | "previewAnnotations"
  | "reviewComments"
  | "threadContexts"
>;

export function removeFailedOptimisticMessage(messages: ChatMessage[], messageId: MessageId) {
  const next = messages.filter((message) => {
    if (message.id !== messageId) return true;
    revokeUserMessagePreviewUrls(message);
    return false;
  });
  return next.length === messages.length ? messages : next;
}

function mergeById<T>(current: readonly T[], failed: readonly T[], key: (item: T) => string) {
  const merged = new Map(current.map((item) => [key(item), item]));
  for (const item of failed) if (!merged.has(key(item))) merged.set(key(item), item);
  return [...merged.values()];
}

function mergeTerminalContexts(
  current: FailedSendDraft["terminalContexts"],
  failed: FailedSendDraft["terminalContexts"],
) {
  const merged = [...current];
  for (const context of failed) {
    const index = merged.findIndex(
      (item) =>
        item.id === context.id ||
        (item.terminalId === context.terminalId &&
          item.lineStart === context.lineStart &&
          item.lineEnd === context.lineEnd),
    );
    const existing = merged[index];
    if (!existing) merged.push(context);
    else if (existing.text !== context.text) {
      // The store accepts only one chip per selection. Keep both versions of its
      // text and the failed chip's id; the setter removes the replaced newer chip.
      merged[index] = { ...existing, id: context.id, text: `${existing.text}\n\n${context.text}` };
    }
  }
  return merged;
}

/** Runs only after a single send fails. Plain empty composers retain upstream's restore path. */
export function recoverFailedSendDraft(options: {
  target: ComposerThreadTarget;
  threadRef: ScopedThreadRef;
  messageId: MessageId;
  failedDraft: FailedSendDraft;
  isOriginalRoute: () => boolean;
  onRestored: (draft: FailedSendDraft) => void;
}) {
  // Read the sending thread's latest projection, even after navigation. A transport
  // failure alone cannot tell us whether the server committed the message.
  const projection = appAtomRegistry.get(environmentThreadDetails.threadAtom(options.threadRef));
  if (projection?.projection.messages.some((message) => message.id === options.messageId)) {
    return true;
  }
  const store = useComposerDraftStore.getState();
  const target =
    typeof options.target === "string" && !store.getDraftSession(options.target)
      ? options.threadRef
      : options.target;
  const current = store.getComposerDraft(target);
  const failed = options.failedDraft;
  if (
    target === options.target &&
    options.isOriginalRoute() &&
    !current?.prompt.length &&
    !composerDraftHasUserContent(current) &&
    failed.images.length + failed.files.length === 0
  ) {
    return false;
  }

  const attachments = [...(current?.images ?? []), ...(current?.files ?? [])];
  const ids = new Set(attachments.map((attachment) => attachment.id));
  const restored = [];
  const dropped = [];
  for (const attachment of [...failed.images, ...failed.files]) {
    if (ids.has(attachment.id)) continue;
    if (attachments.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      dropped.push(attachment.name);
      continue;
    }
    // Distinct files with identical metadata can contain different authored bytes.
    // Only the same attachment id is safe to deduplicate.
    const upload = readAttachmentUpload(attachment.id);
    const retry =
      attachment.type === "image"
        ? cloneComposerImageForRetry(attachment)
        : upload?.status === "ready"
          ? {
              ...attachment,
              uploadedAttachmentId: upload.attachmentId,
              uploadEnvironmentId: upload.environmentId,
            }
          : attachment;
    attachments.push(retry);
    restored.push(retry);
    ids.add(attachment.id);
  }
  const prompt = current?.prompt ?? "";
  store.setPrompt(
    target,
    prompt.length === 0
      ? failed.prompt
      : failed.prompt.length === 0 || prompt === failed.prompt
        ? prompt
        : `${prompt}\n\n${failed.prompt}`,
  );
  store.addImages(
    target,
    restored.filter((attachment) => attachment.type === "image"),
    {
      allowDuplicates: true,
    },
  );
  store.addFiles(
    target,
    restored.filter((attachment) => attachment.type === "file"),
    {
      allowDuplicates: true,
    },
  );
  store.setTerminalContexts(
    target,
    mergeTerminalContexts(current?.terminalContexts ?? [], failed.terminalContexts),
  );
  store.setPreviewAnnotations(
    target,
    mergeById(current?.previewAnnotations ?? [], failed.previewAnnotations, (item) => item.id),
  );
  store.setReviewComments(
    target,
    mergeById(current?.reviewComments ?? [], failed.reviewComments, (item) => item.id),
  );
  store.setThreadContexts(
    target,
    mergeById(current?.threadContexts ?? [], failed.threadContexts, (item) => item.contextId),
  );
  const draft = store.getComposerDraft(target);
  if (draft && options.isOriginalRoute()) options.onRestored(draft);
  // The mounted composer saves its own images. Offscreen reads must not delay
  // the send error or spinner; re-read ownership after promotion or typing.
  if (!options.isOriginalRoute()) {
    void (async () => {
      const serialized = await Promise.allSettled(
        (draft?.images ?? []).map(async (image) => ({
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          ...(image.source ? { source: image.source } : {}),
          dataUrl: await readFileAsDataUrl(image.file),
        })),
      );
      const persistenceTarget =
        typeof target === "string" && !store.getDraftSession(target) ? options.threadRef : target;
      const latest = store.getComposerDraft(persistenceTarget);
      if (latest && serialized.length > 0) {
        const persistedImages = serialized.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const imageIds = new Set(latest.images.map((image) => image.id));
        await store.syncPersistedAttachments(
          persistenceTarget,
          mergeById(latest.persistedAttachments, persistedImages, (item) => item.id).filter(
            (image) => imageIds.has(image.id),
          ),
        );
        const unreadableNames = serialized.flatMap((result, index) =>
          result.status === "rejected" ? [draft!.images[index]!.name] : [],
        );
        if (unreadableNames.length > 0) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Some images could not be saved for reload",
              description: `${unreadableNames.join(", ")}. Keep this composer open and attach these images again.`,
              data: { threadRef: options.threadRef },
              timeout: 0,
            }),
          );
        }
      }
    })();
  }
  if (dropped.length > 0) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Some failed attachments could not be restored",
        description: `${dropped.map((name) => `'${name}'`).join(", ")} could not be restored because a message can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments. Attach them again in a separate message.`,
        data: { threadRef: options.threadRef },
        timeout: 0,
      }),
    );
  }
  return true;
}
