import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { describeRemoteFolder, parseWorkspaceFile } from "./workspaceFileDefinition.ts";

const posix = (text: string, filePath = "/work/team/team.code-workspace") =>
  parseWorkspaceFile({ text, filePath, platform: "linux" });
const windows = (text: string, filePath = "C:\\Work\\team\\team.code-workspace") =>
  parseWorkspaceFile({ text, filePath, platform: "win32" });

const folders = (result: ReturnType<typeof parseWorkspaceFile>) => {
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
};
const diagnostic = (result: ReturnType<typeof parseWorkspaceFile>) => {
  if (Result.isSuccess(result)) throw new Error("Expected the file to be rejected.");
  return result.failure;
};

describe("parseWorkspaceFile", () => {
  it("reads JSONC with comments and trailing commas, ignoring the other workspace keys", () => {
    expect(
      folders(
        posix(`\uFEFF{
          // The app comes first.
          "folders": [
            { "path": "app", "name": "App" }, /* the api */
            { "path": "../api", },
          ],
          "settings": { "editor.tabSize": 2 },
          "extensions": { "recommendations": [] },
          "launch": {},
          "tasks": { "version": "2.0.0" },
        }`),
      ),
    ).toEqual([
      { path: "/work/team/app", name: "App" },
      { path: "/work/api", name: "api" },
    ]);
  });

  it("resolves relative paths from the file's directory, without expanding ~", () => {
    expect(
      folders(
        posix(`{ "folders": [{ "path": "." }, { "path": "/srv/x/" }, { "path": "~/notes" }] }`),
      ),
    ).toEqual([
      { path: "/work/team", name: "team" },
      { path: "/srv/x", name: "x" },
      { path: "/work/team/~/notes", name: "notes" },
    ]);
  });

  it("reads Windows paths written with forward slashes, as VS Code writes them", () => {
    expect(
      folders(
        windows(
          `{ "folders": [{ "path": "C:/Work/app" }, { "path": "../lib/core" }, { "path": "D:\\\\data" }] }`,
        ),
      ),
    ).toEqual([
      { path: "C:\\Work\\app", name: "app" },
      { path: "C:\\Work\\lib\\core", name: "core" },
      { path: "D:\\data", name: "data" },
    ]);
  });

  it("turns file URIs into paths, decoding them, with Windows drives and UNC shares", () => {
    expect(
      folders(
        windows(`{ "folders": [
          { "uri": "file:///c%3A/Users/me/My%20App" },
          { "uri": "file://server/share/repo", "name": "Shared" }
        ] }`),
      ),
    ).toEqual([
      { path: "C:\\Users\\me\\My App", name: "My App" },
      { path: "\\\\server\\share\\repo", name: "Shared" },
    ]);
    expect(folders(posix(`{ "folders": [{ "uri": "file:///home/me/my%20app" }] }`))).toEqual([
      { path: "/home/me/my app", name: "my app" },
    ]);
  });

  it("keeps other URIs as they are, named by their last segment", () => {
    expect(
      folders(
        posix(`{ "folders": [
          { "path": "app" },
          { "uri": "vscode-remote://ssh-remote+devbox/srv/api" },
          { "uri": "vscode-vfs://github/t3tools/t3code", "name": "Upstream" }
        ] }`),
      ),
    ).toEqual([
      { path: "/work/team/app", name: "app" },
      { uri: "vscode-remote://ssh-remote+devbox/srv/api", name: "api" },
      { uri: "vscode-vfs://github/t3tools/t3code", name: "Upstream" },
    ]);
  });

  it("drops later duplicates across paths and file URIs, and across case on Windows", () => {
    expect(
      folders(
        windows(`{ "folders": [
          { "path": "app", "name": "First" },
          { "uri": "file:///C:/Work/team/app", "name": "Second" },
          { "path": "APP" },
          { "path": "app/src" }
        ] }`),
      ),
    ).toEqual([
      { path: "C:\\Work\\team\\app", name: "First" },
      { path: "C:\\Work\\team\\app\\src", name: "src" },
    ]);
    // POSIX paths are case-sensitive, and a trailing slash names the same folder.
    expect(folders(posix(`{ "folders": [{ "path": "app" }, { "path": "APP" }] }`))).toHaveLength(2);
    expect(
      folders(posix(`{ "folders": [{ "uri": "file:///srv/a/" }, { "path": "/srv/a" }] }`)),
    ).toEqual([{ path: "/srv/a", name: "a" }]);
  });

  it("rejects a file with no folders, or a remote folder first", () => {
    expect(diagnostic(posix(`{ "folders": [] }`)).code).toBe("empty-folders");
    expect(
      diagnostic(
        posix(
          `{ "folders": [{ "uri": "vscode-remote://ssh-remote+devbox/srv" }, { "path": "app" }] }`,
        ),
      ),
    ).toEqual({
      code: "primary-remote",
      message: "Move a local folder to the top of the workspace file in VS Code.",
      path: "/work/team/team.code-workspace",
      entryIndex: 0,
    });
  });

  it("reports where malformed JSONC breaks", () => {
    expect(diagnostic(posix(`{\n  "folders": [\n    { "path": "app" } }\n  ]\n}`))).toMatchObject({
      code: "malformed-jsonc",
      line: 3,
      column: 23,
    });
    expect(diagnostic(posix("")).code).toBe("malformed-jsonc");
  });

  it("rejects bad shapes and names the offending entry", () => {
    expect(diagnostic(posix(`[]`)).code).toBe("invalid-shape");
    expect(diagnostic(posix(`{ "settings": {} }`)).code).toBe("invalid-shape");
    for (const entry of [
      `"app"`,
      `{ "name": "app" }`,
      `{ "path": "app", "uri": "file:///app" }`,
      `{ "path": "  " }`,
      `{ "path": "app", "name": 3 }`,
      `{ "uri": "not a uri" }`,
    ]) {
      expect(diagnostic(posix(`{ "folders": [{ "path": "ok" }, ${entry}] }`))).toMatchObject({
        code: "invalid-shape",
        entryIndex: 1,
      });
    }
  });
});

describe("describeRemoteFolder", () => {
  it("names where a remote folder lives", () => {
    expect(describeRemoteFolder("vscode-remote://ssh-remote+devbox/srv/api")).toBe("SSH: devbox");
    expect(describeRemoteFolder("vscode-remote://ssh-remote%2Bdevbox/srv/api")).toBe("SSH: devbox");
    expect(describeRemoteFolder("vscode-remote://wsl+Ubuntu/home/me")).toBe("WSL: Ubuntu");
    expect(describeRemoteFolder("vscode-remote://dev-container+7b22/workspaces/app")).toBe(
      "Dev Container",
    );
    expect(describeRemoteFolder("vscode-vfs://github/t3tools/t3code")).toBe("vscode-vfs: github");
  });
});
