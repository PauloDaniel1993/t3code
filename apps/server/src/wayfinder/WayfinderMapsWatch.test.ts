import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WayfinderMaps from "./WayfinderMaps.ts";
import type { WayfinderMapsSnapshot } from "./WayfinderMarkdown.ts";

const workspace = Layer.merge(
  NodeServices.layer,
  WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer)),
);
const quickTuning = Layer.succeed(WayfinderMaps.WayfinderMapsTuning, {
  minScanInterval: Duration.zero,
  watchDebounce: Duration.millis(5),
});
const TestLayer = Layer.merge(
  workspace,
  WayfinderMaps.layer.pipe(Layer.provide(workspace), Layer.provide(quickTuning)),
);

const mapMarkdown = (title: string) =>
  ["---", `title: ${title}`, "destination: Watching.", "---", `# ${title}`].join("\n");

const ticketMarkdown = (title: string, answer?: string) =>
  [
    "---",
    "type: task",
    "blocked_by: []",
    "---",
    `# ${title}`,
    ...(answer ? ["", "## Answer", "", answer] : []),
  ].join("\n");

const writeText = Effect.fn("writeText")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

/**
 * Subscribes and takes the first snapshot. The watches are live before that snapshot's scan,
 * and arming them scans nothing more, so whatever arrives next came from a watch event.
 */
const subscribe = Effect.fn("subscribe")(function* (cwd: string) {
  const maps = yield* WayfinderMaps.WayfinderMaps;
  const snapshots = yield* Queue.unbounded<WayfinderMapsSnapshot>();
  yield* maps.stream(cwd).pipe(
    Stream.runForEach((snapshot) => Queue.offer(snapshots, snapshot)),
    Effect.forkScoped,
  );
  const initial = yield* Queue.take(snapshots);
  return { snapshots, initial };
});

describe("isWayfinderMapChange", () => {
  it.each([
    ["rename", "wayfinder-map.md", true],
    ["change", "WAYFINDER-MAP.MD", true],
    ["change", ".scratch/eff/map.md", true],
    ["change", ".scratch\\eff\\issues\\01-a.md", true],
    ["change", ".plan/maps/deep/tickets/02-b.MD", true],
    ["change", ".plan/tickets/01-root.md", true],
    ["rename", ".scratch/eff", true],
    ["rename", ".plan/eff/tickets", true],
    ["rename", ".plan", true],
    // A folder's own `change` is the timestamp of a file written inside it.
    ["change", ".scratch/noise", false],
    ["change", ".scratch", false],
    ["change", ".scratch/noise/output.txt", false],
    ["rename", ".scratch/eff/notes.md", false],
    ["change", ".scratch/eff/issues/old/01-a.md", false],
    ["change", ".scratch/eff/issues/01-a.txt", false],
    ["change", "src/wayfinder-map.md", false],
    ["rename", "node_modules", false],
  ] as const)("%s %s counts: %s", (event, relativePath, expected) => {
    expect(WayfinderMaps.isWayfinderMapChange(event, relativePath)).toBe(expected);
  });
});

it.layer(TestLayer, { excludeTestServices: true })("WayfinderMaps watching", (it) => {
  const makeProject = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-wayfinder-watch-" });
    yield* writeText(cwd, ".scratch/eff/map.md", mapMarkdown("Scratch effort"));
    yield* writeText(cwd, ".scratch/eff/issues/01-a.md", ticketMarkdown("A"));
    yield* writeText(cwd, ".plan/maps/deep/map.md", mapMarkdown("Plan effort"));
    yield* writeText(cwd, ".plan/maps/deep/tickets/01-b.md", ticketMarkdown("B"));
    return cwd;
  });

  it.effect("publishes a change to a ticket file in a nested .scratch directory", () =>
    Effect.gen(function* () {
      const cwd = yield* makeProject;
      const { snapshots, initial } = yield* subscribe(cwd);
      expect(initial.maps.flatMap((map) => map.nodes.map((node) => node.status))).not.toContain(
        "resolved",
      );

      yield* writeText(cwd, ".scratch/eff/issues/01-a.md", ticketMarkdown("A", "Done."));
      const changed = yield* Queue.take(snapshots);

      expect(
        changed.maps.find((map) => map.id === "scratch/eff")?.nodes.map((node) => node.status),
      ).toEqual(["resolved"]);
    }),
  );

  it.effect("publishes a new ticket file created two levels below .plan", () =>
    Effect.gen(function* () {
      const cwd = yield* makeProject;
      const { snapshots } = yield* subscribe(cwd);

      yield* writeText(cwd, ".plan/maps/deep/tickets/02-new.md", ticketMarkdown("New"));
      const changed = yield* Queue.take(snapshots);

      expect(
        changed.maps.find((map) => map.id === "maps/deep")?.nodes.map((node) => node.relativePath),
      ).toEqual([".plan/maps/deep/tickets/01-b.md", ".plan/maps/deep/tickets/02-new.md"]);
    }),
  );

  it.effect("still publishes a map change made among many unrelated writes", () =>
    Effect.gen(function* () {
      const cwd = yield* makeProject;
      yield* writeText(cwd, ".scratch/noise/000.txt", "x");
      const { snapshots } = yield* subscribe(cwd);

      yield* Effect.forEach(
        Array.from({ length: 300 }, (_, index) => index),
        (index) => writeText(cwd, `.scratch/noise/${String(index).padStart(3, "0")}.txt`, "y"),
        { concurrency: 16, discard: true },
      );
      yield* writeText(cwd, ".scratch/eff/issues/01-a.md", ticketMarkdown("A", "Done."));
      const changed = yield* Queue.take(snapshots);

      expect(
        changed.maps.find((map) => map.id === "scratch/eff")?.nodes.map((node) => node.status),
      ).toEqual(["resolved"]);
    }),
  );

  it.effect("publishes a change to the root map file", () =>
    Effect.gen(function* () {
      const cwd = yield* makeProject;
      yield* writeText(cwd, "wayfinder-map.md", mapMarkdown("Root before"));
      const { snapshots, initial } = yield* subscribe(cwd);
      expect(initial.maps.find((map) => map.id === "wayfinder-map")?.title).toBe("Root before");

      yield* writeText(cwd, "wayfinder-map.md", mapMarkdown("Root after"));
      const changed = yield* Queue.take(snapshots);

      expect(changed.maps.find((map) => map.id === "wayfinder-map")?.title).toBe("Root after");
    }),
  );

  it.effect(
    "publishes a change to a root map whose name discovery matched in another case",
    (context) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-wayfinder-case-" });
        yield* writeText(cwd, "WAYFINDER-MAP.MD", mapMarkdown("Upper before"));
        // Discovery reads `wayfinder-map.md`; only a case-insensitive file system finds this one.
        if (!(yield* fileSystem.exists(path.join(cwd, "wayfinder-map.md")).pipe(Effect.orDie))) {
          return context.skip("the file system is case-sensitive, so discovery does not read it");
        }
        const { snapshots, initial } = yield* subscribe(cwd);
        expect(initial.maps.map((map) => map.title)).toEqual(["Upper before"]);

        yield* writeText(cwd, "WAYFINDER-MAP.MD", mapMarkdown("Upper after"));
        const changed = yield* Queue.take(snapshots);

        expect(changed.maps.map((map) => map.title)).toEqual(["Upper after"]);
      }),
  );
});
