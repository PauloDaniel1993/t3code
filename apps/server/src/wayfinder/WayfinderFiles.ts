// @effect-diagnostics nodeBuiltinImport:off - FileSystem exposes no `opendir`, no descriptor and no raw watch callback; this reader needs all three.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import type { WayfinderMarkdownFile } from "./WayfinderMarkdown.ts";

class WayfinderNodeFileError extends Data.TaggedError("WayfinderNodeFileError")<{
  readonly code: string | undefined;
}> {}

const nodeCall = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new WayfinderNodeFileError({ code: (cause as NodeJS.ErrnoException).code }),
  });

const isAbsent = (code: string | undefined) => code === "ENOENT" || code === "ENOTDIR";

export interface WayfinderDirectoryListing {
  readonly entries: ReadonlyArray<string>;
  /** The directory held more entries than the caller's budget; the rest were not read. */
  readonly truncated: boolean;
}

export interface WayfinderFiles {
  /**
   * Real path of an existing directory inside the project, or null when it is absent or
   * reached through a link. The watchers use this so they never follow a link.
   */
  readonly resolveDirectory: (
    relativePath: string,
    options?: { readonly quiet?: boolean },
  ) => Effect.Effect<string | null, WorkspacePaths.WorkspacePathOutsideRootError>;
  readonly listDirectory: (
    relativePath: string,
    entryBudget: number,
  ) => Effect.Effect<WayfinderDirectoryListing, WorkspacePaths.WorkspacePathOutsideRootError>;
  readonly isFile: (
    relativePath: string,
  ) => Effect.Effect<boolean, WorkspacePaths.WorkspacePathOutsideRootError>;
  readonly readBounded: (
    relativePath: string,
    byteLimit: number,
  ) => Effect.Effect<WayfinderMarkdownFile | null, WorkspacePaths.WorkspacePathOutsideRootError>;
}

/**
 * The canonical path of an existing directory: links resolved, and on Windows the on-disk
 * letter case. Two spellings of one folder give one string, so it can key per-root state.
 */
export const resolveRealRoot = (workspaceRoot: string) =>
  nodeCall(() => NodeFSP.realpath(workspaceRoot)).pipe(
    Effect.mapError(
      (cause) =>
        new WorkspacePaths.WorkspaceRootStatFailedError({
          workspaceRoot,
          normalizedWorkspaceRoot: workspaceRoot,
          phase: "validate-existing",
          cause,
        }),
    ),
  );

/**
 * Watches a directory and hands each changed name, relative to it, to `onChange`. Nothing
 * else runs per event (`FileSystem.watch` stats every renamed path and queues every event),
 * so the caller's filter is the whole cost of an unrelated change. The returned deferred
 * completes when the watch closes or fails; closing the scope stops the watch.
 */
export const watchDirectory = (
  directory: string,
  recursive: boolean,
  onChange: (event: "rename" | "change", name: string) => void,
) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const closed = Deferred.makeUnsafe<void>();
        const watcher = NodeFS.watch(directory, { recursive }, (event, name) => {
          if (name) onChange(event, name);
        });
        const markClosed = () => Deferred.doneUnsafe(closed, Effect.void);
        watcher.on("error", markClosed);
        watcher.on("close", markClosed);
        return { watcher, closed };
      },
      catch: (cause) => new WayfinderNodeFileError({ code: (cause as NodeJS.ErrnoException).code }),
    }),
    ({ watcher }) => Effect.sync(() => watcher.close()),
  ).pipe(Effect.map(({ closed }) => closed));

/**
 * Every file and directory the Wayfinder reader touches goes through here. A path is only
 * usable when its real location (symlinks and Windows junctions resolved) is the path itself
 * under the real project root, ignoring letter case: nothing is read through a link, even one
 * that stays inside the project, because the watches do not follow links and a map read
 * through one would go stale. Anything else reads exactly as a missing file does and is logged
 * on the server only, so a client cannot learn whether something exists outside the project.
 *
 * What a file read guarantees:
 * - A link that exists while the file is read, or one swapped in once between the check and
 *   the open, is never followed.
 * - On Linux the check is made on the open descriptor, so the bytes read come from the file
 *   that was checked, whatever happens to the path.
 * - Windows and macOS have no Node call that names an open handle. There the path is
 *   resolved again after the open and must still name the same file. A process that renames
 *   a folder inside the project away, back and away again within one read can still have an
 *   outside file read. That process can already write into the project, so it could as well
 *   copy in any outside file it can read.
 * - A hard link is a file inside the project and is read.
 *
 * Directory listings and watches resolve the path and then open it, without a second check.
 * A swap there exposes nothing: a listing only supplies names that are read through the
 * check above, and a watch event only asks for a rescan.
 */
