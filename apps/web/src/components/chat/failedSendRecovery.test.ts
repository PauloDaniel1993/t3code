// @vitest-environment jsdom
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DraftId,
  type ComposerThreadTarget,
  useComposerDraftStore,
  composerFileNeedsReattach,
  markPromotedDraftThreadByRef,
  finalizePromotedDraftThreadByRef,
} from "../../composerDraftStore";
import { threadContextRecord } from "../../lib/composerContextRecords";
import { type FailedSendDraft } from "./failedSendRecovery";
import { createSendHarness } from "./ChatView.send.testSupport";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  toasts: { add: vi.fn(), close: vi.fn(), update: vi.fn() },
  retry: vi.fn(),
  uploads: vi.fn(),
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { get: mocks.get } }));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { threadAtom: (ref: unknown) => ref },
  environmentThreadShells: {},
}));
vi.mock("../ui/toast", () => ({ toastManager: mocks.toasts }));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  readAttachmentUpload: () => undefined,
  retryAttachmentUpload: mocks.retry,
  startAttachmentUpload: vi.fn(),
  awaitAttachmentUploads: async () => {},
  releaseDraftAttachments: vi.fn(),
  getUploadedAttachments: mocks.uploads,
}));

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("sending-thread");
const target = scopeThreadRef(environmentId, threadId);
const now = "2026-09-29T00:00:00.000Z";

function resetDrafts() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
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
        terminalId: `${label}-terminal`,
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

function plain(prompt: string): FailedSendDraft {
  return {
    prompt,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
  };
}

async function failSend(
  harness: ReturnType<typeof createSendHarness>,
  newer?: FailedSendDraft,
  destination: ComposerThreadTarget = target,
) {
  const sent = harness.send();
  await Promise.race([
    harness.started.promise,
    sent.then(() => {
      throw new Error(
        `Send finished before turn start: ${JSON.stringify(harness.setThreadError.mock.calls)}`,
      );
    }),
  ]);
  if (newer) {
    writeDraft(newer, destination);
    harness.refresh(destination);
  }
  harness.result.resolve(await harness.failure);
  await sent;
}

async function reloadDrafts() {
  window.dispatchEvent(new Event("beforeunload"));
  const options = useComposerDraftStore.persist.getOptions();
  const saved = await options.storage?.getItem(options.name ?? "t3code:composer-drafts:v1");
  if (!saved) throw new Error("Composer was not persisted");
  resetDrafts();
  // Read the previously flushed disk value without serializing the test reset.
  useComposerDraftStore.persist.setOptions({
    storage: { getItem: () => saved, setItem: () => {}, removeItem: () => {} },
  });
  await useComposerDraftStore.persist.rehydrate();
  useComposerDraftStore.persist.setOptions({ storage: options.storage });
}

