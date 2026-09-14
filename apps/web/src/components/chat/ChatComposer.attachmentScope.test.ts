import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildComposerContextAttachmentAssetRequest } from "./ChatComposer";

describe("composer context attachment import scope", () => {
  const environmentId = EnvironmentId.make("source-environment");
  const threadId = ThreadId.make("source-thread");

  it("preserves the source thread for a claimed attachment", () => {
    expect(
      buildComposerContextAttachmentAssetRequest(
        { environmentId, threadId },
        { attachmentId: "source-thread-00000000-0000-0000-0000-000000000001-pdf" },
      ),
    ).toEqual({
      environmentId,
      input: {
        resource: {
          _tag: "attachment",
          attachmentId: "source-thread-00000000-0000-0000-0000-000000000001-pdf",
          threadId,
        },
      },
    });
  });

  it("does not apply the source thread to a pending attachment", () => {
    const request = buildComposerContextAttachmentAssetRequest(
      { environmentId, threadId },
      { attachmentId: "pending-00000000-0000-0000-0000-000000000001-pdf" },
    );

    expect(request).toEqual({
      environmentId,
      input: {
        resource: {
          _tag: "attachment",
          attachmentId: "pending-00000000-0000-0000-0000-000000000001-pdf",
        },
      },
    });
    if (request === null) throw new Error("Expected a pending attachment request");
    expect(request.input.resource).not.toHaveProperty("threadId");
  });

  it("does not create an unscoped request for a claimed attachment", () => {
    expect(
      buildComposerContextAttachmentAssetRequest(
        { environmentId },
        { attachmentId: "source-thread-00000000-0000-0000-0000-000000000001-pdf" },
      ),
    ).toBeNull();
  });
});
