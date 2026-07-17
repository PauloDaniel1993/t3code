// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  attachmentRelativePath,
  createAttachmentId,
  isAttachmentOwnedByThread,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";

const THREAD_ONE_ID = "thread-1-00000000-0000-4000-8000-000000000001";
const THREAD_TWO_ID = "thread-2-00000000-0000-4000-8000-000000000002";

const UUID_THREAD_ID = "00000000000040008000000000000001";
const DASHED_UUID_THREAD_ID = "00000000-0000-4000-8000-000000000001";

describe("attachmentStore", () => {
  it("rejects collision-prone thread ids with an actionable staging error", () => {
    for (const threadId of ["notes.1", "notes/1"]) {
      expect(() => createAttachmentId(threadId)).toThrow(
        "Attachment staging requires a thread ID with only lowercase letters, digits, underscores, and single hyphens",
      );
    }
  });

  it("creates attachment ids for canonical UUID thread ids", () => {
    for (const threadId of [UUID_THREAD_ID, DASHED_UUID_THREAD_ID]) {
      const attachmentId = createAttachmentId(threadId);
      expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe(threadId);
    }
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("rejects thread ids that require lowercase normalization", () => {
    expect(() => createAttachmentId("Thread.Foo")).toThrow(
      "Attachment staging requires a thread ID",
    );
  });

  it("uses implementation-owned extensions and ignores traversal-shaped display names", () => {
    expect(
      attachmentRelativePath({
        type: "document",
        id: THREAD_ONE_ID,
        name: "../original-name.anything",
        mimeType: "application/pdf",
        sizeBytes: 10,
      }),
    ).toBe(`${THREAD_ONE_ID}.pdf`);
    expect(
      attachmentRelativePath({
        type: "file",
        id: THREAD_ONE_ID,
        name: "../unsafe/path/Source.TS",
        mimeType: "text/plain",
        sizeBytes: 10,
      }),
    ).toBe(`${THREAD_ONE_ID}.ts`);
  });

  it("resolves mixed-case metadata names to the exact registry-derived path", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const expectedPath = NodePath.join(attachmentsDir, `${THREAD_ONE_ID}.ts`);
      NodeFS.writeFileSync(expectedPath, Buffer.from("hello"));

      expect(
        resolveAttachmentPath({
          attachmentsDir,
          threadId: "Thread.1",
          attachment: {
            type: "file",
            id: THREAD_ONE_ID,
            name: "Source.TS",
            mimeType: "text/plain",
            sizeBytes: 5,
          },
        }),
      ).toBe(expectedPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects cross-thread ownership when a requesting thread is known", () => {
    expect(isAttachmentOwnedByThread({ attachmentId: THREAD_ONE_ID, threadId: "thread.1" })).toBe(
      true,
    );
    expect(isAttachmentOwnedByThread({ attachmentId: THREAD_TWO_ID, threadId: "thread.1" })).toBe(
      false,
    );
    expect(
      resolveAttachmentPath({
        attachmentsDir: NodeOS.tmpdir(),
        threadId: "thread.1",
        attachment: {
          type: "document",
          id: THREAD_TWO_ID,
          name: "other.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
        },
      }),
    ).toBeNull();
  });

  it("resolves only the metadata-derived file when an id has ambiguous extensions", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const pdfPath = NodePath.join(attachmentsDir, `${THREAD_ONE_ID}.pdf`);
      const htmlPath = NodePath.join(attachmentsDir, `${THREAD_ONE_ID}.html`);
      NodeFS.writeFileSync(pdfPath, Buffer.from("pdf"));
      NodeFS.writeFileSync(htmlPath, Buffer.from("html"));

      expect(
        resolveAttachmentPath({
          attachmentsDir,
          threadId: "thread.1",
          attachment: {
            type: "file",
            id: THREAD_ONE_ID,
            name: "page.HTML",
            mimeType: "text/html",
            sizeBytes: 4,
          },
        }),
      ).toBe(htmlPath);
      expect(
        resolveAttachmentPath({
          attachmentsDir,
          threadId: "thread.1",
          attachment: {
            type: "document",
            id: THREAD_ONE_ID,
            name: "page.html",
            mimeType: "application/pdf",
            sizeBytes: 3,
          },
        }),
      ).toBe(pdfPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("keeps extension probing only for legacy image claims, including .bin", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const binPath = NodePath.join(attachmentsDir, `${THREAD_ONE_ID}.bin`);
      NodeFS.writeFileSync(binPath, Buffer.from("legacy"));
      NodeFS.writeFileSync(
        NodePath.join(attachmentsDir, `${THREAD_ONE_ID}.pdf`),
        Buffer.from("pdf"),
      );

      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId: THREAD_ONE_ID })).toBe(
        binPath,
      );
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns null cleanly for unsafe or missing ids", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      expect(
        resolveAttachmentPathById({ attachmentsDir, attachmentId: "thread-1-missing" }),
      ).toBeNull();
      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId: "../outside" })).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
