import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const KIMI_FAILED_TURN_MARKER = "acp: turn ended with failed reason";
const MAX_ERROR_MESSAGE_CHARS = 4_000;
const decodeUnknownJsonStringExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export interface KimiAcpLogCheckpoint {
  readonly logPath: string;
  readonly offset: number;
}

export interface KimiAcpFailure {
  readonly message: string;
  readonly code?: string;
  readonly retryable?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedErrorMessage(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const message = value.trim();
  if (message.length === 0) {
    return undefined;
  }
  return message.length <= MAX_ERROR_MESSAGE_CHARS
    ? message
    : `${message.slice(0, MAX_ERROR_MESSAGE_CHARS - 1)}…`;
}

function decodeLoggedError(value: string): unknown {
  let decoded: unknown = value.trim();
  for (let depth = 0; depth < 2 && typeof decoded === "string"; depth += 1) {
    const candidate = decoded.trim();
    if (candidate.startsWith("'") && candidate.endsWith("'")) {
      decoded = candidate.slice(1, -1);
      continue;
    }
    const result = decodeUnknownJsonStringExit(candidate);
    if (Exit.isFailure(result)) {
      return undefined;
    }
    decoded = result.value;
  }
  return decoded;
}

export function parseKimiAcpFailureLine(line: string): KimiAcpFailure | undefined {
  const markerIndex = line.indexOf(KIMI_FAILED_TURN_MARKER);
  if (markerIndex < 0) {
    return undefined;
  }
  const errorIndex = line.indexOf("error=", markerIndex + KIMI_FAILED_TURN_MARKER.length);
  if (errorIndex < 0) {
    return undefined;
  }
  const decoded = decodeLoggedError(line.slice(errorIndex + "error=".length));
  if (!isRecord(decoded)) {
    return undefined;
  }
  const message = boundedErrorMessage(decoded.message);
  if (!message) {
    return undefined;
  }
  return {
    message,
    ...(typeof decoded.code === "string" && decoded.code.trim().length > 0
      ? { code: decoded.code.trim() }
      : {}),
    ...(typeof decoded.retryable === "boolean" ? { retryable: decoded.retryable } : {}),
  };
}

export function parseLatestKimiAcpFailure(text: string): KimiAcpFailure | undefined {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    const failure = parseKimiAcpFailureLine(line);
    if (failure) {
      return failure;
    }
  }
  return undefined;
}

function readFileBestEffort(
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<string | undefined> {
  return fileSystem.readFileString(filePath).pipe(
    Effect.map((text): string | undefined => text),
    Effect.catchCause(() => Effect.as(Effect.void, undefined)),
  );
}

function expandHomePath(input: string, homeDirectory: string, path: Path.Path): string {
  if (input === "~") {
    return homeDirectory;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(homeDirectory, input.slice(2));
  }
  return input;
}

function resolveKimiDataDirectory(
  environment: NodeJS.ProcessEnv,
  path: Path.Path,
  homeDirectory: string,
): string {
  const configured = environment.KIMI_CODE_HOME?.trim();
  return configured
    ? path.resolve(expandHomePath(configured, homeDirectory, path))
    : path.join(homeDirectory, ".kimi-code");
}

function findSessionDirectory(indexText: string, sessionId: string): string | undefined {
  const lines = indexText.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    const result = decodeUnknownJsonStringExit(line);
    if (Exit.isFailure(result)) {
      // A partially written or older malformed entry must not hide prior valid entries.
      continue;
    }
    const entry = result.value;
    if (
      isRecord(entry) &&
      entry.sessionId === sessionId &&
      typeof entry.sessionDir === "string" &&
      entry.sessionDir.trim().length > 0
    ) {
      return entry.sessionDir.trim();
    }
  }
  return undefined;
}

function isPathInside(parent: string, candidate: string, path: Path.Path): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export const captureKimiAcpLogCheckpoint = Effect.fn("KimiAcpDiagnostics.captureLogCheckpoint")(
  function* (input: {
    readonly sessionId: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly homeDirectory?: string;
  }): Effect.fn.Return<KimiAcpLogCheckpoint | undefined, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = input.environment ?? process.env;
    const kimiDataDirectory = resolveKimiDataDirectory(
      environment,
      path,
      input.homeDirectory ?? NodeOS.homedir(),
    );
    const indexText = yield* readFileBestEffort(
      fileSystem,
      path.join(kimiDataDirectory, "session_index.jsonl"),
    );
    if (indexText === undefined) {
      return undefined;
    }
    const indexedSessionDirectory = findSessionDirectory(indexText, input.sessionId);
    if (!indexedSessionDirectory) {
      return undefined;
    }
    const sessionsDirectory = path.resolve(kimiDataDirectory, "sessions");
    const sessionDirectory = path.resolve(indexedSessionDirectory);
    if (!isPathInside(sessionsDirectory, sessionDirectory, path)) {
      return undefined;
    }
    const logPath = path.join(sessionDirectory, "logs", "kimi-code.log");
    const currentLog = yield* readFileBestEffort(fileSystem, logPath);
    return {
      logPath,
      offset: currentLog?.length ?? 0,
    };
  },
);

export const readKimiAcpFailureSince = Effect.fn("KimiAcpDiagnostics.readFailureSince")(function* (
  checkpoint: KimiAcpLogCheckpoint | undefined,
): Effect.fn.Return<KimiAcpFailure | undefined, never, FileSystem.FileSystem> {
  if (!checkpoint) {
    return undefined;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const currentLog = yield* readFileBestEffort(fileSystem, checkpoint.logPath);
  if (currentLog === undefined) {
    return undefined;
  }
  const appendedLog =
    currentLog.length >= checkpoint.offset ? currentLog.slice(checkpoint.offset) : currentLog;
  return parseLatestKimiAcpFailure(appendedLog);
});
