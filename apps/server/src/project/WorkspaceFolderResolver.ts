import type { WorkspaceFolderUnavailableReason } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";

/** The git checkout a folder belongs to. */
export interface WorkspaceFolderCheckout {
  /** Realpath of `git rev-parse --show-toplevel`. */
  readonly checkoutRoot: string;
  /** The folder below `checkoutRoot`, `/`-separated with no trailing slash; empty at the root. */
  readonly checkoutPrefix: string;
  /** Realpath of the git directory every checkout of the repository shares. */
  readonly commonDir: string;
}

/** What one probe found at a workspace folder's path. */
export interface WorkspaceFolderProbe {
  readonly path: string;
  readonly availability: "available" | "unavailable";
  readonly unavailableReason?: Exclude<WorkspaceFolderUnavailableReason, "remote">;
  /** Absent unless git was asked about an available folder; null outside git. */
  readonly vcs?: WorkspaceFolderCheckout | null;
}

export class WorkspaceFolderResolver extends Context.Service<
  WorkspaceFolderResolver,
  {
    /**
     * Stat a folder, and with `vcs` ask git which checkout holds it. Never
     * fails: a folder that can't be read is unavailable, and one git can't
     * answer for is outside git.
     */
    readonly probe: (
      path: string,
      options: { readonly vcs: boolean },
    ) => Effect.Effect<WorkspaceFolderProbe>;
  }
>()("t3/project/WorkspaceFolderResolver") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const realPath = (location: string) =>
    fileSystem.realPath(location).pipe(Effect.orElseSucceed(() => path.resolve(location)));

  const checkout = Effect.fn("WorkspaceFolderResolver.checkout")(function* (folderPath: string) {
    const result = yield* processRunner
      .run({
        command: "git",
        args: [
          "-C",
          folderPath,
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--git-common-dir",
          "--show-prefix",
        ],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (result._tag === "None" || result.value.code !== 0) return null;
    const [topLevel = "", commonDir = "", prefix = ""] = result.value.stdout.split(/\r?\n/);
    // Lines are taken verbatim: a folder name may start or end with a space.
    if (topLevel === "" || commonDir === "") return null;
    return {
      checkoutRoot: yield* realPath(topLevel),
      checkoutPrefix: prefix.replace(/\/+$/, ""),
      commonDir: yield* realPath(commonDir),
    } satisfies WorkspaceFolderCheckout;
  });

  const probe: WorkspaceFolderResolver["Service"]["probe"] = Effect.fn(
    "WorkspaceFolderResolver.probe",
  )(function* (folderPath, options) {
    const stat = yield* Effect.result(fileSystem.stat(folderPath));
    if (stat._tag === "Failure") {
      return {
        path: folderPath,
        availability: "unavailable",
        unavailableReason: stat.failure.reason._tag === "NotFound" ? "missing" : "inaccessible",
      } satisfies WorkspaceFolderProbe;
    }
    if (stat.success.type !== "Directory") {
      return { path: folderPath, availability: "unavailable", unavailableReason: "not-directory" };
    }
    return {
      path: folderPath,
      availability: "available",
      ...(options.vcs ? { vcs: yield* checkout(folderPath) } : {}),
    } satisfies WorkspaceFolderProbe;
  });

  return WorkspaceFolderResolver.of({ probe });
});

export const layer = Layer.effect(WorkspaceFolderResolver, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
