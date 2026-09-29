// @effect-diagnostics nodeBuiltinImport:off - bounded directory enumeration needs `opendir`, which FileSystem does not expose.
import * as NodeFSP from "node:fs/promises";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import type { WayfinderMarkdownFile } from "./WayfinderMarkdown.ts";

class WayfinderDirectoryReadError extends Data.TaggedError("WayfinderDirectoryReadError")<{
  readonly code: string | undefined;
}> {}

export interface WayfinderDirectoryListing {
  readonly entries: ReadonlyArray<string>;
  /** The directory held more entries than the caller's budget; the rest were not read. */
  readonly truncated: boolean;
}

export interface WayfinderFiles {
  /**
   * Real path of an existing directory inside the project, or null when it is absent or
   * resolves outside the root. The watchers use this so they never follow a link out.
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
 * Every file and directory the Wayfinder reader touches goes through here. A path is only
 * usable when its real location (symlinks and Windows junctions resolved) is inside the real
 * project root; anything else reads as absent and is logged. The lexical check in
 * `WorkspacePaths` alone would let `.scratch/effort` be a junction to another folder.
 *
 * A link swapped in between the check and the open cannot be ruled out without `openat`, so a
 * file read is also re-verified after the open: the path must still resolve to the same place
 * and to the file the handle points at.
 */
export const makeWayfinderFiles = Effect.fn("WayfinderFiles.make")(function* (
  workspaceRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

  const realRoot = yield* fileSystem.realPath(workspaceRoot).pipe(
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

  const logProbeFailure = (operation: string, relativePath: string, cause: PlatformError) =>
    Effect.logWarning("Wayfinder filesystem probe failed", {
      operation,
      relativePath,
      reason: cause.reason._tag,
    });

  const isInsideRealRoot = (realPath: string) => {
    const relative = path.relative(realRoot, realPath);
    return !(
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    );
  };

  /** Lexical relative path plus the contained real path, or null when absent or escaping. */
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
          : (quiet ? Effect.void : logProbeFailure("real-path", target.relativePath, cause)).pipe(
              Effect.as(Option.none<string>()),
            ),
      ),
    );
    if (Option.isNone(realPath)) {
      return null;
    }
    if (!isInsideRealRoot(realPath.value)) {
      if (!quiet) {
        yield* Effect.logWarning("Wayfinder refused a path that resolves outside the project", {
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
          : logProbeFailure("stat", target.relativePath, cause)
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
      return yield* Effect.tryPromise({
        try: async (): Promise<WayfinderDirectoryListing> => {
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
        },
        catch: (cause) =>
          new WayfinderDirectoryReadError({ code: (cause as NodeJS.ErrnoException).code }),
      }).pipe(
        Effect.catch((cause) =>
          (cause.code === "ENOENT" || cause.code === "ENOTDIR"
            ? Effect.void
            : Effect.logWarning("Wayfinder filesystem probe failed", {
                operation: "read-directory",
                relativePath: target.relativePath,
                reason: cause.code ?? "unknown",
              })
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
            : logProbeFailure("stat", target.relativePath, cause)
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
      const attempt = Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(target.absolutePath, { flag: "r" });
          const info = yield* file.stat;
          if (info.type !== "File") {
            return null;
          }
          // Re-verify after the open: the path must still lead to the file we hold.
          const [stillThere, onDisk] = yield* Effect.all([
            contain(relativePath, true),
            fileSystem.stat(target.absolutePath),
          ]);
          if (
            stillThere?.absolutePath !== target.absolutePath ||
            onDisk.dev !== info.dev ||
            Option.getOrUndefined(onDisk.ino) !== Option.getOrUndefined(info.ino)
          ) {
            yield* Effect.logWarning("Wayfinder refused a file that changed while it was opened", {
              relativePath: target.relativePath,
            });
            return null;
          }
          const truncated = info.size > BigInt(byteLimit);
          const bytesToRead = truncated ? byteLimit : Number(info.size);
          if (bytesToRead === 0) {
            return {
              relativePath: target.relativePath,
              contents: "",
              truncated: false,
            } satisfies WayfinderMarkdownFile;
          }
          const buffer = new Uint8Array(bytesToRead);
          const bytesRead = Number(yield* file.read(buffer));
          return {
            relativePath: target.relativePath,
            contents: new TextDecoder("utf-8").decode(buffer.subarray(0, bytesRead)),
            truncated,
          } satisfies WayfinderMarkdownFile;
        }),
      );
      return yield* attempt.pipe(
        Effect.catchTag("PlatformError", (cause) =>
          (cause.reason._tag === "NotFound"
            ? Effect.void
            : logProbeFailure("bounded-read", target.relativePath, cause)
          ).pipe(Effect.as<WayfinderMarkdownFile | null>(null)),
        ),
      );
    },
  );

  return { resolveDirectory, listDirectory, isFile, readBounded } satisfies WayfinderFiles;
});
