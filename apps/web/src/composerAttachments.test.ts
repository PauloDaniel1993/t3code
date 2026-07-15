import {
  CHAT_FILE_ATTACHMENT_ACCEPT,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_PDF_BYTES,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  COMPOSER_ATTACHMENT_ACCEPT,
  canonicalizePdfFile,
  createComposerAttachmentInteractionHandlers,
  dispatchComposerAttachmentFiles,
  isPdfFileCandidate,
  prepareComposerAttachments,
  serializeComposerAttachmentsForPersistence,
} from "./composerAttachments";

function prepare(files: File[], existingCount = 0) {
  let id = 0;
  return prepareComposerAttachments(files, {
    existingCount,
    createId: () => `attachment-${++id}`,
    createObjectUrl: (file) => `blob:${file.name}`,
  });
}

describe("composer attachment input", () => {
  it("advertises images, PDFs, and every registry file extension to the picker", () => {
    expect(COMPOSER_ATTACHMENT_ACCEPT).toBe(
      `image/*,application/pdf,.pdf,${CHAT_FILE_ATTACHMENT_ACCEPT}`,
    );
    expect(COMPOSER_ATTACHMENT_ACCEPT).toContain(".json");
    expect(COMPOSER_ATTACHMENT_ACCEPT).toContain(".cs");
    expect(COMPOSER_ATTACHMENT_ACCEPT).toContain(".xlsx");
  });

  it("recognizes PDF MIME and case-insensitive .pdf filenames", () => {
    expect(isPdfFileCandidate(new File(["%PDF-"], "notes.bin", { type: "application/pdf" }))).toBe(
      true,
    );
    expect(isPdfFileCandidate(new File(["%PDF-"], "NOTES.PDF"))).toBe(true);
    expect(isPdfFileCandidate(new File(["text"], "notes.txt", { type: "text/plain" }))).toBe(false);
  });

  it("canonicalizes browser files with missing MIME without changing their bytes", async () => {
    const source = new File(["%PDF-1.7"], "spec.pdf", { lastModified: 42 });
    const canonical = canonicalizePdfFile(source);

    expect(canonical.type).toBe("application/pdf");
    expect(canonical.name).toBe("spec.pdf");
    expect(canonical.lastModified).toBe(42);
    expect(await canonical.text()).toBe("%PDF-1.7");
  });

  it("preserves mixed image/PDF input order", () => {
    const files = [
      new File(["image"], "screen.png", { type: "image/png" }),
      new File(["%PDF-"], "spec.pdf"),
      new File(["image"], "detail.webp", { type: "image/webp" }),
    ];

    const result = prepare(files);
    expect(result.error).toBeNull();
    expect(result.attachments.map((attachment) => [attachment.type, attachment.name])).toEqual([
      ["image", "screen.png"],
      ["document", "spec.pdf"],
      ["image", "detail.webp"],
    ]);
    expect(result.attachments[1]?.mimeType).toBe("application/pdf");
  });

  it("rejects oversized PDFs while preserving valid candidates", () => {
    const oversized = new File(
      [new Uint8Array(PROVIDER_SEND_TURN_MAX_PDF_BYTES + 1)],
      "oversized.pdf",
      { type: "application/pdf" },
    );
    const valid = new File(["image"], "screen.png", { type: "image/png" });

    const result = prepare([oversized, valid]);

    expect(result.attachments.map((attachment) => attachment.name)).toEqual(["screen.png"]);
    expect(result.error).toContain("10 MiB PDF attachment limit");
  });

  it("enforces the combined eight-attachment quota without creating extra object URLs", () => {
    const createObjectUrl = vi.fn((file: File) => `blob:${file.name}`);
    const result = prepareComposerAttachments(
      [
        new File(["%PDF-"], "eighth.pdf", { type: "application/pdf" }),
        new File(["image"], "ninth.png", { type: "image/png" }),
      ],
      {
        existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
        createId: () => "attachment",
        createObjectUrl,
      },
    );

    expect(result.attachments.map((attachment) => attachment.name)).toEqual(["eighth.pdf"]);
    expect(result.error).toContain(`up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files`);
    expect(createObjectUrl).toHaveBeenCalledOnce();
  });

  it("rejects unrelated files with an actionable supported-types message", () => {
    const result = prepare([
      new File(["MZ..."], "installer.exe", { type: "application/x-msdownload" }),
    ]);

    expect(result.attachments).toEqual([]);
    expect(result.error).toContain("installer.exe");
    expect(result.error).toContain("text, code, or data files");
  });

  it("accepts registry files by extension and stamps the canonical MIME type", () => {
    const result = prepare([
      new File(["export {};"], "video.ts", { type: "video/mp2t" }),
      new File(["class C {}"], "Program.cs", { type: "" }),
      new File(["PK"], "report.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ]);

    expect(result.error).toBeNull();
    expect(result.attachments.map((attachment) => [attachment.type, attachment.mimeType])).toEqual([
      ["file", "text/x-typescript"],
      ["file", "text/x-csharp"],
      ["file", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ]);
    expect(result.attachments.map((attachment) => attachment.file.type)).toEqual([
      "text/x-typescript",
      "text/x-csharp",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]);
  });

  it("rejects oversized generic files while preserving valid candidates", () => {
    const oversized = new File(
      [new Uint8Array(PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1)],
      "big.json",
      { type: "application/json" },
    );
    const valid = new File(["{}"], "small.json", { type: "application/json" });

    const result = prepare([oversized, valid]);

    expect(result.attachments.map((attachment) => attachment.name)).toEqual(["small.json"]);
    expect(result.error).toContain("10 MiB file attachment limit");
  });
});

describe("ChatComposer attachment interactions", () => {
  function createHarness() {
    const added: Array<ReturnType<typeof prepare>["attachments"]> = [];
    const errors: Array<string | null> = [];
    let id = 0;
    const addFiles = (files: File[]) => {
      dispatchComposerAttachmentFiles(files, {
        existingCount: 0,
        createId: () => `interaction-${++id}`,
        createObjectUrl: (file) => `blob:${file.name}`,
        addAttachments: (attachments) => added.push(attachments),
        setError: (error) => errors.push(error),
      });
    };
    const focusComposer = vi.fn();
    return {
      added,
      errors,
      focusComposer,
      handlers: createComposerAttachmentInteractionHandlers({ addFiles, focusComposer }),
    };
  }

  it("forwards a picked PDF through the input change handler and resets the picker", () => {
    const harness = createHarness();
    const input = {
      files: [new File(["%PDF-"], "picked.pdf", { type: "application/pdf" })],
      value: "C:\\fakepath\\picked.pdf",
    };

    harness.handlers.onInputChange({ currentTarget: input });

    expect(input.value).toBe("");
    expect(harness.added.flat().map((attachment) => attachment.name)).toEqual(["picked.pdf"]);
    expect(harness.errors).toEqual([null]);
  });

  it("prevents the default paste and forwards an extension-only PDF", () => {
    const harness = createHarness();
    const preventDefault = vi.fn();

    harness.handlers.onPaste({
      clipboardData: { files: [new File(["%PDF-"], "pasted.PDF")] },
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(harness.added.flat()[0]).toMatchObject({
      type: "document",
      name: "pasted.PDF",
      mimeType: "application/pdf",
    });
    expect(harness.errors).toEqual([null]);
  });

  it("forwards dropped PDFs and text files, restores focus, and surfaces unsupported-file errors", () => {
    const harness = createHarness();
    const preventDefault = vi.fn();

    harness.handlers.onDrop({
      dataTransfer: {
        types: ["Files"],
        files: [
          new File(["%PDF-"], "dropped.pdf", { type: "application/pdf" }),
          new File(["text"], "notes.txt", { type: "text/plain" }),
          new File(["MZ"], "installer.exe", { type: "application/x-msdownload" }),
        ],
      },
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(harness.focusComposer).toHaveBeenCalledOnce();
    expect(harness.added.flat().map((attachment) => attachment.name)).toEqual([
      "dropped.pdf",
      "notes.txt",
    ]);
    expect(harness.errors.at(-1)).toContain("installer.exe");
  });
});

describe("composer attachment persistence", () => {
  it("preserves composer order when concurrent file reads complete out of order", async () => {
    const attachments = prepare([
      new File(["image"], "first.png", { type: "image/png" }),
      new File(["%PDF-"], "second.pdf", { type: "application/pdf" }),
      new File(["image"], "third.webp", { type: "image/webp" }),
    ]).attachments;
    const resolvers = new Map<string, (value: string) => void>();
    const serializedPromise = serializeComposerAttachmentsForPersistence(
      attachments,
      [],
      (file) =>
        new Promise<string>((resolve) => {
          resolvers.set(file.name, resolve);
        }),
    );
    await Promise.resolve();

    resolvers.get("third.webp")?.("data:third");
    resolvers.get("second.pdf")?.("data:second");
    resolvers.get("first.png")?.("data:first");

    await expect(serializedPromise).resolves.toEqual([
      expect.objectContaining({ name: "first.png", dataUrl: "data:first" }),
      expect.objectContaining({ name: "second.pdf", dataUrl: "data:second" }),
      expect.objectContaining({ name: "third.webp", dataUrl: "data:third" }),
    ]);
  });
});
