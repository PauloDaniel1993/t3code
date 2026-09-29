import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  composerFileNeedsReattach,
  type ComposerFileAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { recoverFailedSendDraft } from "./failedSendRecovery";
import { deferred } from "./ChatView.send.testSupport";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), upload: vi.fn(), toast: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/attachments", () => ({
  verifyPersistedAttachmentUpload: mocks.verify,
  runAttachmentUploadCycle: mocks.upload,
  deletePendingAttachmentUpload: vi.fn(),
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

beforeEach(() => {
  mocks.verify.mockReset();
  mocks.upload.mockReset();
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  useAttachmentUploadStore.setState({
    uploadsByImageId: { file: { status: "ready", environmentId, attachmentId: "expired-upload" } },
  });
});
afterEach(() => {
  releaseAttachmentUpload("file");
});

async function recover(attachment = file) {
  await recoverFailedSendDraft({
    target,
    threadRef: target,
    messageId: MessageId.make("failed"),
    failedDraft: {
      prompt: "failed",
      images: [],
      files: [attachment],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
    },
    isOriginalRoute: () => true,
    onRestored: vi.fn(),
  });
}

it("stops showing an old ready upload, verifies it, and reuploads retained bytes when swept", async () => {
  const verification = deferred<{ status: "missing" }>();
  mocks.verify.mockReturnValue(verification.promise);
  mocks.upload.mockResolvedValue({ status: "uploaded", attachmentId: "fresh-upload" });
  await recover();
  expect(getUploadedAttachments({ environmentId, images: [file] })).toBeNull();
  verification.resolve({ status: "missing" });
  await awaitAttachmentUploads(["file"]);
  expect(mocks.upload).toHaveBeenCalledWith(
    expect.objectContaining({ upload: expect.objectContaining({ name: file.name, sizeBytes: 4 }) }),
  );
  expect(getUploadedAttachments({ environmentId, images: [file] })?.[0]?.id).toBe("fresh-upload");
  expect(
    useComposerDraftStore.getState().getComposerDraft(target)?.files[0]?.uploadedAttachmentId,
  ).toBe("fresh-upload");
});

it("keeps an expired hydrated file visible as needing reattachment instead of a ready chip", async () => {
  mocks.verify.mockResolvedValue({ status: "missing" });
  await recover({ ...file, file: null });
  await awaitAttachmentUploads(["file"]);
  const recovered = useComposerDraftStore.getState().getComposerDraft(target)?.files[0];
  expect(recovered?.name).toBe(file.name);
  expect(recovered && composerFileNeedsReattach(recovered)).toBe(true);
  expect(getUploadedAttachments({ environmentId, images: [file] })).toBeNull();
  expect(mocks.upload).not.toHaveBeenCalled();
});

it("shows a verification error on disconnection and keeps the persisted upload for retry", async () => {
  mocks.verify.mockResolvedValue({ status: "failed", error: new Error("Disconnected") });
  await recover({ ...file, file: null });
  await awaitAttachmentUploads(["file"]);
  expect(readAttachmentUpload("file")).toMatchObject({
    status: "failed",
    reason: "Uploaded file could not be verified. Retry when the server reconnects.",
  });
  expect(
    useComposerDraftStore.getState().getComposerDraft(target)?.files[0]?.uploadedAttachmentId,
  ).toBe("expired-upload");
  expect(mocks.upload).not.toHaveBeenCalled();
});
