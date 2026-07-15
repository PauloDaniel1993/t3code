// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  attachmentRelativePath,
  createAttachmentId,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  resolveExistingAttachmentFilePath,
} from "./attachmentStore.ts";

describe("attachmentStore", () => {
  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }

    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("normalizes created thread segments to lowercase", () => {
    const attachmentId = createAttachmentId("Thread.Foo");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-foo");
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-attachment";
      const pngPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("maps document attachments to a safe PDF path regardless of the display name", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachment = {
        type: "document" as const,
        id: "thread-1-00000000-0000-4000-8000-000000000001",
        name: "unsafe.exe",
        mimeType: "application/pdf" as const,
        sizeBytes: 5,
      };

      expect(attachmentRelativePath(attachment)).toBe(`${attachment.id}.pdf`);
      expect(resolveAttachmentPath({ attachmentsDir, attachment })).toBe(
        NodePath.join(attachmentsDir, `${attachment.id}.pdf`),
      );
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("maps file attachments to registry-owned extensions regardless of the display name", () => {
    const id = "thread-1-00000000-0000-4000-8000-000000000001";
    expect(
      attachmentRelativePath({
        type: "file",
        id,
        name: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 5,
      }),
    ).toBe(`${id}.md`);
    // A traversal-laden display name never influences the stored path beyond
    // its registry extension.
    expect(
      attachmentRelativePath({
        type: "file",
        id,
        name: "../../evil/../payload.json",
        mimeType: "application/json",
        sizeBytes: 5,
      }),
    ).toBe(`${id}.json`);
    // Unknown display extension falls back to the canonical MIME lookup.
    expect(
      attachmentRelativePath({
        type: "file",
        id,
        name: "weird.name.unknown",
        mimeType: "text/csv",
        sizeBytes: 5,
      }),
    ).toBe(`${id}.csv`);
  });

  it("finds contained file attachments by id across registry extensions", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000002";
      const xlsxPath = NodePath.join(attachmentsDir, `${attachmentId}.xlsx`);
      NodeFS.writeFileSync(xlsxPath, Buffer.from("PK"));

      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId })).toBe(xlsxPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("finds contained PDF attachments by id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001";
      const pdfPath = NodePath.join(attachmentsDir, `${attachmentId}.pdf`);
      NodeFS.writeFileSync(pdfPath, Buffer.from("%PDF-1.7"));

      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId })).toBe(pdfPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("resolves only existing attachment files, not same-name directories", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    const attachment = {
      type: "document" as const,
      id: "thread-1-00000000-0000-4000-8000-000000000001",
      name: "document.pdf",
      mimeType: "application/pdf" as const,
      sizeBytes: 8,
    };
    try {
      const pdfPath = NodePath.join(attachmentsDir, `${attachment.id}.pdf`);
      NodeFS.mkdirSync(pdfPath);
      expect(resolveExistingAttachmentFilePath({ attachmentsDir, attachment })).toBeNull();
      NodeFS.rmSync(pdfPath, { recursive: true });
      NodeFS.writeFileSync(pdfPath, Buffer.from("%PDF-1.7"));
      expect(resolveExistingAttachmentFilePath({ attachmentsDir, attachment })).toBe(pdfPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects traversal, supplied extensions, and nested ids during lookup", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      expect(
        resolveAttachmentPathById({ attachmentsDir, attachmentId: "../thread-1-attachment" }),
      ).toBeNull();
      expect(
        resolveAttachmentPathById({ attachmentsDir, attachmentId: "thread-1-attachment.pdf" }),
      ).toBeNull();
      expect(
        resolveAttachmentPathById({ attachmentsDir, attachmentId: "thread/1/attachment" }),
      ).toBeNull();
      expect(parseAttachmentIdFromRelativePath("../../thread-1-attachment.pdf")).toBeNull();
      expect(parseAttachmentIdFromRelativePath("thread-1-attachment.pdf.exe")).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("keeps thread ownership segments exact for PDF cleanup safety", () => {
    const ownerId = "thread-owner-00000000-0000-4000-8000-000000000001";
    const otherId = "thread-owner-extra-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(ownerId)).toBe("thread-owner");
    expect(parseThreadSegmentFromAttachmentId(otherId)).toBe("thread-owner-extra");
    expect(parseAttachmentIdFromRelativePath(`${ownerId}.pdf`)).toBe(ownerId);
    expect(parseAttachmentIdFromRelativePath(`${otherId}.pdf`)).toBe(otherId);
  });

  it("returns null when no attachment file exists for the id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: "thread-1-missing",
      });
      expect(resolved).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
