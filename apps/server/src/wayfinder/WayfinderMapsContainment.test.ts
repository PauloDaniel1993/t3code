// @effect-diagnostics nodeBuiltinImport:off - links can only be created through the native fs.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { makeWayfinderFiles } from "./WayfinderFiles.ts";
import * as WayfinderMaps from "./WayfinderMaps.ts";

const WorkspaceLayer = Layer.merge(
  NodeServices.layer,
  WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer)),
);
const TestLayer = Layer.merge(
  WorkspaceLayer,
  WayfinderMaps.layer.pipe(Layer.provide(WorkspaceLayer)),
);

class LinkError extends Data.TaggedError("LinkError")<{
  readonly code: string | undefined;
  readonly cause: unknown;
}> {}

const SECRET = "OUTSIDE-SECRET-MARKER";

const mapMarkdown = (title: string) =>
  ["---", `title: ${title}`, "destination: Containment.", "---", `# ${title}`].join("\n");

const ticketMarkdown = (title: string) =>
  ["---", "type: task", "blocked_by: []", "---", `# ${title}`].join("\n");

/**
 * Creates a link, or reports why this machine cannot. Directory links are junctions on
 * Windows (no privilege needed); file symlinks there need Developer Mode or elevation.
 */
const tryLink = (target: string, linkPath: string, type: "file" | "dir" | "junction") =>
  Effect.tryPromise({
    try: () => NodeFSP.symlink(target, linkPath, type),
    catch: (cause) => new LinkError({ code: (cause as NodeJS.ErrnoException).code, cause }),
  }).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP"
        ? Effect.succeed(false)
        : Effect.die(error),
    ),
  );

/** Every string in the snapshot, so a leak anywhere in it shows up. */
const encodeText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const textOf = (snapshot: unknown) => encodeText(snapshot);

// Windows creates a junction, which needs no privilege; elsewhere the type is ignored and
// this is an ordinary directory symlink.
const directoryLinkType = "junction";

const writeText = Effect.fn("writeText")(function* (absolutePath: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

/** A project root plus a sibling folder that holds content the project must never expose. */
const makeSandbox = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-wayfinder-links-" });
  const project = path.join(base, "project");
  const outside = path.join(base, "outside");
  yield* fileSystem.makeDirectory(project, { recursive: true }).pipe(Effect.orDie);
  yield* writeText(path.join(outside, "map.md"), mapMarkdown(SECRET));
  yield* writeText(path.join(outside, "issues", "01-secret.md"), ticketMarkdown(SECRET));
  yield* writeText(path.join(outside, "tickets", "01-secret.md"), ticketMarkdown(SECRET));
  return { path, project, outside };
});

const snapshotOf = Effect.fn("snapshotOf")(function* (cwd: string) {
  const maps = yield* WayfinderMaps.WayfinderMaps;
  return yield* maps.stream(cwd).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
});

