import { describe, expect, it } from "vite-plus/test";

import {
  attachmentDownloadUrl,
  formatAttachmentSize,
  partitionClientChatAttachments,
  type ClientChatAttachment,
} from "./attachments.ts";

describe("attachmentDownloadUrl", () => {
  it("preserves the signed token while requesting an encoded original-name download", () => {
    expect(
      attachmentDownloadUrl(
        "https://environment.example/api/assets/signed-token/generated-id.pdf",
        "Architecture notes #2.pdf",
      ),
    ).toBe(
      "https://environment.example/api/assets/signed-token/Architecture%20notes%20%232.pdf?download=1",
    );
  });

  it("keeps optimistic blob URLs unchanged", () => {
    expect(attachmentDownloadUrl("blob:optimistic-pdf", "notes.pdf")).toBe("blob:optimistic-pdf");
  });

  it("preserves existing signed URL query parameters", () => {
    expect(
      attachmentDownloadUrl(
        "https://environment.example/api/assets/token/generated.pdf?transport=relay",
        "notes.pdf",
      ),
    ).toBe("https://environment.example/api/assets/token/notes.pdf?transport=relay&download=1");
  });
});

describe("partitionClientChatAttachments", () => {
  it("preserves the relative order and discriminated metadata of images and PDFs", () => {
    const attachments: ClientChatAttachment[] = [
      {
        type: "document",
        id: "doc-1",
        name: "requirements.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1_024,
        assetUrl: "blob:requirements",
      },
      {
        type: "image",
        id: "img-1",
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 12,
        previewUrl: "blob:screen",
      },
      {
        type: "document",
        id: "doc-2",
        name: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2_048,
      },
    ];

    expect(partitionClientChatAttachments(attachments)).toEqual({
      images: [attachments[1]],
      documents: [attachments[0], attachments[2]],
    });
  });
});

describe("formatAttachmentSize", () => {
  it("formats byte boundaries consistently", () => {
    expect(formatAttachmentSize(0)).toBe("0 B");
    expect(formatAttachmentSize(1_024)).toBe("1 KB");
    expect(formatAttachmentSize(1_572_864)).toBe("1.5 MB");
    expect(formatAttachmentSize(10 * 1_024 * 1_024)).toBe("10 MB");
  });
});
