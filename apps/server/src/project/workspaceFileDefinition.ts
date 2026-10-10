// @effect-diagnostics nodeBuiltinImport:off
// Pure parsing: `path.win32`/`path.posix` follow the server's platform on any OS.
import type { WorkspaceFileDiagnostic, WorkspaceFolderEntry } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface WorkspaceFileParseInput {
  readonly text: string;
  /** The workspace file's normalized absolute server path. Relative folders resolve from its directory. */
  readonly filePath: string;
  /** The server's platform, which decides path syntax and case-insensitive duplicates. */
  readonly platform: NodeJS.Platform;
}

type Entry = { readonly path: string } | { readonly uri: string };

function lineAndColumn(text: string, offset: number) {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: offset - lineStart + 1 };
}

function lastSegment(location: string): string | undefined {
  return location.split(/[\\/]/).findLast((segment) => segment.length > 0);
}

// VS Code writes upper-case drive letters, and `file:///c%3A/...` URIs decode
// to lower-case ones. One spelling keeps stored folders and roots comparable.
function serverPath(location: string, windows: boolean): string {
  return windows ? location.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : location;
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Read a VS Code `.code-workspace` file's folders, as VS Code reads them: JSONC,
 * paths relative to the file's directory, no `~` or variable expansion, and
 * `file:` URIs as paths. Other URIs are kept for display. Exact duplicates are
 * dropped, the first one winning, and nested folders are kept. The file is
 * rejected without partial output when it is malformed, names no folder, or
 * starts with a folder this server can't reach.
 */
export function parseWorkspaceFile(
  input: WorkspaceFileParseInput,
): Result.Result<ReadonlyArray<WorkspaceFolderEntry>, WorkspaceFileDiagnostic> {
  const windows = input.platform === "win32";
  const path = windows ? NodePath.win32 : NodePath.posix;
  const text = input.text.startsWith("﻿") ? input.text.slice(1) : input.text;
  const errors: Array<ParseError> = [];
  const document: unknown = parse(text, errors, { allowTrailingComma: true });
  const syntaxError = errors[0];
  if (syntaxError !== undefined) {
    const position = lineAndColumn(text, syntaxError.offset);
    return Result.fail({
      code: "malformed-jsonc",
      message: `The workspace file isn't valid JSON (${printParseErrorCode(syntaxError.error)} at line ${position.line}, column ${position.column}).`,
      path: input.filePath,
      ...position,
    });
  }
  const invalid = (message: string, entryIndex?: number): WorkspaceFileDiagnostic => ({
    code: "invalid-shape",
    message,
    path: input.filePath,
    ...(entryIndex === undefined ? {} : { entryIndex }),
  });
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return Result.fail(invalid("A workspace file must be a JSON object with a folders list."));
  }
  const rawFolders: unknown = (document as { readonly folders?: unknown }).folders;
  if (!Array.isArray(rawFolders)) {
    return Result.fail(invalid("The workspace file has no folders list."));
  }

  const directory = path.dirname(input.filePath);
  const seen = new Set<string>();
  const folders: Array<WorkspaceFolderEntry> = [];
  for (const [entryIndex, raw] of rawFolders.entries()) {
    const entry = readEntry(raw, directory, path, windows);
    if (Result.isFailure(entry)) return Result.fail(invalid(entry.failure, entryIndex));
    const { name, ...location } = entry.success;
    const key =
      "path" in location
        ? `path:${windows ? location.path.toLowerCase() : location.path}`
        : location.uri;
    if (seen.has(key)) continue;
    seen.add(key);
    const fallbackName =
      "path" in location
        ? (lastSegment(location.path) ?? location.path)
        : uriDisplayName(location.uri);
    folders.push({ ...location, name: name ?? fallbackName });
  }

  if (folders.length === 0) {
    return Result.fail({
      code: "empty-folders",
      message: "This workspace file contains no folders.",
      path: input.filePath,
    });
  }
  if (folders[0]!.path === undefined) {
    return Result.fail({
      code: "primary-remote",
      message: "Move a local folder to the top of the workspace file in VS Code.",
      path: input.filePath,
      entryIndex: 0,
    });
  }
  return Result.succeed(folders);
}

function readEntry(
  raw: unknown,
  directory: string,
  path: NodePath.PlatformPath,
  windows: boolean,
): Result.Result<Entry & { readonly name?: string }, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return Result.fail("Each folder must be an object with a path or a uri.");
  }
  const { path: rawPath, uri: rawUri, name: rawName } = raw as Record<string, unknown>;
  if (rawName !== undefined && typeof rawName !== "string") {
    return Result.fail("A folder's name must be a string.");
  }
  const name = rawName?.trim() || undefined;
  const named = <Location extends Entry>(location: Location) =>
    Result.succeed(name === undefined ? location : { ...location, name });
  if (typeof rawPath === "string" && rawUri === undefined) {
    const trimmed = rawPath.trim();
    if (trimmed === "") return Result.fail("A folder's path can't be empty.");
    return named({ path: serverPath(path.resolve(directory, trimmed), windows) });
  }
  if (typeof rawUri === "string" && rawPath === undefined) {
    let url: URL;
    try {
      url = new URL(rawUri.trim());
    } catch {
      return Result.fail("A folder's uri isn't a valid URI.");
    }
    if (url.protocol !== "file:") return named({ uri: rawUri.trim() });
    try {
      return named({
        // `resolve` also drops a trailing separator, so `file:///srv/a/` matches `/srv/a`.
        path: serverPath(path.resolve(NodeURL.fileURLToPath(url, { windows })), windows),
      });
    } catch {
      return Result.fail("A folder's file URI doesn't name a path on this server.");
    }
  }
  return Result.fail("Each folder needs exactly one of a path or a uri.");
}

function uriDisplayName(uri: string): string {
  const url = URL.parse(uri);
  if (url === null) return uri;
  const segment = lastSegment(url.pathname);
  return segment === undefined ? decoded(url.host) || uri : decoded(segment);
}

const REMOTE_KINDS: Record<string, string> = {
  "ssh-remote": "SSH",
  wsl: "WSL",
  tunnel: "Tunnel",
  codespaces: "Codespaces",
  "dev-container": "Dev Container",
  "attached-container": "Dev Container",
};

/**
 * Where a kept URI folder lives, for "Remote (SSH: devbox), not available
 * here". A `vscode-remote` authority is `<kind>+<host>`; a container's host is
 * encoded configuration, so only its kind is shown.
 */
export function describeRemoteFolder(uri: string): string | undefined {
  const url = URL.parse(uri);
  if (url === null) return undefined;
  const authority = decoded(url.host);
  if (url.protocol !== "vscode-remote:") {
    const scheme = url.protocol.slice(0, -1);
    return authority === "" ? scheme : `${scheme}: ${authority}`;
  }
  const separator = authority.indexOf("+");
  const kind = separator === -1 ? authority : authority.slice(0, separator);
  const host = separator === -1 ? "" : authority.slice(separator + 1);
  const label = REMOTE_KINDS[kind] ?? kind;
  if (label === "") return undefined;
  return host === "" || kind.endsWith("container") ? label : `${label}: ${host}`;
}