it.layer(TestLayer, { excludeTestServices: true })("WayfinderMaps containment", (it) => {
  it.effect("refuses a map folder that is a directory link to outside the project", () =>
    Effect.gen(function* () {
      const { path, project, outside } = yield* makeSandbox;
      yield* writeText(path.join(project, ".scratch", "own", "map.md"), mapMarkdown("Own map"));
      expect(
        yield* tryLink(outside, path.join(project, ".scratch", "escaped"), directoryLinkType),
      ).toBe(true);

      const snapshot = yield* snapshotOf(project);

      expect(snapshot.maps.map((map) => map.id)).toEqual(["scratch/own"]);
      expect(textOf(snapshot)).not.toContain(SECRET);
    }),
  );

  it.effect("refuses a ticket folder that is a directory link to outside the project", () =>
    Effect.gen(function* () {
      const { path, project, outside } = yield* makeSandbox;
      yield* writeText(path.join(project, ".scratch", "eff", "map.md"), mapMarkdown("Effort"));
      expect(
        yield* tryLink(
          path.join(outside, "issues"),
          path.join(project, ".scratch", "eff", "issues"),
          directoryLinkType,
        ),
      ).toBe(true);

      const snapshot = yield* snapshotOf(project);

      expect(snapshot.maps).toHaveLength(1);
      expect(snapshot.maps[0]?.nodes).toEqual([]);
      expect(textOf(snapshot)).not.toContain(SECRET);
    }),
  );

  it.effect("refuses a discovery root that is a directory link to outside the project", () =>
    Effect.gen(function* () {
      const { path, project, outside } = yield* makeSandbox;
      yield* writeText(path.join(outside, "effort", "map.md"), mapMarkdown(SECRET));
      expect(yield* tryLink(outside, path.join(project, ".plan"), directoryLinkType)).toBe(true);

      const snapshot = yield* snapshotOf(project);

      expect(snapshot.maps).toEqual([]);
      expect(textOf(snapshot)).not.toContain(SECRET);
    }),
  );

  // The watches do not follow links, so a map read through one would never update.
  it.effect("shows no map or ticket reached through a link, even one inside the project", () =>
    Effect.gen(function* () {
      const { path, project } = yield* makeSandbox;
      yield* writeText(path.join(project, "shared", "map.md"), mapMarkdown("Shared"));
      yield* writeText(path.join(project, "shared", "issues", "01-a.md"), ticketMarkdown("A"));
      yield* writeText(path.join(project, ".scratch", "own", "map.md"), mapMarkdown("Own"));
      for (const [target, link] of [
        ["shared", ".scratch/alias"],
        ["shared/issues", ".scratch/own/issues"],
      ] as const) {
        expect(
          yield* tryLink(path.join(project, target), path.join(project, link), directoryLinkType),
        ).toBe(true);
      }

      const snapshot = yield* snapshotOf(project);

      expect(snapshot.maps.map((map) => map.id)).toEqual(["scratch/own"]);
      expect(snapshot.maps[0]?.nodes).toEqual([]);
    }),
  );

  it.effect("refuses a ticket file that is a symlink to a file outside the project", (context) =>
    Effect.gen(function* () {
      const { path, project, outside } = yield* makeSandbox;
      yield* writeText(path.join(project, ".scratch", "eff", "map.md"), mapMarkdown("Effort"));
      yield* writeText(
        path.join(project, ".scratch", "eff", "issues", "02-own.md"),
        ticketMarkdown("Own"),
      );
      const linked = yield* tryLink(
        path.join(outside, "issues", "01-secret.md"),
        path.join(project, ".scratch", "eff", "issues", "01-linked.md"),
        "file",
      );
      if (!linked) {
        return context.skip(
          "this machine cannot create file symlinks (Windows needs Developer Mode or elevation)",
        );
      }

      const snapshot = yield* snapshotOf(project);

      expect(snapshot.maps[0]?.nodes.map((node) => node.relativePath)).toEqual([
        ".scratch/eff/issues/02-own.md",
      ]);
      expect(textOf(snapshot)).not.toContain(SECRET);
    }),
  );

  it.effect("refuses a map file that is a symlink to a file outside the project", (context) =>
    Effect.gen(function* () {
      const { path, project, outside } = yield* makeSandbox;
      yield* writeText(path.join(project, ".scratch", "eff", "placeholder.txt"), "x");
      const linked = yield* tryLink(
        path.join(outside, "map.md"),
        path.join(project, ".scratch", "eff", "map.md"),
        "file",
      );
      if (!linked) {
        return context.skip(
          "this machine cannot create file symlinks (Windows needs Developer Mode or elevation)",
        );
      }

      const snapshot = yield* snapshotOf(project);

      expect(snapshot.maps).toEqual([]);
      expect(textOf(snapshot)).not.toContain(SECRET);
    }),
  );

  it.effect("refuses a root map file that is a symlink to a file outside the project", (context) =>
    Effect.gen(function* () {
      const { path, project, outside } = yield* makeSandbox;
      const linked = yield* tryLink(
        path.join(outside, "map.md"),
        path.join(project, "wayfinder-map.md"),
        "file",
      );
      if (!linked) {
        return context.skip(
          "this machine cannot create file symlinks (Windows needs Developer Mode or elevation)",
        );
      }

      const snapshot = yield* snapshotOf(project);

      expect(snapshot.maps).toEqual([]);
      expect(textOf(snapshot)).not.toContain(SECRET);
    }),
  );

  it.effect("resolveDirectory, which the watchers use, refuses a link out of the project", () =>
    Effect.gen(function* () {
      const { path, project, outside } = yield* makeSandbox;
      yield* writeText(path.join(project, ".plan", "own", "map.md"), mapMarkdown("Own"));
      expect(yield* tryLink(outside, path.join(project, ".scratch"), directoryLinkType)).toBe(true);
      const files = yield* makeWayfinderFiles(project);

      expect(yield* files.resolveDirectory(".scratch", { quiet: true })).toBeNull();
      expect(yield* files.resolveDirectory(".plan", { quiet: true })).not.toBeNull();
    }),
  );
  it.effect(
    "answers the same for a link to an outside folder that exists and one that does not",
    () =>
      Effect.gen(function* () {
        const { path, project, outside } = yield* makeSandbox;
        const twin = path.join(path.dirname(project), "twin");
        for (const [root, target] of [
          [project, outside],
          [twin, path.join(path.dirname(project), "missing")],
        ] as const) {
          yield* writeText(path.join(root, ".scratch", "own", "map.md"), mapMarkdown("Own"));
          yield* writeText(path.join(root, ".scratch", "two", "map.md"), mapMarkdown("Two"));
          // A map folder and a ticket folder that lead out of the project.
          expect(
            yield* tryLink(target, path.join(root, ".scratch", "eff"), directoryLinkType),
          ).toBe(true);
          expect(
            yield* tryLink(
              path.join(target, "issues"),
              path.join(root, ".scratch", "two", "issues"),
              directoryLinkType,
            ),
          ).toBe(true);
        }

        expect(textOf(yield* snapshotOf(project))).toEqual(textOf(yield* snapshotOf(twin)));
      }),
  );

  describe("a folder swapped for a link while a file is read", () => {
    /**
     * `project/data` holds a safe map. `swapOut` parks it and puts a link to the outside
     * folder in its place; `restore` puts it back. The swaps run inside `realPath`, the
     * check, so they land exactly between the check and the open, and around the recheck.
     */
    const makeSwap = Effect.gen(function* () {
      const { path, project, outside } = yield* makeSandbox;
      const data = path.join(project, "data");
      const parked = path.join(project, "parked");
      yield* writeText(path.join(data, "map.md"), mapMarkdown("Safe"));
      let swapped = false;
      const swapOut = Effect.promise(async () => {
        if (swapped) return;
        await NodeFSP.rename(data, parked);
        await NodeFSP.symlink(outside, data, directoryLinkType);
        swapped = true;
      });
      const restore = Effect.promise(async () => {
        if (!swapped) return;
        await NodeFSP.unlink(data);
        await NodeFSP.rename(parked, data);
        swapped = false;
      });
      yield* Effect.addFinalizer(() => restore);
      return { project, target: path.join(data, "map.md"), swapOut, restore };
    });

    /** Files for `project` whose n-th `realPath` of `target` runs `around[n]`. */
    const filesWithSwaps = Effect.fn("filesWithSwaps")(function* (
      project: string,
      target: string,
      around: ReadonlyArray<{
        readonly before?: Effect.Effect<void>;
        readonly after?: Effect.Effect<void>;
      }>,
    ) {
      const fileSystem = yield* FileSystem.FileSystem;
      let calls = 0;
      const swapping = FileSystem.make({
        ...fileSystem,
        realPath: (path) => {
          if (path !== target) return fileSystem.realPath(path);
          const step = around[calls++];
          return (step?.before ?? Effect.void).pipe(
            Effect.andThen(fileSystem.realPath(path)),
            Effect.tap(() => step?.after ?? Effect.void),
          );
        },
      });
      return yield* makeWayfinderFiles(project).pipe(
        Effect.provideService(FileSystem.FileSystem, swapping),
      );
    });

    it.effect("refuses the outside file when the swap lands between the check and the open", () =>
      Effect.gen(function* () {
        const { project, target, swapOut } = yield* makeSwap;
        const files = yield* filesWithSwaps(project, target, [{ after: swapOut }]);

        expect(yield* files.readBounded("data/map.md", 65536)).toBeNull();
      }),
    );

    it.effect(
      "refuses the outside file when the path is put back for the recheck (Linux only)",
      (context) =>
        Effect.gen(function* () {
          // Only Linux lets Node name the file behind a descriptor; elsewhere this swap is
          // the documented limit in WayfinderFiles.ts.
          if (HostProcessPlatform.defaultValue() !== "linux") {
            return context.skip("needs /proc/self/fd, which only Linux has");
          }
          const { project, target, swapOut, restore } = yield* makeSwap;
          const files = yield* filesWithSwaps(project, target, [
            { after: swapOut },
            { before: restore, after: swapOut },
          ]);

          const read = yield* files.readBounded("data/map.md", 65536);

          expect(read).toBeNull();
        }),
    );
  });
});
