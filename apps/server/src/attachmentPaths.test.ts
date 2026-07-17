// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  normalizeAttachmentRelativePathForPlatform,
  resolveAttachmentRelativePathForPlatform,
} from "./attachmentPaths.ts";

describe("attachmentPaths", () => {
  it("constructs contained POSIX attachment paths", () => {
    expect(
      resolveAttachmentRelativePathForPlatform(NodePath.posix, {
        attachmentsDir: "/var/lib/t3/attachments",
        relativePath: "thread-1-file.PDF",
      }),
    ).toBe("/var/lib/t3/attachments/thread-1-file.PDF");

    expect(
      resolveAttachmentRelativePathForPlatform(NodePath.posix, {
        attachmentsDir: "/var/lib/t3/attachments",
        relativePath: "../outside.pdf",
      }),
    ).toBeNull();
    expect(
      normalizeAttachmentRelativePathForPlatform(NodePath.posix, "..\\outside.pdf"),
    ).toBeNull();
  });

  it("constructs contained Windows attachment paths case-insensitively", () => {
    expect(
      resolveAttachmentRelativePathForPlatform(NodePath.win32, {
        attachmentsDir: "C:\\Users\\Example\\attachments",
        relativePath: "thread-1-file.pdf",
      }),
    ).toBe("C:\\Users\\Example\\attachments\\thread-1-file.pdf");

    expect(
      resolveAttachmentRelativePathForPlatform(NodePath.win32, {
        attachmentsDir: "C:\\Users\\Example\\attachments",
        relativePath: "..\\outside.pdf",
      }),
    ).toBeNull();
    expect(
      resolveAttachmentRelativePathForPlatform(NodePath.win32, {
        attachmentsDir: "C:\\Users\\Example\\attachments",
        relativePath: "D:\\outside.pdf",
      }),
    ).toBeNull();
  });

  it("rejects absolute, empty, and NUL-containing relative paths on both platforms", () => {
    for (const pathApi of [NodePath.posix, NodePath.win32]) {
      expect(normalizeAttachmentRelativePathForPlatform(pathApi, "")).toBeNull();
      expect(normalizeAttachmentRelativePathForPlatform(pathApi, ".")).toBeNull();
      expect(normalizeAttachmentRelativePathForPlatform(pathApi, "/absolute.pdf")).toBeNull();
      expect(normalizeAttachmentRelativePathForPlatform(pathApi, "\\absolute.pdf")).toBeNull();
      expect(normalizeAttachmentRelativePathForPlatform(pathApi, "safe\0.pdf")).toBeNull();
    }
  });
});
