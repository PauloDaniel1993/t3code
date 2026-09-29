// @effect-diagnostics nodeBuiltinImport:off - links can only be created through the native fs.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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

  it.effect("keeps a directory link that stays inside the project", () =>
    Effect.gen(function* () {
      const { path, project } = yield* makeSandbox;
      yield* writeText(path.join(project, "shared", "map.md"), mapMarkdown("Shared"));
      yield* writeText(path.join(project, "shared", "issues", "01-a.md"), ticketMarkdown("A"));
      yield* writeText(path.join(project, ".scratch", "keep.txt"), "x");
      expect(
        yield* tryLink(
          path.join(project, "shared"),
          path.join(project, ".scratch", "alias"),
          directoryLinkType,
        ),
      ).toBe(true);

      const snapshot = yield* snapshotOf(project);

      expect(snapshot.maps.map((map) => map.id)).toEqual(["scratch/alias"]);
      expect(snapshot.maps[0]?.nodes.map((node) => node.relativePath)).toEqual([
        ".scratch/alias/issues/01-a.md",
      ]);
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
});
