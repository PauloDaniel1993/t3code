import { describe, expect, it } from "vite-plus/test";

import {
  CHAT_FILE_ATTACHMENT_ACCEPT,
  CHAT_FILE_TYPES,
  chatFileKindForMimeType,
  chatFileTypeForExtension,
  chatFileTypeForFileName,
  isChatFileMimeType,
} from "./attachmentFileTypes.ts";

describe("chat file type registry", () => {
  it("classifies by extension regardless of the browser-reported MIME type", () => {
    // Browsers report `.ts` as video/mp2t and `.cs` with an empty MIME; the
    // registry never consults the reported MIME.
    expect(chatFileTypeForFileName("video.ts")).toEqual({
      extension: ".ts",
      mimeType: "text/x-typescript",
      kind: "text",
    });
    expect(chatFileTypeForFileName("Program.cs")).toEqual({
      extension: ".cs",
      mimeType: "text/x-csharp",
      kind: "text",
    });
  });

  it("normalizes case and leading dots for extension lookups", () => {
    expect(chatFileTypeForExtension("JSON")?.mimeType).toBe("application/json");
    expect(chatFileTypeForExtension(".Yml")?.mimeType).toBe("application/yaml");
    expect(chatFileTypeForFileName("REPORT.XLSX")?.kind).toBe("binary");
  });

  it("rejects unknown, missing, and dotfile-style extensions", () => {
    expect(chatFileTypeForFileName("installer.exe")).toBeNull();
    expect(chatFileTypeForFileName("Dockerfile")).toBeNull();
    expect(chatFileTypeForFileName(".env")).toBeNull();
    expect(chatFileTypeForFileName("archive.")).toBeNull();
    expect(chatFileTypeForExtension("")).toBeNull();
  });

  it("treats every registered type except xlsx as text", () => {
    for (const fileType of CHAT_FILE_TYPES) {
      expect(fileType.kind).toBe(fileType.extension === ".xlsx" ? "binary" : "text");
    }
  });

  it("maps canonical MIME types back to a kind", () => {
    expect(chatFileKindForMimeType("application/json")).toBe("text");
    expect(
      chatFileKindForMimeType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ).toBe("binary");
    expect(chatFileKindForMimeType("video/mp2t")).toBeNull();
    expect(isChatFileMimeType("TEXT/CSV")).toBe(true);
    expect(isChatFileMimeType("application/pdf")).toBe(false);
  });

  it("builds an accept string that covers every registered extension exactly once", () => {
    const parts = CHAT_FILE_ATTACHMENT_ACCEPT.split(",");
    expect(parts).toHaveLength(CHAT_FILE_TYPES.length);
    expect(new Set(parts).size).toBe(parts.length);
    for (const part of parts) {
      expect(part).toMatch(/^\.[a-z0-9+]+$/);
    }
  });
});
