import type { MessageId } from "@t3tools/contracts";

import {
  composerDraftHasUserContent,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "../../composerDraftStore";
import type { ChatMessage } from "../../types";
import { cloneComposerImageForRetry, revokeUserMessagePreviewUrls } from "../ChatView.logic";
import type { toastManager } from "../ui/toast";
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

/** A rejected send must leave the timeline even when a newer draft prevents restoration. */
export function removeFailedOptimisticMessage(messages: ChatMessage[], messageId: MessageId) {
  const next = messages.filter((message) => {
    if (message.id !== messageId) return true;
    revokeUserMessagePreviewUrls(message);
    return false;
  });
  return next.length === messages.length ? messages : next;
}

/** Retain the whole send separately, as V2's multi-model path does, to avoid attachment overflow. */
export function recoverFailedSendDraft(options: {
  target: ComposerThreadTarget;
  failedDraft: FailedSendDraft;
  isSendPending: () => boolean;
  onRestored: (draft: FailedSendDraft) => void;
  openComposer: () => void;
  toasts: Pick<typeof toastManager, "add" | "update" | "close">;
}) {
  let restored = false;
  const restore = () => {
    if (restored) return true;
    const store = useComposerDraftStore.getState();
    const current = store.getComposerDraft(options.target);
    if (
      (typeof options.target === "string" && !store.getDraftSession(options.target)) ||
      (current?.prompt.length ?? 0) > 0 ||
      composerDraftHasUserContent(current)
    ) {
      return false;
    }
    const draft = {
      ...options.failedDraft,
      images: options.failedDraft.images.map(cloneComposerImageForRetry),
    };
    store.setPrompt(options.target, draft.prompt);
    store.addImages(options.target, draft.images, { allowDuplicates: true });
    store.addFiles(options.target, draft.files, { allowDuplicates: true });
    store.setTerminalContexts(options.target, draft.terminalContexts);
    store.setPreviewAnnotations(options.target, draft.previewAnnotations);
    store.setReviewComments(options.target, draft.reviewComments);
    store.setThreadContexts(options.target, draft.threadContexts);
    restored = true;
    options.onRestored(store.getComposerDraft(options.target) ?? draft);
    return true;
  };

  // The failing send still owns the in-flight flag here. Only a later manual
  // restoration must wait for any subsequent send to release the composer.
  if (restore()) return;
  const recoveryToastId = options.toasts.add(
    stackedThreadToast({
      type: "error",
      title: "A prompt could not be sent",
      description:
        "Your newer draft is unchanged. Restore the failed prompt when its composer is empty.",
      timeout: 0,
      actionProps: {
        children: "Restore prompt",
        onClick: () => {
          if (options.isSendPending() || !restore()) {
            options.toasts.update(recoveryToastId, {
              description:
                "Send or clear the original composer's current draft before restoring the failed prompt.",
            });
            return;
          }
          options.openComposer();
          options.toasts.close(recoveryToastId);
        },
      },
    }),
  );
}
