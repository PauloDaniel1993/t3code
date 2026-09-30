// @effect-diagnostics nodeBuiltinImport:off - native realpath reports stored casing on Windows.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

/** A case alias must not authorize bytes stored under a different attachment ID. */
export const hasExactAttachmentFileName = Effect.fnUntraced(function* (filePath: string) {
  const path = yield* Path.Path;
  // Compare only the filename: native realpath also expands Windows 8.3 directories.
  const actual = yield* Effect.tryPromise(() => NodeFSP.realpath(filePath)).pipe(
    Effect.orElseSucceed(() => null),
  );
  return actual !== null && path.basename(actual) === path.basename(filePath);
});
