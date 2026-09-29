import type { ToastManagerAddOptions } from "@base-ui/react/toast";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DraftId,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { threadContextRecord } from "../../lib/composerContextRecords";
import type { ChatMessage } from "../../types";
import type { ThreadToastData } from "../ui/toast";
import {
  type FailedSendDraft,
  recoverFailedSendDraft,
  removeFailedOptimisticMessage,
} from "./failedSendRecovery";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("sending-thread");
const target = scopeThreadRef(environmentId, threadId);
const now = "2026-09-29T00:00:00.000Z";

function resetDrafts() {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
}

function makeDraft(label: string): FailedSendDraft {
  const image = new File([label], `${label}.png`, { type: "image/png" });
  const file = new File([label], `${label}.txt`, { type: "text/plain" });
  return {
    prompt: `${label} prompt`,
    images: [
      {
        type: "image",
        id: `${label}-image`,
        name: image.name,
        mimeType: image.type,
        sizeBytes: image.size,
        previewUrl: `blob:${label}`,
        file: image,
      },
    ],
    files: [
      {
        type: "file",
        id: `${label}-file`,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
        uploadedAttachmentId: `${label}-upload`,
        uploadEnvironmentId: environmentId,
      },
    ],
    terminalContexts: [
      {
        id: `${label}-terminal`,
        threadId,
        terminalId: "terminal",
        terminalLabel: "Terminal",
        lineStart: 1,
        lineEnd: 2,
        text: `${label} terminal output`,
        createdAt: now,
      },
    ],
    previewAnnotations: [
      {
        id: `${label}-annotation`,
        pageUrl: "https://example.com",
        pageTitle: "Preview",
        comment: `${label} annotation`,
        elements: [],
        regions: [],
        strokes: [],
        styleChanges: [],
        screenshot: null,
        createdAt: now,
      },
    ],
    reviewComments: [
      {
        id: `${label}-review`,
        sectionId: "file:example.ts",
        sectionTitle: "File comment",
        filePath: "example.ts",
        startIndex: 0,
        endIndex: 1,
        rangeLabel: "L1",
        text: `${label} review`,
        diff: "@@ -1 +1 @@\n-example\n+updated",
      },
    ],
    threadContexts: [threadContextRecord(target, `${label} context thread`)],
  };
}

function writeDraft(draft: FailedSendDraft, destination: ComposerThreadTarget = target) {
  const store = useComposerDraftStore.getState();
  store.setPrompt(destination, draft.prompt);
  store.addImages(destination, draft.images, { allowDuplicates: true });
  store.addFiles(destination, draft.files, { allowDuplicates: true });
  store.setTerminalContexts(destination, draft.terminalContexts);
  store.setPreviewAnnotations(destination, draft.previewAnnotations);
  store.setReviewComments(destination, draft.reviewComments);
  store.setThreadContexts(destination, draft.threadContexts);
  const saved = store.getComposerDraft(destination);
  if (!saved) throw new Error("Draft fixture was not saved");
  return saved;
}

function recoveryOptions(failedDraft: FailedSendDraft, destination = target) {
  const toasts = {
    add: vi.fn((_toast: ToastManagerAddOptions<ThreadToastData>) => "recovery"),
    update: vi.fn(),
    close: vi.fn(),
  };
  return {
    target: destination,
    failedDraft,
    isSendPending: () => false,
    onRestored: vi.fn(),
    openComposer: vi.fn(),
    toasts,
  };
}

function clickRestore(options: ReturnType<typeof recoveryOptions>) {
  const action = options.toasts.add.mock.calls[0]?.[0].actionProps?.onClick;
  if (!action) throw new Error("No recovery action was offered");
  Reflect.apply(action, undefined, []);
}

function message(id: string, draft: FailedSendDraft): ChatMessage {
  return {
    id: MessageId.make(id),
    role: "user",
    text: draft.prompt,
    attachments: draft.images,
    runId: null,
    createdAt: now,
    updatedAt: now,
    streaming: false,
  };
}