describe("ChatView single-send failures", () => {
  beforeEach(() => {
    resetDrafts();
    mocks.get.mockImplementation((atom) =>
      atom === "configs"
        ? new Map([
            [
              environmentId,
              {
                environment: {
                  capabilities: {
                    attachmentUploads: true,
                    inlineMessageContext: true,
                    fileAttachments: { maxUploadBytes: 50000000 },
                  },
                },
              },
            ],
          ])
        : null,
    );
    mocks.toasts.add.mockReset();
    mocks.retry.mockClear();
    mocks.uploads.mockImplementation(({ images }: { images: FailedSendDraft["images"] }) =>
      images.map((image) => ({
        type: image.type,
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
      })),
    );
    URL.createObjectURL = vi.fn(() => "blob:retry");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    resetDrafts();
    vi.restoreAllMocks();
  });

  it("restores an empty composer and removes the failed conversation row", async () => {
    writeDraft(makeDraft("failed"));
    const harness = createSendHarness(target);
    await failSend(harness);
    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    expect(draft?.prompt).toContain("failed prompt");
    expect(draft?.images[0]?.name).toBe("failed.png");
    expect(draft?.files[0]?.name).toBe("failed.txt");
    expect(draft?.terminalContexts[0]?.text).toBe("failed terminal output");
    expect(draft?.previewAnnotations[0]?.comment).toBe("failed annotation");
    expect(draft?.reviewComments[0]?.text).toBe("failed review");
    expect(draft?.threadContexts).toHaveLength(1);
    expect(harness.messages).toEqual([]);
    expect(harness.refs.sendInFlightRef.current).toBe(false);
    expect(mocks.toasts.add).not.toHaveBeenCalled();
  });

  it("keeps upstream's empty-composer restore for an ordinary text send", async () => {
    writeDraft(plain("failed"));
    const harness = createSendHarness(target);
    await failSend(harness);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("failed");
    expect(harness.messages).toEqual([]);
  });

  it("merges a failed prompt after a newer draft without a Restore action", async () => {
    writeDraft(plain("failed"));
    const harness = createSendHarness(target);
    await failSend(harness, plain("newer"));
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "newer\n\nfailed",
    );
    expect(harness.messages).toEqual([]);
    expect(mocks.toasts.add).not.toHaveBeenCalled();
  });

  it("keeps whitespace written while the send was pending", async () => {
    writeDraft(plain("failed"));
    await failSend(createSendHarness(target), plain(" \n "));
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      " \n \n\nfailed",
    );
  });

  it("preserves distinct authored files with identical names and metadata", async () => {
    const failed = plain("failed");
    const newer = plain("newer");
    const attachment = (id: string, bytes: string): FailedSendDraft["files"][number] => ({
      type: "file",
      id,
      name: "same.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      file: new File([bytes], "same.txt", { type: "text/plain" }),
    });
    failed.files = [attachment("failed-file", "old!")];
    newer.files = [attachment("newer-file", "new!")];
    writeDraft(failed);
    await failSend(createSendHarness(target), newer);
    const files = useComposerDraftStore.getState().getComposerDraft(target)?.files;
    expect(files).toHaveLength(2);
    expect(files?.[0]?.file).toBe(newer.files[0]?.file);
    expect(files?.[1]?.file).toBe(failed.files[0]?.file);
  });

  it("preserves both drafts' attachments and context across an app reload", async () => {
    writeDraft(makeDraft("failed"));
    const harness = createSendHarness(target);
    await failSend(harness, makeDraft("newer"));
    await reloadDrafts();
    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    expect(draft?.prompt.indexOf("newer prompt")).toBeLessThan(
      draft!.prompt.indexOf("failed prompt"),
    );
    expect(draft?.images.map((image) => image.name)).toEqual(["newer.png", "failed.png"]);
    expect(draft?.files.map((file) => file.name)).toEqual(["newer.txt", "failed.txt"]);
    expect(draft?.files.every((file) => composerFileNeedsReattach(file) === false)).toBe(true);
    expect(draft?.terminalContexts.map((context) => context.text)).toEqual([
      "newer terminal output",
      "failed terminal output",
    ]);
    expect(draft?.previewAnnotations.map((context) => context.comment)).toEqual([
      "newer annotation",
      "failed annotation",
    ]);
    expect(draft?.reviewComments.map((context) => context.text)).toEqual([
      "newer review",
      "failed review",
    ]);
    expect(draft?.threadContexts).toHaveLength(1);
  });

  it("preserves different text from the same terminal selection in the recovered chip", async () => {
    const failed = makeDraft("failed");
    const newer = makeDraft("newer");
    newer.terminalContexts[0]!.terminalId = failed.terminalContexts[0]!.terminalId;
    writeDraft(failed);
    await failSend(createSendHarness(target), newer);
    await reloadDrafts();
    const contexts = useComposerDraftStore.getState().getComposerDraft(target)?.terminalContexts;
    expect(contexts).toHaveLength(1);
    expect(contexts?.[0]?.text).toBe("newer terminal output\n\nfailed terminal output");
  });

  it("recovers two sends that fail in a row with a newer draft each time", async () => {
    writeDraft(makeDraft("first"));
    await failSend(createSendHarness(target), makeDraft("second"));
    await failSend(createSendHarness(target), makeDraft("third"));
    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    expect(draft?.prompt).toContain("third prompt");
    expect(draft?.prompt).toContain("second prompt");
    expect(draft?.prompt).toContain("first prompt");
    expect(draft?.images.map((image) => image.name)).toEqual([
      "third.png",
      "second.png",
      "first.png",
    ]);
    expect(draft?.files.map((file) => file.name)).toEqual(["third.txt", "second.txt", "first.txt"]);
  });

  it("recovers the first send into the real thread after draft promotion", async () => {
    const draftId = DraftId.make("new-thread");
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
          threadId,
          environmentId,
          logicalProjectKey: "project",
          projectId: ProjectId.make("project"),
          createdAt: now,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "local",
          startFromOrigin: false,
          promotedTo: null,
        },
      },
    });
    writeDraft(makeDraft("failed"), draftId);
    const harness = createSendHarness(target, draftId);
    const sent = harness.send();
    await Promise.race([
      harness.started.promise,
      sent.then(() => {
        throw new Error(
          `Send finished before turn start: ${JSON.stringify(harness.setThreadError.mock.calls)}`,
        );
      }),
    ]);
    writeDraft(makeDraft("newer"), draftId);
    harness.refresh(draftId);
    markPromotedDraftThreadByRef(target);
    finalizePromotedDraftThreadByRef(target);
    harness.result.resolve(await harness.failure);
    await sent;
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toBeNull();
    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    expect(draft?.prompt).toContain("newer prompt");
    expect(draft?.prompt).toContain("failed prompt");
    expect(draft?.files).toHaveLength(2);
    await reloadDrafts();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.images).toHaveLength(2);
  });

  it("recovers into the sending thread after navigation and leaves the visible thread alone", async () => {
    const other = scopeThreadRef(EnvironmentId.make("remote"), threadId);
    writeDraft(makeDraft("failed"));
    const harness = createSendHarness(target);
    const sent = harness.send();
    await Promise.race([
      harness.started.promise,
      sent.then(() => {
        throw new Error(
          `Send finished before turn start: ${JSON.stringify(harness.setThreadError.mock.calls)}`,
        );
      }),
    ]);
    writeDraft(makeDraft("newer"));
    const otherDraft = writeDraft(makeDraft("other"), other);
    harness.refs.currentRouteThreadKeyRef.current = scopedThreadKey(other);
    harness.refresh(other);
    const resets = harness.resetCursorState.mock.calls.length;
    harness.result.resolve(await harness.failure);
    await sent;
    expect(useComposerDraftStore.getState().getComposerDraft(other)).toBe(otherDraft);
    expect(harness.refs.promptRef.current).toBe(otherDraft.prompt);
    expect(harness.resetCursorState).toHaveBeenCalledTimes(resets);
    expect(harness.messages).toEqual([]);
    await reloadDrafts();
    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    expect(draft?.prompt).toContain("failed prompt");
    expect(draft?.images).toHaveLength(2);
  });

  it("reports every attachment left out by the combined cap by name", async () => {
    writeDraft(makeDraft("failed"));
    const newer = makeDraft("newer");
    newer.files = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 }, (_, index) => ({
      ...newer.files[0]!,
      id: `file-${index}`,
      name: `file-${index}.txt`,
    }));
    await failSend(createSendHarness(target), newer);
    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    expect((draft?.images.length ?? 0) + (draft?.files.length ?? 0)).toBe(
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    );
    expect(draft?.prompt).toContain("failed prompt");
    expect(mocks.toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("'failed.png', 'failed.txt'"),
        data: expect.objectContaining({ threadRef: target }),
      }),
    );
  });

  it("removes the optimistic row and merges on settings persistence failure", async () => {
    writeDraft(makeDraft("failed"));
    const harness = createSendHarness(target);
    harness.delaySettings();
    const sent = harness.send();
    await Promise.race([
      harness.settingsStarted.promise,
      sent.then(() => {
        throw new Error("Send finished before settings persistence");
      }),
    ]);
    writeDraft(makeDraft("newer"));
    harness.refresh();
    harness.settingsResult.resolve(await harness.failure);
    await sent;
    expect(harness.startThreadTurn).not.toHaveBeenCalled();
    expect(harness.messages).toEqual([]);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toContain(
      "failed prompt",
    );
  });

  it("removes the optimistic row and merges on attachment preparation failure", async () => {
    writeDraft(makeDraft("failed"));
    const harness = createSendHarness(target);
    harness.delaySettings();
    mocks.uploads
      .mockReturnValueOnce([
        { type: "image", id: "uploaded" },
        { type: "file", id: "uploaded-file" },
      ])
      .mockReturnValue(null);
    const sent = harness.send();
    await Promise.race([
      harness.settingsStarted.promise,
      sent.then(() => {
        throw new Error("Send finished before settings persistence");
      }),
    ]);
    writeDraft(makeDraft("newer"));
    harness.refresh();
    harness.settingsResult.resolve(AsyncResult.success(undefined));
    await sent;
    expect(harness.startThreadTurn).not.toHaveBeenCalled();
    expect(harness.messages).toEqual([]);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.files).toHaveLength(2);
  });

  it.each([false, true])(
    "does not restore a send already acknowledged by its original projection, newer=%s",
    async (newer) => {
      writeDraft(makeDraft("failed"));
      const harness = createSendHarness(target);
      const sent = harness.send();
      await Promise.race([
        harness.started.promise,
        sent.then(() => {
          throw new Error(
            `Send finished before turn start: ${JSON.stringify(harness.setThreadError.mock.calls)}`,
          );
        }),
      ]);
      if (newer) {
        writeDraft(makeDraft("newer"));
        harness.refresh();
      }
      const before = useComposerDraftStore.getState().getComposerDraft(target);
      mocks.get.mockImplementation((atom) =>
        atom === "configs"
          ? new Map()
          : { projection: { messages: [{ id: "message-1", role: "user" }] } },
      );
      harness.result.resolve(await harness.failure);
      await sent;
      expect(useComposerDraftStore.getState().getComposerDraft(target)).toBe(before);
      expect(harness.messages).toEqual([]);
      expect(mocks.retry).not.toHaveBeenCalled();
    },
  );
});
