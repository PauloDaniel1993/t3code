import type { OrchestrationV2CheckpointScopePart } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { CheckpointStore, DiffCheckpointsInput } from "./CheckpointStore.ts";
import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES } from "../vcs/VcsDriver.ts";

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
      const { label, ...diffInput } = input;
      const output = yield* diffCheckpoints({ ...diffInput, maxOutputBytes: remainingBytes });
      const outputBytes = Buffer.byteLength(output, "utf8");
      // A git byte cap can split UTF-8; decoding its replacement character may
      // grow the returned string. Keep the encoded result inside the budget too.
      const diff =
        outputBytes > remainingBytes
          ? new TextDecoder().decode(Buffer.from(output).subarray(0, remainingBytes), {
              stream: true,
            })
          : output;
      remainingBytes -= Math.min(outputBytes, remainingBytes);
      diffs.push({ label, diff });
    }
    return diffs;
  });
}
