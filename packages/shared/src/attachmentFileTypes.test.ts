import { describe, expect, it } from "vite-plus/test";

import {
  ACCEPTED_ATTACHMENT_FILE_EXTENSIONS,
  ATTACHMENT_FILE_TYPES,
  getAttachmentFileInputAccept,
  lookupAttachmentFileType,
} from "./attachmentFileTypes.ts";

const EXPECTED_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "log",
  "json",
  "jsonl",
  "csv",
  "tsv",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "graphql",
  "gql",
  "proto",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "cs",
  "py",
  "java",
  "kt",
  "kts",
  "go",
  "rs",
  "rb",
  "php",
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hh",
  "hpp",
  "hxx",
  "sql",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "swift",
  "dart",
  "lua",
  "r",
  "vue",
  "svelte",
  "xlsx",
] as const;

describe("attachment file types", () => {
  it("contains exactly the supported extension registry", () => {
    expect(ACCEPTED_ATTACHMENT_FILE_EXTENSIONS).toEqual(EXPECTED_EXTENSIONS);
    expect(Object.isFrozen(ATTACHMENT_FILE_TYPES)).toBe(true);
    expect(Object.values(ATTACHMENT_FILE_TYPES).every(Object.isFrozen)).toBe(true);
  });

  it("resolves every registered extension case-insensitively", () => {
    for (const [extension, fileType] of Object.entries(ATTACHMENT_FILE_TYPES)) {
      expect(lookupAttachmentFileType(`example.${extension.toUpperCase()}`)).toBe(fileType);
    }

    expect(lookupAttachmentFileType("REPORT.XLSX")).toEqual({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      contentKind: "binary",
    });
  });

  it("uses the final filename extension instead of advisory browser MIME metadata", () => {
    const browserFile = { name: "Video.TS", type: "video/mp2t" };

    expect(lookupAttachmentFileType(browserFile.name)).toEqual({
      mimeType: "text/plain",
      contentKind: "text",
    });
  });

  it("rejects unsupported, extensionless, dotfile-only, and malformed names", () => {
    expect(lookupAttachmentFileType(".env")).toBeUndefined();
    expect(lookupAttachmentFileType("Dockerfile")).toBeUndefined();
    expect(lookupAttachmentFileType("installer.exe")).toBeUndefined();
    expect(lookupAttachmentFileType("report.docx")).toBeUndefined();
    expect(lookupAttachmentFileType("archive.zip")).toBeUndefined();
    expect(lookupAttachmentFileType("trailing.")).toBeUndefined();
    expect(lookupAttachmentFileType("")).toBeUndefined();
  });

  it("uses only the final extension", () => {
    expect(lookupAttachmentFileType("name.with.dots.ts")).toBe(ATTACHMENT_FILE_TYPES.ts);
  });

  it("generates an input accept string with every extension exactly once", () => {
    const acceptExtensions = getAttachmentFileInputAccept().split(",");

    expect(acceptExtensions.every((extension) => extension.startsWith("."))).toBe(true);
    expect(new Set(acceptExtensions).size).toBe(EXPECTED_EXTENSIONS.length);
    expect(acceptExtensions.map((extension) => extension.slice(1))).toEqual(EXPECTED_EXTENSIONS);
  });
});
