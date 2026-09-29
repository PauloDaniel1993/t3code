import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
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

interface ArmedWatch {
  readonly path: string;
  readonly recursive: boolean;
}

// The real file system, except that `watch` reports each watch once it exists. Native
// watches are taken through `toPull`, so an entry here means the OS watch is live and any
// later write must arrive as an event.
class ArmedWatches extends Context.Service<ArmedWatches, Queue.Queue<ArmedWatch>>()(
  "t3/wayfinder/WayfinderMapsWatch.test/ArmedWatches",
) {
  static readonly layer = Layer.effect(ArmedWatches, Queue.unbounded<ArmedWatch>());
}

const observedFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const armedWatches = yield* ArmedWatches;
    return FileSystem.make({
      ...fileSystem,
      watch: (path, options) =>
        Stream.scoped(
          Stream.fromPull(
            Effect.gen(function* () {
              const pull = yield* Stream.toPull(fileSystem.watch(path, options));
              yield* Queue.offer(armedWatches, { path, recursive: options?.recursive ?? false });
              return pull;
            }),
          ),
        ),
    });
  }),
);

const platform = Layer.provideMerge(
  observedFileSystem,
  Layer.merge(NodeServices.layer, ArmedWatches.layer),
);
const workspace = Layer.merge(platform, WorkspacePaths.layer.pipe(Layer.provide(platform)));
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
 * Subscribes, waits for the first snapshot and for the three watchers to be live, then lets
 * every scan they triggered on arming finish. What arrives after that can only have come from
 * a watch event.
 */
const subscribeAndSettle = Effect.fn("subscribeAndSettle")(function* (cwd: string) {
  const maps = yield* WayfinderMaps.WayfinderMaps;
  const armedWatches = yield* ArmedWatches;
  yield* Queue.clear(armedWatches);
  const snapshots = yield* Queue.unbounded<WayfinderMapsSnapshot>();
  yield* maps.stream(cwd).pipe(
    Stream.runForEach((snapshot) => Queue.offer(snapshots, snapshot)),
    Effect.forkScoped,
  );
  const initial = yield* Queue.take(snapshots);
  const watches = yield* Effect.all([
    Queue.take(armedWatches),
    Queue.take(armedWatches),
    Queue.take(armedWatches),
  ]);
  yield* maps.refresh(cwd);
  return { snapshots, initial, watches };
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

  it.effect("watches .plan and .scratch recursively and the workspace root without recursion", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const cwd = yield* makeProject;

      const { watches } = yield* subscribeAndSettle(cwd);

      expect(
        watches
          .map((watch) => ({ name: path.basename(watch.path), recursive: watch.recursive }))
          .toSorted((left, right) => left.name.localeCompare(right.name)),
      ).toEqual(
        [
          { name: ".plan", recursive: true },
          { name: ".scratch", recursive: true },
          { name: path.basename(cwd), recursive: false },
        ].toSorted((left, right) => left.name.localeCompare(right.name)),
      );
    }),
  );

  it.effect("publishes a change to a ticket file in a nested .scratch directory", () =>
    Effect.gen(function* () {
      const cwd = yield* makeProject;
      const { snapshots, initial } = yield* subscribeAndSettle(cwd);
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
      const { snapshots } = yield* subscribeAndSettle(cwd);

      yield* writeText(cwd, ".plan/maps/deep/tickets/02-new.md", ticketMarkdown("New"));
      const changed = yield* Queue.take(snapshots);

      expect(
        changed.maps.find((map) => map.id === "maps/deep")?.nodes.map((node) => node.relativePath),
      ).toEqual([".plan/maps/deep/tickets/01-b.md", ".plan/maps/deep/tickets/02-new.md"]);
    }),
  );

  it.effect("publishes a change to the root map file", () =>
    Effect.gen(function* () {
      const cwd = yield* makeProject;
      yield* writeText(cwd, "wayfinder-map.md", mapMarkdown("Root before"));
      const { snapshots, initial } = yield* subscribeAndSettle(cwd);
      expect(initial.maps.find((map) => map.id === "wayfinder-map")?.title).toBe("Root before");

      yield* writeText(cwd, "wayfinder-map.md", mapMarkdown("Root after"));
      const changed = yield* Queue.take(snapshots);

      expect(changed.maps.find((map) => map.id === "wayfinder-map")?.title).toBe("Root after");
    }),
  );
});
