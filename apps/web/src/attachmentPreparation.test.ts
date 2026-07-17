import { describe, expect, it } from "vite-plus/test";

import { prepareComposerAttachments } from "./attachmentPreparation";

function file(name: string, type: string, size = 4): File {
  return new File([new Uint8Array(size)], name, { type });
}

function prepare(files: File[], existingCount = 0) {
  let id = 0;
  return prepareComposerAttachments(files, {
    existingCount,
    createId: () => `attachment-${++id}`,
    createImagePreviewUrl: (candidate) => `blob:${candidate.name}`,
  });
}

describe("prepareComposerAttachments", () => {
  it.each(["picker", "drop", "paste"])("accepts PDFs and registry files from %s candidates", () => {
    const result = prepare([
      file("diagram.pdf", "application/pdf"),
      file("notes.md", "text/plain"),
    ]);
    expect(result.attachments.map((attachment) => [attachment.type, attachment.mimeType])).toEqual([
      ["document", "application/pdf"],
      ["file", "text/markdown"],
    ]);
    expect(result.rejections).toEqual([]);
  });

  it("uses the registry extension instead of advisory browser MIME", () => {
    const result = prepare([file("video.ts", "video/mp2t"), file("Program.cs", "")]);
    expect(
      result.attachments.map((attachment) => [
        attachment.name,
        attachment.type,
        attachment.mimeType,
      ]),
    ).toEqual([
      ["video.ts", "file", "text/plain"],
      ["Program.cs", "file", "text/plain"],
    ]);
  });

  it("retains valid candidates and reports unsupported names", () => {
    const result = prepare([
      file("installer.exe", "application/octet-stream"),
      file("notes.md", ""),
    ]);
    expect(result.attachments.map((attachment) => attachment.name)).toEqual(["notes.md"]);
    expect(result.rejections[0]?.message).toContain("installer.exe");
    expect(result.rejections[0]?.message).toContain("images, PDFs");
  });

  it("rejects oversized files without discarding siblings", () => {
    const oversized = file("large.pdf", "application/pdf", 10 * 1024 * 1024 + 1);
    const result = prepare([oversized, file("small.csv", "text/csv")]);
    expect(result.attachments.map((attachment) => attachment.name)).toEqual(["small.csv"]);
    expect(result.rejections).toMatchObject([{ fileName: "large.pdf", reason: "oversized" }]);
  });

  it("enforces the combined count and preserves accepted mixed order", () => {
    const ordered = prepare([
      file("first.png", "image/png"),
      file("second.pdf", "application/pdf"),
      file("third.xlsx", "application/octet-stream"),
    ]);
    expect(ordered.attachments.map((attachment) => attachment.type)).toEqual([
      "image",
      "document",
      "file",
    ]);

    const overCount = prepare([file("kept.md", ""), file("rejected.pdf", "application/pdf")], 7);
    expect(overCount.attachments.map((attachment) => attachment.name)).toEqual(["kept.md"]);
    expect(overCount.rejections).toMatchObject([{ fileName: "rejected.pdf", reason: "count" }]);
  });
});
