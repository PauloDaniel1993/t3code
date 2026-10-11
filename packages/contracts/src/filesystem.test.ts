import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FilesystemBrowseError,
  FilesystemBrowseInput,
  FilesystemBrowseResult,
} from "./filesystem.ts";
const decodeBrowseInput = Schema.decodeUnknownSync(FilesystemBrowseInput);
const decodeBrowseResult = Schema.decodeUnknownSync(FilesystemBrowseResult);

describe("workspace file browse compatibility", () => {
  it("decodes older directory-only peers and opt-in file entries", () => {
    const decode = decodeBrowseResult;
    expect(
      decode({ parentPath: "/", entries: [{ name: "repo", fullPath: "/repo" }] }).entries[0]?.kind,
    ).toBeUndefined();
    expect(
      decode({
        parentPath: "/",
        entries: [
          { name: "team.code-workspace", fullPath: "/team.code-workspace", kind: "workspace-file" },
        ],
      }).entries[0]?.kind,
    ).toBe("workspace-file");
    expect(
      decodeBrowseInput({
        partialPath: "/",
        includeWorkspaceFiles: true,
      }).includeWorkspaceFiles,
    ).toBe(true);
  });
});

describe("FilesystemBrowseError", () => {
  it("derives a stable message from browse context while retaining the cause", () => {
    const cause = new Error("sensitive filesystem detail");
    const error = new FilesystemBrowseError({
      cwd: "/workspace",
      partialPath: "./src/mai",
      failure: "read_directory_failed",
      parentPath: "/workspace/src",
      cause,
    });

    expect(error.message).toBe("Failed to browse filesystem path './src/mai' from '/workspace'.");
    expect(error.message).not.toContain(cause.message);
    expect(error.cause).toBe(cause);
  });

  it("decodes legacy message-only errors during rolling upgrades", () => {
    const decodeError = Schema.decodeUnknownSync(FilesystemBrowseError);
    const error = decodeError({
      _tag: "FilesystemBrowseError",
      message: "Legacy filesystem browse failure.",
    });

    expect(error.message).toBe("Legacy filesystem browse failure.");
    expect(error.partialPath).toBeUndefined();
    expect(error.failure).toBeUndefined();
  });
});
