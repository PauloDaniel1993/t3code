/**
 * WorkspaceFolderFiles - files across a project's or thread's workspace folders.
 *
 * Resolves a `WorkspaceScope` to its folder table (a thread's frozen snapshot
 * mapped into its worktrees, else the project's current folders), resolves
 * canonical `<label>/<path>` paths inside one folder, and fans the scoped file
 * RPCs out over folders. Each folder is still served by the single-cwd
 * services, `WorkspaceEntries` and `WorkspaceFileSystem`.
 *
 * @module WorkspaceFolderFiles
 */
import {
  type ProjectContentMatch,
  type ProjectEntry,
  type ProjectListEntriesResult,
  type ProjectListEntriesScopedInput,
  type ProjectReadFileResult,
  type ProjectReadFileScopedInput,
  type ProjectSearchContentsResult,
  type ProjectSearchContentsScopedInput,
  type ProjectSearchEntriesResult,
  type ProjectSearchEntriesScopedInput,
  type ProjectWriteFileResult,
  type ProjectWriteFileScopedInput,
  type WorkspaceScope,
  WorkspaceScopeError,
  type WorkspaceScopeFolder,
} from "@t3tools/contracts";
import {
  isPathWithin,
  isSamePath,
  owningFolder,
  parseCanonicalPath,
  projectFolders,
  type ResolvedWorkspaceFolder,
  resolveThreadWorkspace,
  toCanonicalPath,
} from "@t3tools/shared/workspaceFolders";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

/** Folders searched at once. */
const FOLDER_CONCURRENCY = 4;
/** Path and line bytes one scoped search response may carry, across every folder. */
export const SCOPED_SEARCH_MAX_BYTES = 1024 * 1024;

export interface ResolvedWorkspaceScope {
  /**
   * Every folder in workspace order, primary first. `effectivePath` is where
   * its files are now, null when the folder is unavailable.
   */
  readonly folders: ReadonlyArray<ResolvedWorkspaceFolder>;
  /** The folders the request addresses: the one the scope's `folderPath` names, else all. */
  readonly selected: ReadonlyArray<ResolvedWorkspaceFolder>;
}

export interface ResolvedWorkspacePath {
  /** The folder's effective path, for the single-cwd services. */
  readonly cwd: string;
  /** The `/`-separated path inside the folder. */
  readonly relativePath: string;
  readonly folder: ResolvedWorkspaceFolder;
  readonly canonicalPath: string;
}

