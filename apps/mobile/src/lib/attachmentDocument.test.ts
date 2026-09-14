import { expect, it, vi } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("expo-file-system", () => ({ File: vi.fn() }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../state/assets", () => ({ useRefreshAssetUrl: vi.fn() }));
vi.mock("./localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("./attachmentDownload", () => ({
  downloadAndShareAttachment: vi.fn(),
  shareLocalAttachment: vi.fn(),
}));

import { attachmentAssetOwnership } from "./attachmentDocument";

const threadId = ThreadId.make("owning-thread");

it("includes ownership for a claimed attachment", () => {
  expect(
    attachmentAssetOwnership({
      attachmentId: "owning-thread-00000000-0000-4000-8000-000000000001-pdf",
      threadId,
      isLocal: false,
    }),
  ).toEqual({ threadId });
});

it.each([
  { attachmentId: "pending-00000000-0000-4000-8000-000000000001-pdf", isLocal: false },
  {
    attachmentId: "owning-thread-00000000-0000-4000-8000-000000000001-pdf",
    isLocal: true,
  },
])("omits ownership for a draft attachment: %j", ({ attachmentId, isLocal }) => {
  expect(attachmentAssetOwnership({ attachmentId, threadId, isLocal })).toEqual({});
});
