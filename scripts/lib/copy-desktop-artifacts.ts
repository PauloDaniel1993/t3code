// @effect-diagnostics nodeBuiltinImport:off - Node's verbatimSymlinks option preserves macOS framework links after staging is removed.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class DesktopArtifactCopyError extends Schema.TaggedError<DesktopArtifactCopyError>()(
  "DesktopArtifactCopyError",
  {
    source: Schema.String,
    destination: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Unpacked dir targets must survive the artifact builder's temporary staging cleanup. */
export const copyDesktopArtifacts = Effect.fn("copyDesktopArtifacts")(function* (input: {
  readonly stageDistDir: string;
  readonly outputDir: string;
  readonly target: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(input.stageDistDir);
  yield* fs.makeDirectory(input.outputDir, { recursive: true });
  const copiedArtifacts: string[] = [];
  let copiedDirectory = false;
  for (const entry of entries) {
    const source = path.join(input.stageDistDir, entry);
    const destination = path.join(input.outputDir, entry);
    const stat = yield* fs.stat(source);
    if (stat.type === "Directory" && input.target === "dir") {
      yield* fs.remove(destination, { recursive: true, force: true });
      yield* Effect.tryPromise({
        try: () => NodeFSP.cp(source, destination, { recursive: true, verbatimSymlinks: true }),
        catch: (cause) => new DesktopArtifactCopyError({ source, destination, cause }),
      });
      copiedDirectory = true;
    } else if (stat.type === "File") {
      yield* fs.copyFile(source, destination);
    } else {
      continue;
    }
    copiedArtifacts.push(destination);
  }
  return { copiedArtifacts, copiedDirectory };
});
