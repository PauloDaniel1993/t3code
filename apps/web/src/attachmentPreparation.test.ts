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

  it("classifies known extensions before the browser image MIME fallback", () => {
    const result = prepare([
      file("report.pdf", "image/png"),
      file("REPORT.PDF", "image/png"),
      file("Program.cs", "image/png"),
      file("photo.png", "image/png"),
    ]);

    expect(result.attachments.map((attachment) => [attachment.name, attachment.type])).toEqual([
      ["report.pdf", "document"],
      ["REPORT.PDF", "document"],
      ["Program.cs", "file"],
      ["photo.png", "image"],
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

  it("rejects names longer than 255 characters for every attachment kind", () => {
    const tooLong = prepare([
      file(`${"a".repeat(252)}.png`, "image/png"),
      file(`${"a".repeat(252)}.pdf`, "application/pdf"),
      file(`${"a".repeat(253)}.md`, "text/markdown"),
    ]);

    expect(tooLong.attachments).toEqual([]);
    expect(tooLong.rejections).toMatchObject([
      { reason: "name" },
      { reason: "name" },
      { reason: "name" },
    ]);
    expect(
      tooLong.rejections.every((rejection) => rejection.message.includes("255 characters")),
    ).toBe(true);

    const atLimit = prepare([
      file(`${"a".repeat(251)}.png`, "image/png"),
      file(`${"a".repeat(251)}.pdf`, "application/pdf"),
      file(`${"a".repeat(252)}.md`, "text/markdown"),
    ]);
    expect(atLimit.attachments.map((attachment) => attachment.type)).toEqual([
      "image",
      "document",
      "file",
    ]);
    expect(atLimit.rejections).toEqual([]);
  });

  it("rejects empty attachments and accepts one-byte attachments", () => {
    const empty = prepare([
      file("empty.png", "image/png", 0),
      file("empty.pdf", "application/pdf", 0),
      file("empty.md", "text/markdown", 0),
    ]);
    expect(empty.attachments).toEqual([]);
    expect(empty.rejections).toMatchObject([
      { fileName: "empty.png", reason: "empty" },
      { fileName: "empty.pdf", reason: "empty" },
      { fileName: "empty.md", reason: "empty" },
    ]);

    const oneByte = prepare([
      file("one-byte.png", "image/png", 1),
      file("one-byte.pdf", "application/pdf", 1),
      file("one-byte.md", "text/markdown", 1),
    ]);
    expect(oneByte.attachments.map((attachment) => attachment.type)).toEqual([
      "image",
      "document",
      "file",
    ]);
    expect(oneByte.rejections).toEqual([]);
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
