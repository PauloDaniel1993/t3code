import type { OrchestrationV2CheckpointScopePart } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { CheckpointStore, DiffCheckpointsInput } from "./CheckpointStore.ts";
import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES } from "../vcs/VcsDriver.ts";

/** Each file belongs to its deepest folder, with nested checkouts excluded too. */
export function checkpointFolderDiffs(part: OrchestrationV2CheckpointScopePart) {
  // Different snapshot paths can alias the same checkout prefix. The first
  // folder in snapshot order owns it, just as workspace-file duplicates do.
  const seen = new Set<string>();
  const folders = part.folders.filter((folder) => {
    if (seen.has(folder.relativePath)) return false;
    seen.add(folder.relativePath);
    return true;
  });
  return folders.map((folder) => ({
    folder,
    relativePath: folder.relativePath,
    srcPrefix: `a/${folder.label}/`,
    dstPrefix: `b/${folder.label}/`,
    pathspecs: [
      folder.relativePath === "" ? "." : `:(literal)${folder.relativePath}`,
      ...part.pathspecs.filter((pathspec) => pathspec.startsWith(":(exclude,")),
      ...folders.flatMap((other) =>
        other.relativePath !== folder.relativePath &&
        (folder.relativePath === "" || other.relativePath.startsWith(`${folder.relativePath}/`))
          ? [`:(exclude,literal)${other.relativePath}`]
          : [],
      ),
    ],
  }));
}

/** Spend one output budget in folder order instead of giving every git call 10 MB. */
export const collectCheckpointDiffs = Effect.fn("CheckpointFolderDiffs.collectCheckpointDiffs")(
  function* (
    inputs: ReadonlyArray<DiffCheckpointsInput & { readonly label?: string }>,
    diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"],
    maxOutputBytes = CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
  ) {
    const budget = Math.min(maxOutputBytes, CHECKPOINT_DIFF_MAX_OUTPUT_BYTES);
    let remainingBytes = budget;
    const diffs: Array<{ readonly label: string | undefined; diff: string }> = [];
    for (const input of inputs) {
      const { label, ...diffInput } = input;
      // One extra byte distinguishes an exact fit from truncated output, even across folders.
      const output = yield* diffCheckpoints({ ...diffInput, maxOutputBytes: remainingBytes + 1 });
      const outputBytes = Buffer.byteLength(output, "utf8");
      diffs.push({ label, diff: output });
      if (outputBytes > remainingBytes) {
        const marker = "\n\n[truncated]";
        let available = Math.max(0, budget - Buffer.byteLength(marker));
        for (const entry of diffs) {
          const bytes = Buffer.byteLength(entry.diff);
          entry.diff = new TextDecoder().decode(Buffer.from(entry.diff).subarray(0, available), {
            stream: true,
          });
          available = Math.max(0, available - bytes);
        }
        diffs[diffs.length - 1]!.diff += marker;
        break;
      }
      remainingBytes -= outputBytes;
    }
    return diffs;
  },
);