describe("single-send failure recovery", () => {
  beforeEach(() => {
    resetDrafts();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retry");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });
  afterEach(() => {
    resetDrafts();
    vi.restoreAllMocks();
  });

  it("keeps a newer draft and recovers every failed payload after a pending send rejects", async () => {
    const failedDraft = writeDraft(makeDraft("failed"));
    const failedMessage = message("failed-message", failedDraft);
    const sentMessage = message("sent-message", makeDraft("sent"));
    let messages = [sentMessage, failedMessage];
    let rejectSend: (error: Error) => void = () => {
      throw new Error("Send promise was not initialized");
    };
    const send = new Promise<void>((_resolve, reject) => {
      rejectSend = reject;
    });
    const options = recoveryOptions(failedDraft);
    const settled = send.catch(() => {
      messages = removeFailedOptimisticMessage(messages, failedMessage.id);
      recoverFailedSendDraft(options);
    });
    useComposerDraftStore.getState().clearComposerContent(target);
    const newerDraft = writeDraft(makeDraft("newer"));
    rejectSend(new Error("Send rejected"));
    await settled;

    expect(messages).toEqual([sentMessage]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:failed");
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:sent");
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBe(newerDraft);
    expect(options.toasts.add.mock.calls[0]?.[0].timeout).toBe(0);
    clickRestore(options);
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBe(newerDraft);
    expect(options.toasts.close).not.toHaveBeenCalled();

    useComposerDraftStore.getState().clearComposerContent(target);
    clickRestore(options);
    const restored = useComposerDraftStore.getState().getComposerDraft(target);
    expect(restored).toMatchObject({
      prompt: failedDraft.prompt,
      images: [{ ...failedDraft.images[0], previewUrl: "blob:retry" }],
      files: failedDraft.files,
      terminalContexts: failedDraft.terminalContexts,
      previewAnnotations: failedDraft.previewAnnotations,
      reviewComments: failedDraft.reviewComments,
      threadContexts: failedDraft.threadContexts,
    });
    expect(restored?.images[0]?.file).toBe(failedDraft.images[0]?.file);
    expect(restored?.files[0]?.file).toBe(failedDraft.files[0]?.file);
    expect(newerDraft.prompt).toContain("newer prompt");
    expect(options.toasts.close).toHaveBeenCalledWith("recovery");
  });

  it("restores an empty composer immediately, even while the failing send owns the pending flag", () => {
    const failed = writeDraft(makeDraft("failed"));
    useComposerDraftStore.getState().clearComposerContent(target);
    const options = { ...recoveryOptions(failed), isSendPending: () => true };
    recoverFailedSendDraft(options);
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toMatchObject({
      ...failed,
      images: [{ ...failed.images[0], previewUrl: "blob:retry" }],
    });
    expect(options.toasts.add).not.toHaveBeenCalled();
  });

  it("retains two full attachment sets separately without exceeding the composer limit", () => {
    const fullDraft = (label: string) => {
      const draft = makeDraft(label);
      return {
        ...draft,
        files: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 }, (_, index) => ({
          ...draft.files[0]!,
          id: `${label}-file-${index}`,
        })),
      };
    };
    const failed = writeDraft(fullDraft("failed"));
    useComposerDraftStore.getState().clearComposerContent(target);
    const newer = writeDraft(fullDraft("newer"));
    const options = recoveryOptions(failed);
    recoverFailedSendDraft(options);
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBe(newer);
    expect(newer.images.length + newer.files.length).toBe(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
    useComposerDraftStore.getState().clearComposerContent(target);
    clickRestore(options);
    const restored = useComposerDraftStore.getState().getComposerDraft(target);
    expect(restored?.files).toEqual(failed.files);
    expect((restored?.images.length ?? 0) + (restored?.files.length ?? 0)).toBe(
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    );
  });

  it.each([
    "prompt",
    "images",
    "files",
    "terminalContexts",
    "previewAnnotations",
    "reviewComments",
    "threadContexts",
  ] as const)("does not overwrite a newer draft containing only %s", (field) => {
    const failed = makeDraft("failed");
    const empty: FailedSendDraft = {
      prompt: "",
      images: [],
      files: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
    };
    const newer = writeDraft({ ...empty, [field]: makeDraft("newer")[field] });
    const options = recoveryOptions(failed);
    recoverFailedSendDraft(options);
    clickRestore(options);
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBe(newer);
    expect(options.toasts.close).not.toHaveBeenCalled();
  });

  it("preserves whitespace typed while sending", () => {
    useComposerDraftStore.getState().setPrompt(target, " \n ");
    const options = recoveryOptions(makeDraft("failed"));
    recoverFailedSendDraft(options);
    clickRestore(options);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(" \n ");
  });

  it("waits for a subsequent pending send before restoring into its cleared composer", () => {
    writeDraft(makeDraft("newer"));
    let pending = true;
    const options = { ...recoveryOptions(makeDraft("failed")), isSendPending: () => pending };
    recoverFailedSendDraft(options);
    useComposerDraftStore.getState().clearComposerContent(target);
    clickRestore(options);
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
    pending = false;
    clickRestore(options);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toContain(
      "failed prompt",
    );
  });

  it("restores only the original environment's composer after navigation", () => {
    const other = scopeThreadRef(EnvironmentId.make("remote"), threadId);
    const failed = writeDraft(makeDraft("failed"));
    useComposerDraftStore.getState().clearComposerContent(target);
    const otherDraft = writeDraft(makeDraft("other"), other);
    recoverFailedSendDraft(recoveryOptions(failed));
    expect(useComposerDraftStore.getState().getComposerDraft(other)).toBe(otherDraft);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(failed.prompt);
  });

  it("does not resurrect a removed local draft", () => {
    const options = recoveryOptions(makeDraft("failed"));
    recoverFailedSendDraft({ ...options, target: DraftId.make("removed-draft") });
    clickRestore(options);
    expect(useComposerDraftStore.getState().draftsByThreadKey).toEqual({});
    expect(options.toasts.close).not.toHaveBeenCalled();
  });

  it("cannot duplicate restoration or overwrite work typed after restoring", () => {
    writeDraft(makeDraft("newer"));
    const options = recoveryOptions(makeDraft("failed"));
    recoverFailedSendDraft(options);
    useComposerDraftStore.getState().clearComposerContent(target);
    clickRestore(options);
    useComposerDraftStore.getState().setPrompt(target, "Work after restoration");
    const restored = useComposerDraftStore.getState().getComposerDraft(target);
    clickRestore(options);
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBe(restored);
    expect(restored?.images).toHaveLength(1);
    expect(restored?.files).toHaveLength(1);
  });
});