export const makeWayfinderFiles = Effect.fn("WayfinderFiles.make")(function* (
  workspaceRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const platform = yield* HostProcessPlatform;

  const realRoot = yield* resolveRealRoot(workspaceRoot);

  const logProbeFailure = (operation: string, relativePath: string, reason: string) =>
    Effect.logWarning("Wayfinder filesystem probe failed", { operation, relativePath, reason });
  const logPlatformFailure = (operation: string, relativePath: string, cause: PlatformError) =>
    logProbeFailure(operation, relativePath, cause.reason._tag);

  /** Lexical relative path plus its real path, or null when absent or reached by a link. */
  const contain = Effect.fn("WayfinderFiles.contain")(function* (
    relativePath: string,
    quiet: boolean,
  ) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot,
      relativePath,
    });
    const realPath = yield* fileSystem.realPath(target.absolutePath).pipe(
      Effect.asSome,
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : (quiet
              ? Effect.void
              : logPlatformFailure("real-path", target.relativePath, cause)
            ).pipe(Effect.as(Option.none<string>())),
      ),
    );
    if (Option.isNone(realPath)) {
      return null;
    }
    // Lower case on both sides: discovery's fixed names match any case the disk uses.
    if (realPath.value.toLowerCase() !== path.join(realRoot, target.relativePath).toLowerCase()) {
      if (!quiet) {
        yield* Effect.logWarning("Wayfinder refused a path that goes through a link", {
          relativePath: target.relativePath,
        });
      }
      return null;
    }
    return { absolutePath: realPath.value, relativePath: target.relativePath };
  });

  const resolveDirectory: WayfinderFiles["resolveDirectory"] = Effect.fn(
    "WayfinderFiles.resolveDirectory",
  )(function* (relativePath, options) {
    const target = yield* contain(relativePath, options?.quiet ?? false);
    if (!target) {
      return null;
    }
    return yield* fileSystem.stat(target.absolutePath).pipe(
      Effect.map((info) => (info.type === "Directory" ? target.absolutePath : null)),
      Effect.catch((cause) =>
        (cause.reason._tag === "NotFound"
          ? Effect.void
          : logPlatformFailure("stat", target.relativePath, cause)
        ).pipe(Effect.as(null)),
      ),
    );
  });

  const listDirectory: WayfinderFiles["listDirectory"] = Effect.fn("WayfinderFiles.listDirectory")(
    function* (relativePath, entryBudget) {
      const target = yield* contain(relativePath, false);
      const empty: WayfinderDirectoryListing = { entries: [], truncated: false };
      if (!target) {
        return empty;
      }
      // `opendir` streams entries in small batches, so a huge directory is never fully
      // materialised; `readDirectory` would fetch every name before any budget applies.
      return yield* nodeCall(async (): Promise<WayfinderDirectoryListing> => {
        const directory = await NodeFSP.opendir(target.absolutePath);
        const entries: Array<string> = [];
        try {
          for await (const entry of directory) {
            if (entries.length >= entryBudget) {
              return { entries, truncated: true };
            }
            entries.push(entry.name);
          }
          return { entries, truncated: false };
        } finally {
          await directory.close().catch(() => undefined);
        }
      }).pipe(
        Effect.catch((cause) =>
          (isAbsent(cause.code)
            ? Effect.void
            : logProbeFailure("read-directory", target.relativePath, cause.code ?? "unknown")
          ).pipe(Effect.as(empty)),
        ),
      );
    },
  );

  const isFile: WayfinderFiles["isFile"] = Effect.fn("WayfinderFiles.isFile")(
    function* (relativePath) {
      const target = yield* contain(relativePath, false);
      if (!target) {
        return false;
      }
      return yield* fileSystem.stat(target.absolutePath).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.catch((cause) =>
          (cause.reason._tag === "NotFound"
            ? Effect.void
            : logPlatformFailure("stat", target.relativePath, cause)
          ).pipe(Effect.as(false)),
        ),
      );
    },
  );

  const readBounded: WayfinderFiles["readBounded"] = Effect.fn("WayfinderFiles.readBounded")(
    function* (relativePath, byteLimit) {
      const target = yield* contain(relativePath, false);
      if (!target) {
        return null;
      }
      // True when the open handle is the file that was checked; see the guarantees above.
      const heldInsideRoot = (handle: NodeFSP.FileHandle, held: NodeFS.BigIntStats) =>
        platform === "linux"
          ? nodeCall(() => NodeFSP.readlink(`/proc/self/fd/${handle.fd}`)).pipe(
              Effect.map((heldPath) => heldPath === target.absolutePath),
            )
          : Effect.gen(function* () {
              const again = yield* contain(relativePath, true);
              if (again?.absolutePath !== target.absolutePath) {
                return false;
              }
              const onDisk = yield* nodeCall(() =>
                NodeFSP.stat(target.absolutePath, { bigint: true }),
              );
              return onDisk.dev === held.dev && onDisk.ino === held.ino;
            });
      const attempt = Effect.gen(function* () {
        const handle = yield* Effect.acquireRelease(
          nodeCall(() => NodeFSP.open(target.absolutePath, "r")),
          (handle) => Effect.promise(() => handle.close().catch(() => undefined)),
        );
        const held = yield* nodeCall(() => handle.stat({ bigint: true }));
        if (!held.isFile()) {
          return null;
        }
        if (!(yield* heldInsideRoot(handle, held))) {
          yield* Effect.logWarning("Wayfinder refused a file that changed while it was opened", {
            relativePath: target.relativePath,
          });
          return null;
        }
        const truncated = held.size > BigInt(byteLimit);
        const buffer = new Uint8Array(truncated ? byteLimit : Number(held.size));
        const { bytesRead } = yield* nodeCall(() => handle.read(buffer, 0, buffer.length, 0));
        return {
          relativePath: target.relativePath,
          contents: new TextDecoder("utf-8").decode(buffer.subarray(0, bytesRead)),
          truncated,
        } satisfies WayfinderMarkdownFile;
      });
      return yield* attempt.pipe(
        Effect.scoped,
        Effect.catchTag("WayfinderNodeFileError", (cause) =>
          (isAbsent(cause.code)
            ? Effect.void
            : logProbeFailure("bounded-read", target.relativePath, cause.code ?? "unknown")
          ).pipe(Effect.as<WayfinderMarkdownFile | null>(null)),
        ),
      );
    },
  );

  return { resolveDirectory, listDirectory, isFile, readBounded } satisfies WayfinderFiles;
});
