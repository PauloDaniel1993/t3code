import type { OrchestrationV2CheckpointScopePart } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { CheckpointStore, DiffCheckpointsInput } from "./CheckpointStore.ts";

export const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;

/** Each file belongs to its deepest folder, with nested checkouts excluded too. */
export function checkpointFolderDiffs(part: OrchestrationV2CheckpointScopePart) {
  return part.folders.map((folder) => ({
    folder,
    relativePath: folder.relativePath,
    srcPrefix: `a/${folder.label}/`,
    dstPrefix: `b/${folder.label}/`,
    pathspecs: [
      folder.relativePath === "" ? "." : `:(literal)${folder.relativePath}`,
      ...part.pathspecs.filter((pathspec) => pathspec.startsWith(":(exclude,")),
      ...part.folders.flatMap((other) =>
        other.relativePath !== folder.relativePath &&
        (folder.relativePath === "" || other.relativePath.startsWith(`${folder.relativePath}/`))
          ? [`:(exclude,literal)${other.relativePath}`]
          : [],
      ),
    ],
  }));
}

/** Spend one output budget in folder order instead of giving every git call 10 MB. */
export function collectCheckpointDiffs(
  inputs: ReadonlyArray<DiffCheckpointsInput & { readonly label?: string }>,
  diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"],
) {
  return Effect.gen(function* () {
    let remainingBytes = CHECKPOINT_DIFF_MAX_OUTPUT_BYTES;
    const diffs: Array<{ readonly label: string | undefined; readonly diff: string }> = [];
    for (const input of inputs) {
      if (remainingBytes <= 0) break;
      const diff = yield* diffCheckpoints({ ...input, maxOutputBytes: remainingBytes });
      remainingBytes -= Buffer.byteLength(diff, "utf8");
      diffs.push({ label: input.label, diff });
    }
    return diffs;
  });
}