export class WorkspaceFolderFiles extends Context.Service<
  WorkspaceFolderFiles,
  {
    readonly resolveScope: (
      scope: WorkspaceScope,
    ) => Effect.Effect<ResolvedWorkspaceScope, WorkspaceScopeError>;
    /**
     * Resolve a canonical path to one available folder. With a `folderPath`
     * in the scope, the path's label must still name that folder. The path
     * stays inside the folder lexically.
     */
    readonly resolvePath: (
      scope: WorkspaceScope,
      canonicalPath: string,
    ) => Effect.Effect<
      ResolvedWorkspacePath,
      WorkspaceScopeError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    readonly searchEntries: (
      input: ProjectSearchEntriesScopedInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceScopeError>;
    readonly searchContents: (
      input: ProjectSearchContentsScopedInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceScopeError>;
    readonly listEntries: (
      input: ProjectListEntriesScopedInput,
    ) => Effect.Effect<
      ProjectListEntriesResult,
      WorkspaceScopeError | WorkspaceEntries.WorkspaceEntriesError
    >;
    readonly readFile: (
      input: ProjectReadFileScopedInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      | WorkspaceScopeError
      | WorkspaceFileSystem.WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    readonly writeFile: (
      input: ProjectWriteFileScopedInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      | WorkspaceScopeError
      | WorkspaceFileSystem.WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFolderFiles") {}

function scopeError(
  scope: WorkspaceScope,
  failure: WorkspaceScopeError["failure"],
  details: { readonly folder?: string | undefined; readonly cause?: unknown } = {},
): WorkspaceScopeError {
  return new WorkspaceScopeError({
    failure,
    projectId: scope.projectId,
    ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
    ...(details.folder === undefined ? {} : { folder: details.folder }),
    ...(details.cause === undefined ? {} : { cause: details.cause }),
  });
}

/** A folder's identity: its original path, or its kept URI. */
function folderIdentity(folder: ResolvedWorkspaceFolder): string {
  return folder.folder.path ?? folder.folder.uri ?? folder.label;
}

function isFolder(folder: ResolvedWorkspaceFolder, folderPath: string): boolean {
  return folder.folder.path === undefined
    ? folder.folder.uri === folderPath
    : isSamePath(folder.folder.path, folderPath);
}

function folderTable(
  folders: ReadonlyArray<ResolvedWorkspaceFolder>,
  failed: ReadonlySet<ResolvedWorkspaceFolder> = new Set(),
): ReadonlyArray<WorkspaceScopeFolder> {
  return folders.map((folder) => ({
    folderPath: folderIdentity(folder),
    label: folder.label,
    status:
      folder.effectivePath === null ? "unavailable" : failed.has(folder) ? "index-error" : "ok",
  }));
}

/**
 * Merge per-folder ranked lists: rank by rank in folder order, keeping the
 * first of each key, until `limit` items or `maxBytes`. Truncated when any
 * folder was, or when an item is left out.
 */
function mergeRanked<Item>(input: {
  readonly lists: ReadonlyArray<ReadonlyArray<Item>>;
  readonly key: (item: Item) => string;
  readonly bytes: (item: Item) => number;
  readonly limit: number;
  readonly maxBytes: number;
}): { readonly items: ReadonlyArray<Item>; readonly truncated: boolean } {
  const items: Item[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  const longest = Math.max(0, ...input.lists.map((list) => list.length));
  for (let rank = 0; rank < longest; rank += 1) {
    for (const list of input.lists) {
      const item = list[rank];
      if (item === undefined) continue;
      const key = input.key(item);
      if (seen.has(key)) continue;
      const size = input.bytes(item);
      if (items.length >= input.limit || bytes + size > input.maxBytes) {
        return { items, truncated: true };
      }
      seen.add(key);
      items.push(item);
      bytes += size;
    }
  }
  return { items, truncated: false };
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

  const isDirectory = (directory: string) =>
    fileSystem.stat(directory).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const resolveScope: WorkspaceFolderFiles["Service"]["resolveScope"] = Effect.fn(
    "WorkspaceFolderFiles.resolveScope",
  )(function* (scope) {
    const project = yield* projects
      .get(scope.projectId)
      .pipe(Effect.mapError((cause) => scopeError(scope, "read-failed", { cause })));
    if (Option.isNone(project)) return yield* scopeError(scope, "project-not-found");

    let folders: ReadonlyArray<ResolvedWorkspaceFolder>;
    if (scope.threadId === undefined) {
      folders = projectFolders(project.value).map((folder, index) => ({
        folder,
        label: folder.label,
        effectivePath: folder.path ?? null,
        isPrimary: index === 0,
        checkoutRoot: undefined,
      }));
    } else {
      const thread = yield* projections
        .getThread(scope.threadId)
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "ProjectionStoreThreadNotFoundError"
              ? scopeError(scope, "thread-not-found")
              : scopeError(scope, "read-failed", { cause }),
          ),
        );
      if (thread.projectId !== scope.projectId || thread.deletedAt !== null) {
        return yield* scopeError(scope, "thread-not-found");
      }
      folders = resolveThreadWorkspace({ thread, project: project.value }).folders;
    }

    // File requests aren't tied to a run, so availability is checked now: a
    // folder is available while its effective path is a directory.
    folders = yield* Effect.forEach(
      folders,
      (folder) =>
        folder.effectivePath === null
          ? Effect.succeed(folder)
          : isDirectory(folder.effectivePath).pipe(
              Effect.map((available) => (available ? folder : { ...folder, effectivePath: null })),
            ),
      { concurrency: FOLDER_CONCURRENCY },
    );
    const folderPath = scope.folderPath;
    if (folderPath === undefined) return { folders, selected: folders };
    const selected = folders.filter((folder) => isFolder(folder, folderPath));
    if (selected.length === 0) {
      return yield* scopeError(scope, "folder-not-found", { folder: folderPath });
    }
    return { folders, selected };
  });

  /**
   * The available folder a canonical path names, checked against the scope's
   * `folderPath`. Null for the root of a scope with several folders and no
   * `folderPath`, which is the folder table itself.
   */
  const locate = Effect.fn("WorkspaceFolderFiles.locate")(function* (
    scope: WorkspaceScope,
    resolved: ResolvedWorkspaceScope,
    canonicalPath: string,
  ) {
    const pinned = scope.folderPath === undefined ? undefined : resolved.selected[0];
    let target: { readonly folder: ResolvedWorkspaceFolder; readonly relativePath: string };
    if (canonicalPath === "" && resolved.folders.length > 1) {
      if (pinned === undefined) return null;
      target = { folder: pinned, relativePath: "" };
    } else {
      const parsed = parseCanonicalPath(canonicalPath, resolved.folders);
      if (parsed === null) {
        return yield* scopeError(scope, "folder-not-found", {
          folder: canonicalPath.split("/", 1)[0],
        });
      }
      if (pinned !== undefined && parsed.folder !== pinned) {
        return yield* scopeError(scope, "folder-changed", { folder: folderIdentity(pinned) });
      }
      target = parsed;
    }
    const cwd = target.folder.effectivePath;
    if (cwd === null) {
      return yield* scopeError(scope, "folder-unavailable", {
        folder: folderIdentity(target.folder),
      });
    }
    return { ...target, cwd };
  });

  /**
   * Turns a path one folder returned into the canonical path of the folder
   * that owns it: a file inside a nested folder belongs to the nested one.
   */
  const canonicalizer =
    (resolved: ResolvedWorkspaceScope) => (folder: ResolvedWorkspaceFolder, cwd: string) => {
      const located = resolved.folders.flatMap((candidate) =>
        candidate.effectivePath === null
          ? []
          : [{ path: candidate.effectivePath, folder: candidate }],
      );
      const count = resolved.folders.length;
      const nested = located.some(
        (other) => other.folder !== folder && isPathWithin(cwd, other.path),
      );
      return (relativePath: string): string => {
        if (!nested) return toCanonicalPath(folder, relativePath, count);
        const absolutePath = path.join(cwd, relativePath);
        const owner = owningFolder(absolutePath, located);
        if (owner === undefined || owner.folder === folder) {
          return toCanonicalPath(folder, relativePath, count);
        }
        const ownedPath = path.relative(owner.path, absolutePath).replaceAll("\\", "/");
        return toCanonicalPath(owner.folder, ownedPath, count);
      };
    };

  /**
   * Run one search per selected available folder, at most four at a time. A
   * folder whose search fails is reported in the folder table instead.
   */
  const fanOut = <A, E>(
    resolved: ResolvedWorkspaceScope,
    search: (cwd: string) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const toCanonical = canonicalizer(resolved);
      const outcomes = yield* Effect.forEach(
        resolved.selected,
        (folder) => {
          const cwd = folder.effectivePath;
          if (cwd === null) return Effect.succeed(undefined);
          return search(cwd).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Workspace folder search failed", { folder: cwd, cause }),
            ),
            Effect.result,
            Effect.map((result) => ({ folder, result, toCanonical: toCanonical(folder, cwd) })),
          );
        },
        { concurrency: FOLDER_CONCURRENCY },
      );
      const failed = new Set<ResolvedWorkspaceFolder>();
      const results: Array<{
        readonly value: A;
        readonly toCanonical: (relativePath: string) => string;
      }> = [];
      for (const outcome of outcomes) {
        if (outcome === undefined) continue;
        if (Result.isFailure(outcome.result)) failed.add(outcome.folder);
        else results.push({ value: outcome.result.success, toCanonical: outcome.toCanonical });
      }
      return { results, folders: folderTable(resolved.folders, failed) };
    });

  const searchEntries: WorkspaceFolderFiles["Service"]["searchEntries"] = Effect.fn(
    "WorkspaceFolderFiles.searchEntries",
  )(function* (input) {
    const { scope, ...query } = input;
    const resolved = yield* resolveScope(scope);
    const { results, folders } = yield* fanOut(resolved, (cwd) =>
      workspaceEntries.search({ cwd, ...query }),
    );
    const merged = mergeRanked<ProjectEntry>({
      lists: results.map(({ value, toCanonical }) =>
        value.entries.map((entry) => ({ ...entry, path: toCanonical(entry.path) })),
      ),
      key: (entry) => entry.path,
      bytes: (entry) => byteLength(entry.path),
      limit: input.limit,
      maxBytes: SCOPED_SEARCH_MAX_BYTES,
    });
    return {
      entries: merged.items,
      truncated: merged.truncated || results.some(({ value }) => value.truncated),
      folders,
    };
  });

  const searchContents: WorkspaceFolderFiles["Service"]["searchContents"] = Effect.fn(
    "WorkspaceFolderFiles.searchContents",
  )(function* (input) {
    const { scope, ...query } = input;
    const resolved = yield* resolveScope(scope);
    const { results, folders } = yield* fanOut(resolved, (cwd) =>
      workspaceEntries.searchContents({ cwd, ...query }),
    );
    const merged = mergeRanked<ProjectContentMatch>({
      lists: results.map(({ value, toCanonical }) =>
        value.matches.map((match) => ({ ...match, path: toCanonical(match.path) })),
      ),
      key: (match) => `${match.path}\n${match.lineNumber}`,
      bytes: (match) => byteLength(match.path) + byteLength(match.lineContent),
      limit: input.limit,
      maxBytes: SCOPED_SEARCH_MAX_BYTES,
    });
    const regexFallbackError = results.find(({ value }) => value.regexFallbackError !== undefined)
      ?.value.regexFallbackError;
    return {
      matches: merged.items,
      truncated: merged.truncated || results.some(({ value }) => value.truncated),
      ...(regexFallbackError === undefined ? {} : { regexFallbackError }),
      folders,
    };
  });

  const listEntries: WorkspaceFolderFiles["Service"]["listEntries"] = Effect.fn(
    "WorkspaceFolderFiles.listEntries",
  )(function* (input) {
    const resolved = yield* resolveScope(input.scope);
    const folders = folderTable(resolved.folders);
    const target = yield* locate(input.scope, resolved, input.directoryPath);
    // Nothing loads eagerly: the root of several folders lists only the table.
    if (target === null) return { entries: [], truncated: false, folders };
    const listed = yield* workspaceEntries.list({
      cwd: target.cwd,
      directoryPath: target.relativePath,
    });
    const toCanonical = canonicalizer(resolved)(target.folder, target.cwd);
    return {
      entries: listed.entries.map((entry) => ({ ...entry, path: toCanonical(entry.path) })),
      truncated: listed.truncated,
      folders,
    };
  });

  const resolvePath: WorkspaceFolderFiles["Service"]["resolvePath"] = Effect.fn(
    "WorkspaceFolderFiles.resolvePath",
  )(function* (scope, canonicalPath) {
    const resolved = yield* resolveScope(scope);
    const target = yield* locate(scope, resolved, canonicalPath);
    if (target === null) return yield* scopeError(scope, "folder-not-found");
    const inside = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: target.cwd,
      relativePath: target.relativePath,
    });
    return {
      cwd: target.cwd,
      relativePath: inside.relativePath,
      folder: target.folder,
      canonicalPath: toCanonicalPath(target.folder, inside.relativePath, resolved.folders.length),
    };
  });

  const readFile: WorkspaceFolderFiles["Service"]["readFile"] = Effect.fn(
    "WorkspaceFolderFiles.readFile",
  )(function* (input) {
    const target = yield* resolvePath(input.scope, input.path);
    const result = yield* workspaceFileSystem.readFile({
      cwd: target.cwd,
      relativePath: target.relativePath,
    });
    return { ...result, relativePath: target.canonicalPath };
  });

  const writeFile: WorkspaceFolderFiles["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFolderFiles.writeFile",
  )(function* (input) {
    const target = yield* resolvePath(input.scope, input.path);
    yield* workspaceFileSystem.writeFile({
      cwd: target.cwd,
      relativePath: target.relativePath,
      contents: input.contents,
    });
    return { relativePath: target.canonicalPath };
  });

  return WorkspaceFolderFiles.of({
    resolveScope,
    resolvePath,
    searchEntries,
    searchContents,
    listEntries,
    readFile,
    writeFile,
  });
});

export const layer = Layer.effect(WorkspaceFolderFiles, make);
