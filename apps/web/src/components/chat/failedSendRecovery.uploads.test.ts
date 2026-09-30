import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  getUploadedAttachments,
  readAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { recoverFailedSendDraft } from "./failedSendRecovery";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@t3tools/client-runtime/state/attachments", () => ({
  verifyPersistedAttachmentUpload: mocks.verify,
  runAttachmentUploadCycle: mocks.upload,
  deletePendingAttachmentUpload: mocks.remove,
}));
vi.mock("../../rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/unstable/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    environmentThreadDetails: { threadAtom: () => Atom.make(null) },
    environmentThreadShells: {},
  };
});
vi.mock("../../connection/catalog", async () => {
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  return {
    environmentCatalog: { stateAtom: () => Atom.make(AsyncResult.success({ phase: "connected" })) },
  };
});
vi.mock("../../state/assets", () => ({ assetEnvironment: { createUrl: vi.fn() } }));
vi.mock("../../state/attachments", () => ({
  attachmentEnvironment: { createUploadUrl: vi.fn(), remove: vi.fn() },
}));
vi.mock("../../state/session", () => ({
  readPreparedConnection: () => ({ httpBaseUrl: "https://fixture.test/" }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

const environmentId = EnvironmentId.make("local");
const target = scopeThreadRef(environmentId, ThreadId.make("sending-thread"));
const file: ComposerFileAttachment = {
  type: "file",
  id: "file",
  name: "older-than-24-hours.txt",
  mimeType: "text/plain",
  sizeBytes: 4,
  file: new File(["text"], "older-than-24-hours.txt", { type: "text/plain" }),
  uploadedAttachmentId: "expired-upload",
  uploadEnvironmentId: environmentId,
};

const image: ComposerImageAttachment = {
  type: "image",
  id: "image",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 4,
  file: new File(["data"], "screenshot.png", { type: "image/png" }),
  previewUrl: "blob:original",
};

beforeEach(() => {
  vi.clearAllMocks();
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  useAttachmentUploadStore.setState({
    uploadsByImageId: {
      file: { status: "ready", environmentId, attachmentId: "expired-upload" },
      image: { status: "ready", environmentId, attachmentId: "image-upload" },
    },
  });
});

it.each([false, true])(
  "merges without verifying, replacing or deleting uploads, hydrated=%s",
  (hydrated) => {
    const { uploadedAttachmentId: _uploadedAttachmentId, ...unstamped } = file;
    const attachment = {
      ...unstamped,
      file: hydrated ? null : file.file,
    };
    const uploads = useAttachmentUploadStore.getState().uploadsByImageId;
    expect(
      recoverFailedSendDraft({
        target,
        threadRef: target,
        messageId: MessageId.make("failed"),
        failedDraft: {
          prompt: "failed",
          images: [image],
          files: [attachment],
          terminalContexts: [],
          previewAnnotations: [],
          reviewComments: [],
          threadContexts: [],
        },
        isOriginalRoute: () => true,
        onRestored: vi.fn(),
      }),
    ).toBe(true);
    expect(useAttachmentUploadStore.getState().uploadsByImageId).toBe(uploads);
    expect(readAttachmentUpload("image")).toMatchObject({
      status: "ready",
      attachmentId: "image-upload",
    });
    expect(
      getUploadedAttachments({ environmentId, images: [image, attachment] })?.map(
        (upload) => upload.id,
      ),
    ).toEqual(["image-upload", "expired-upload"]);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.files[0]).toMatchObject({
      uploadedAttachmentId: "expired-upload",
      uploadEnvironmentId: environmentId,
    });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  },
);
