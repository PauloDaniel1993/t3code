import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WayfinderMaps from "./WayfinderMaps.ts";

const REFRESH_CALLERS = 10;

/**
 * What the observed file system has seen. A scan looks every candidate's `map.md` up through
 * `realPath`, and each `refresh` call stats the workspace root once before it joins a scan.
 */
class Probe extends Context.Service<
  Probe,
  {
    /** Virtual time of each `map.md` look-up, in the order scans made them. */
    readonly mapLookups: Ref.Ref<ReadonlyArray<number>>;
    readonly workspaceRoot: Ref.Ref<string>;
    readonly rootStats: Ref.Ref<number>;
    /** Fires once the workspace root has been stat'ed `REFRESH_CALLERS` times. */
    readonly rootStatsReached: Deferred.Deferred<void>;
  }
>()("t3/wayfinder/WayfinderMapsRefresh.test/Probe") {
  static readonly layer = Layer.effect(
    Probe,
    Effect.gen(function* () {
      return {
        mapLookups: yield* Ref.make<ReadonlyArray<number>>([]),
        workspaceRoot: yield* Ref.make(""),
        rootStats: yield* Ref.make(0),
        rootStatsReached: yield* Deferred.make<void>(),
      };
    }),
  );
}

/** A scan looks `map.md` up several times at one instant; the instants tell scans apart. */
const scanTimes = (lookups: ReadonlyArray<number>) => [...new Set(lookups)];

const observedFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const probe = yield* Probe;
    return FileSystem.make({
      ...fileSystem,
      realPath: (path) =>
        /[\\/]map\.md$/.test(path)
          ? Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => Ref.update(probe.mapLookups, (all) => [...all, now])),
              Effect.andThen(fileSystem.realPath(path)),
            )
          : fileSystem.realPath(path),
      stat: (path) =>
        fileSystem
          .stat(path)
          .pipe(
            Effect.tap(() =>
              Ref.get(probe.workspaceRoot).pipe(
                Effect.flatMap((root) =>
                  path === root
                    ? Ref.updateAndGet(probe.rootStats, (count) => count + 1).pipe(
                        Effect.flatMap((count) =>
                          count >= REFRESH_CALLERS
                            ? Deferred.succeed(probe.rootStatsReached, undefined)
                            : Effect.void,
                        ),
                      )
                    : Effect.void,
                ),
              ),
            ),
          ),
    });
  }),
);

// The observed FileSystem replaces the plain one for everything built on top of it.
const platform = Layer.provideMerge(
  observedFileSystem,
  Layer.mergeAll(NodeServices.layer, TestClock.layer(), Probe.layer),
);
const workspace = Layer.merge(platform, WorkspacePaths.layer.pipe(Layer.provide(platform)));
const TestLayer = Layer.merge(workspace, WayfinderMaps.layer.pipe(Layer.provide(workspace)));

const mapMarkdown = (title: string) =>
  ["---", `title: ${title}`, "destination: Bounds.", "---", `# ${title}`].join("\n");

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

it.layer(TestLayer, { excludeTestServices: true })("WayfinderMaps refresh work", (it) => {
  it.effect("runs one scan for concurrent refreshes and spaces scans by the interval", () =>
    Effect.gen(function* () {
      const maps = yield* WayfinderMaps.WayfinderMaps;
      const probe = yield* Probe;
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-wayfinder-rate-" });
      yield* writeText(cwd, ".plan/one/map.md", mapMarkdown("One"));
      yield* Ref.set(probe.workspaceRoot, cwd);

      // A refresh on a fresh root is a single scan, not an initialisation scan plus one.
      yield* maps.refresh(cwd);
      expect(scanTimes(yield* Ref.get(probe.mapLookups))).toEqual([0]);

      // Callers arriving together share the next scan, which has to wait out the interval.
      yield* Ref.set(probe.rootStats, 0);
      const callers = yield* Effect.forEach(
        Array.from({ length: REFRESH_CALLERS }, () => maps.refresh(cwd)),
        (refresh) => Effect.forkChild(refresh),
      );
      yield* Deferred.await(probe.rootStatsReached);
      expect(scanTimes(yield* Ref.get(probe.mapLookups))).toEqual([0]);

      yield* TestClock.adjust(WayfinderMaps.WAYFINDER_MAPS_DEFAULT_MIN_SCAN_INTERVAL);
      yield* Fiber.joinAll(callers);

      // Two scans in all, the second a full interval after the first.
      expect(scanTimes(yield* Ref.get(probe.mapLookups))).toEqual([
        0,
        Duration.toMillis(WayfinderMaps.WAYFINDER_MAPS_DEFAULT_MIN_SCAN_INTERVAL),
      ]);
    }),
  );

  it.effect("looks at a bounded number of candidates when a directory holds no maps", () =>
    Effect.gen(function* () {
      const maps = yield* WayfinderMaps.WayfinderMaps;
      const probe = yield* Probe;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-wayfinder-budget-" });
      yield* Ref.set(probe.mapLookups, []);
      yield* Effect.forEach(
        Array.from({ length: WayfinderMaps.WAYFINDER_MAPS_MAX_CANDIDATES + 40 }, (_, i) => i),
        (index) =>
          fileSystem
            .makeDirectory(path.join(cwd, ".scratch", `empty-${String(index).padStart(4, "0")}`), {
              recursive: true,
            })
            .pipe(Effect.orDie),
        { concurrency: 32, discard: true },
      );

      const snapshot = yield* maps.stream(cwd).pipe(Stream.runHead, Effect.map(Option.getOrThrow));

      expect(yield* Ref.get(probe.mapLookups)).toHaveLength(
        WayfinderMaps.WAYFINDER_MAPS_MAX_CANDIDATES,
      );
      expect(snapshot.maps).toEqual([]);
      expect(snapshot.truncated).toBe(true);
      expect(snapshot.lints.map((lint) => lint.code)).toContain("snapshot_truncated");
    }),
  );

  it.effect("marks a map truncated when its ticket folder exceeds the entry budget", () =>
    Effect.gen(function* () {
      const maps = yield* WayfinderMaps.WayfinderMaps;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-wayfinder-tickets-",
      });
      yield* writeText(cwd, ".plan/big/map.md", mapMarkdown("Big"));
      yield* fileSystem
        .makeDirectory(path.join(cwd, ".plan", "big", "tickets"), { recursive: true })
        .pipe(Effect.orDie);
      yield* Effect.forEach(
        Array.from(
          { length: WayfinderMaps.WAYFINDER_MAPS_MAX_TICKET_DIRECTORY_ENTRIES + 20 },
          (_, i) => i,
        ),
        (index) =>
          fileSystem
            .writeFileString(path.join(cwd, ".plan", "big", "tickets", `${index}.txt`), "x")
            .pipe(Effect.orDie),
        { concurrency: 32, discard: true },
      );

      const snapshot = yield* maps.stream(cwd).pipe(Stream.runHead, Effect.map(Option.getOrThrow));

      expect(snapshot.maps[0]?.truncated).toBe(true);
    }),
  );
});
