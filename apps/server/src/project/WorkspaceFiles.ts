import {
  type ProjectId,
  WorkspaceFileDiagnostic,
  type WorkspaceFolderEntry,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { expandHomePathWith } from "../pathExpansion.ts";
import { watchDirectory } from "../wayfinder/WayfinderFiles.ts";
import { parseWorkspaceFile } from "./workspaceFileDefinition.ts";

// VS Code workspace files are a few kilobytes; anything far larger is not one.
const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024;
// Editors write a file in several steps; a burst of them is one change.
const WATCH_DEBOUNCE = Duration.millis(100);

/** A workspace file's folders, read from its normalized server path. */
export interface WorkspaceFileDefinition {
  /** The file's normalized server path, which identifies the link. */
  readonly filePath: string;
  /** In file order, deduplicated; the first is a local path. */
  readonly folders: ReadonlyArray<WorkspaceFolderEntry>;
}

export class WorkspaceFileReadError extends Schema.TaggedError<WorkspaceFileReadError>()(
  "WorkspaceFileReadError",
  { diagnostic: WorkspaceFileDiagnostic },
) {
  override get message(): string {
    return this.diagnostic.message;
  }
}

/** The normalized server path a requested workspace-file path names. */
export const resolveWorkspaceFilePath = (requestedPath: string, path: Path.Path): string =>
  path.resolve(expandHomePathWith(requestedPath.trim(), path));

export class WorkspaceFiles extends Context.Service<
  WorkspaceFiles,
  {
    /** A suffix selects file mode unless the path is an existing directory. */
    readonly resolveProjectPath: (
      input: string,
    ) => Effect.Effect<{ readonly path: string; readonly kind: "directory" | "workspace-file" }>;
    /**
     * Read a workspace file chosen explicitly as one. A directory is not a
     * workspace file whatever its name: callers choose file mode only for files.
     */
    readonly read: (
      filePath: string,
    ) => Effect.Effect<WorkspaceFileDefinition, WorkspaceFileReadError>;
    /**
     * Watch a linked project's workspace file until it is unwatched, replacing
     * the project's earlier watch. `onHint` runs after each burst of changes
     * to the file, and once more if the watch stops working; it only hints
     * that the file should be read again. False when the file can't be
     * watched, so changes are seen only when something reads it.
     */
    readonly watch: (
      projectId: ProjectId,
      filePath: string,
      onHint: Effect.Effect<void>,
    ) => Effect.Effect<boolean>;
    readonly unwatch: (projectId: ProjectId) => Effect.Effect<void>;
    /** Whether the project's watch is on this file and still works. */
    readonly isWatching: (projectId: ProjectId, filePath: string) => Effect.Effect<boolean>;
  }
>()("t3/project/WorkspaceFiles") {}

interface ProjectWatch {
  readonly scope: Scope.Closeable;
  readonly filePath: string;
  /** Completes when the watch stops working. */
  readonly closed: Deferred.Deferred<void>;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const layerScope = yield* Scope.Scope;
  const watches = new Map<ProjectId, ProjectWatch>();
  const watchLock = yield* Semaphore.make(1);

  const resolveProjectPath: WorkspaceFiles["Service"]["resolveProjectPath"] = Effect.fn(
    "WorkspaceFiles.resolveProjectPath",
  )(function* (input) {
    const resolvedPath = path.resolve(expandHomePathWith(input.trim(), path));
    if (!/\.code-workspace$/i.test(resolvedPath)) {
      return { path: resolvedPath, kind: "directory" as const };
    }
    const stat = yield* Effect.result(fileSystem.stat(resolvedPath));
    return {
      path: resolvedPath,
      kind:
        stat._tag === "Success" && stat.success.type === "Directory"
          ? ("directory" as const)
          : ("workspace-file" as const),
    };
  });

  const read: WorkspaceFiles["Service"]["read"] = Effect.fn("WorkspaceFiles.read")(
    function* (requestedPath) {
      const filePath = resolveWorkspaceFilePath(requestedPath, path);
      const fail = (diagnostic: Omit<WorkspaceFileDiagnostic, "path">) =>
        Effect.fail(new WorkspaceFileReadError({ diagnostic: { ...diagnostic, path: filePath } }));
      const unreadable = () =>
        fail({ code: "unreadable", message: `Can't read the workspace file ${filePath}.` });

      const stat = yield* fileSystem
        .stat(filePath)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? fail({ code: "file-not-found", message: `Workspace file not found: ${filePath}` })
              : unreadable(),
          ),
        );
      if (stat.type !== "File") {
        return yield* fail({
          code: "not-a-file",
          message: `${filePath} is not a file. Choose a .code-workspace file.`,
        });
      }
      if (Number(stat.size) > MAX_WORKSPACE_FILE_BYTES) {
        return yield* fail({
          code: "unreadable",
          message: `The workspace file ${filePath} is too large to be a workspace file.`,
        });
      }
      const text = yield* fileSystem.readFileString(filePath).pipe(Effect.catch(unreadable));
      const folders = parseWorkspaceFile({ text, filePath, platform });
      if (Result.isFailure(folders)) {
        return yield* new WorkspaceFileReadError({ diagnostic: folders.failure });
      }
      return { filePath, folders: folders.success };
    },
  );

  const closeWatch = (projectId: ProjectId) =>
    Effect.suspend(() => {
      const existing = watches.get(projectId);
      if (existing === undefined) return Effect.void;
      watches.delete(projectId);
      return Scope.close(existing.scope, Exit.void);
    });

  // The parent directory is watched, without recursion, so a file replaced by
  // a save or recreated after a delete is still seen. Registration can't be
  // interrupted halfway, so no watch outlives its place in `watches`.
  const watch: WorkspaceFiles["Service"]["watch"] = (projectId, filePath, onHint) =>
    watchLock.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* closeWatch(projectId);
          const scope = yield* Scope.fork(layerScope, "sequential");
          const directory = path.dirname(filePath);
          // Case-insensitive everywhere: a stray match costs one small read,
          // a missed one on a case-insensitive disk costs every change.
          const name = path.basename(filePath).toLowerCase();
          // One slot, full once the file changed since the last hint.
          const changed = yield* Queue.dropping<void>(1);
          const noteChange = () => {
            Queue.offerUnsafe(changed, undefined);
          };
          const watched = yield* watchDirectory(
            directory,
            false,
            (_event, entry) => {
              if (entry.toLowerCase() === name) noteChange();
            },
            noteChange,
          ).pipe(Scope.provide(scope), Effect.result);
          if (Result.isFailure(watched)) {
            yield* Scope.close(scope, Exit.void);
            yield* Effect.logWarning("Can't watch a workspace file; changes apply on Refresh", {
              projectId,
              filePath,
              code: watched.failure.code,
            });
            return false;
          }
          const closed = watched.success;
          // Waits until changes stop for the debounce, so one save is one read.
          const settle: Effect.Effect<void> = Effect.sleep(WATCH_DEBOUNCE).pipe(
            Effect.andThen(Queue.clear(changed)),
            Effect.flatMap((seen) => (seen.length > 0 ? settle : Effect.void)),
          );
          // Some platforms report nothing more once the directory is gone, so a
          // watch whose directory went away counts as stopped.
          const checkDirectory = fileSystem.exists(directory).pipe(
            Effect.orElseSucceed(() => false),
            Effect.flatMap((exists) =>
              exists ? Effect.void : Deferred.succeed(closed, undefined),
            ),
          );
          yield* Effect.forever(
            Queue.take(changed).pipe(
              Effect.andThen(settle),
              Effect.andThen(checkDirectory),
              Effect.andThen(onHint),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterrupts(cause),
                (cause) =>
                  Effect.logWarning("Workspace file change failed to apply", { projectId, cause }),
              ),
            ),
          ).pipe(Effect.forkIn(scope));
          // A watch that stops hints once more, so its file's state is read.
          yield* Deferred.await(closed).pipe(
            Effect.andThen(Queue.offer(changed, undefined)),
            Effect.forkIn(scope),
          );
          watches.set(projectId, { scope, filePath, closed });
          return true;
        }),
      ),
    );

  const unwatch: WorkspaceFiles["Service"]["unwatch"] = (projectId) =>
    watchLock.withPermit(closeWatch(projectId));

  const isWatching: WorkspaceFiles["Service"]["isWatching"] = (projectId, filePath) =>
    Effect.suspend(() => {
      const existing = watches.get(projectId);
      return existing === undefined || existing.filePath !== filePath
        ? Effect.succeed(false)
        : Deferred.isDone(existing.closed).pipe(Effect.map((closed) => !closed));
    });

  return WorkspaceFiles.of({ read, resolveProjectPath, watch, unwatch, isWatching });
});

export const layer = Layer.effect(WorkspaceFiles, make);
