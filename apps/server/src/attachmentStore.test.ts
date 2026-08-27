// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  attachmentRelativePath,
  createAttachmentId,
  createPendingAttachmentId,
  isAttachmentOwnedByThread,
  parseAttachmentUuid,
  planAttachmentClaim,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  sweepStalePendingAttachments,
} from "./attachmentStore.ts";

const THREAD_ONE_ID = "thread-1-00000000-0000-4000-8000-000000000001";
const THREAD_TWO_ID = "thread-2-00000000-0000-4000-8000-000000000002";

const UUID_THREAD_ID = "00000000000040008000000000000001";
const DASHED_UUID_THREAD_ID = "00000000-0000-4000-8000-000000000001";

describe("attachmentStore", () => {
  it("returns null for collision-prone thread ids", () => {
    for (const threadId of ["notes.1", "notes/1"]) {
      expect(createAttachmentId(threadId)).toBeNull();
    }
  });

  it("creates attachment ids for canonical UUID thread ids", () => {
    for (const threadId of [UUID_THREAD_ID, DASHED_UUID_THREAD_ID]) {
      const attachmentId = createAttachmentId(threadId);
      expect(attachmentId).not.toBeNull();
      expect(parseThreadSegmentFromAttachmentId(attachmentId ?? "")).toBe(threadId);
    }
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("returns null for thread ids that require lowercase normalization", () => {
    expect(createAttachmentId("Thread.Foo")).toBeNull();
  });

  it("reserves the pending attachment segment without weakening canonical thread ids", () => {
    const pendingId = createPendingAttachmentId();
    expect(parseThreadSegmentFromAttachmentId(pendingId)).toBe("pending");
    expect(parseAttachmentUuid(pendingId)).toMatch(/^[a-f0-9-]{36}$/);
    expect(createAttachmentId("pending")).toBeNull();
    expect(parseThreadSegmentFromAttachmentId(createAttachmentId("pending_thread") ?? "")).toBe(
      "pending_thread",
    );
  });

  it("uses implementation-owned extensions and ignores traversal-shaped display names", () => {
    expect(
      attachmentRelativePath({
        type: "document",
        id: THREAD_ONE_ID,
        name: "../original-name.PDF",
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
    expect(() =>
      attachmentRelativePath({
        type: "document",
        id: THREAD_ONE_ID,
        name: "renamed.txt",
        mimeType: "application/pdf",
        sizeBytes: 10,
      }),
    ).toThrow(".pdf final extension");
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
          threadId: "thread-1",
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
    expect(isAttachmentOwnedByThread({ attachmentId: THREAD_ONE_ID, threadId: "thread-1" })).toBe(
      true,
    );
    expect(isAttachmentOwnedByThread({ attachmentId: THREAD_TWO_ID, threadId: "thread-1" })).toBe(
      false,
    );
    expect(isAttachmentOwnedByThread({ attachmentId: THREAD_ONE_ID, threadId: "thread.1" })).toBe(
      false,
    );
    expect(
      resolveAttachmentPath({
        attachmentsDir: NodeOS.tmpdir(),
        threadId: "thread-1",
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
          threadId: "thread-1",
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
          threadId: "thread-1",
          attachment: {
            type: "document",
            id: THREAD_ONE_ID,
            name: "page.PDF",
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

  it("plans pending attachment claims with direct filename lookups", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-claim-"),
    );
    try {
      const uuid = "00000000-0000-4000-8000-000000000001";
      const pendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));

      const claim = planAttachmentClaim({
        attachmentsDir,
        threadId: "thread-1",
        attachmentId: `pending-${uuid}`,
      });
      expect(claim).toMatchObject({
        ok: true,
        currentPath: pendingPath,
      });
      if (!claim.ok) {
        return;
      }
      expect(parseThreadSegmentFromAttachmentId(claim.finalId)).toBe("thread-1");
      expect(parseAttachmentUuid(claim.finalId)).not.toBe(uuid);
      expect(claim.finalPath).toBe(NodePath.join(attachmentsDir, `${claim.finalId}.png`));
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects lossy thread ids before planning a pending claim", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-ownership-"),
    );
    try {
      const attachmentId = "a-b-00000000-0000-4000-8000-000000000003";
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachmentId}.png`), "pixels");

      expect(planAttachmentClaim({ attachmentsDir, threadId: "a b", attachmentId })).toEqual({
        ok: false,
        reason: "invalid thread id",
      });
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("removes expired pending and partial files without touching thread attachments", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-sweep-"),
    );
    try {
      const now = 1_800_000_000_000;
      const oldTimeSeconds = (now - 2 * 24 * 60 * 60 * 1000) / 1000;
      const uuid = "00000000-0000-4000-8000-000000000002";
      const pendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.png`);
      const threadPath = NodePath.join(attachmentsDir, `thread-1-${uuid}.png`);
      const partialPath = NodePath.join(attachmentsDir, `${uuid}.part`);
      for (const filePath of [pendingPath, threadPath, partialPath]) {
        NodeFS.writeFileSync(filePath, Buffer.from("pixels"));
        NodeFS.utimesSync(filePath, oldTimeSeconds, oldTimeSeconds);
      }

      expect(sweepStalePendingAttachments({ attachmentsDir, nowMs: now })).toEqual({ deleted: 2 });
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(partialPath)).toBe(false);
      expect(NodeFS.existsSync(threadPath)).toBe(true);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
