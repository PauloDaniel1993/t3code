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
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WayfinderMaps from "./WayfinderMaps.ts";

const REFRESH_CALLERS = 10;

/** Scans of these roots stop at their first `.plan/maps` look-up until `release` completes. */
interface HeldScans {
  readonly roots: ReadonlyArray<string>;
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

/**
 * What the observed file system has seen. A scan looks every candidate's `map.md` and
 * `.plan/maps` up through `realPath`, and each `refresh` call stats the real workspace root
 * last before it joins a scan.
 */
class Probe extends Context.Service<
  Probe,
  {
    /** Virtual time of each `map.md` look-up, in the order scans made them. */
    readonly mapLookups: Ref.Ref<ReadonlyArray<number>>;
    readonly workspaceRoot: Ref.Ref<string>;
    /** One entry per stat of `workspaceRoot`. */
    readonly rootStatted: Queue.Queue<void>;
    /** Root and virtual time of each `.plan/maps` look-up, which only a scan makes, once. */
    readonly scanStarts: Ref.Ref<ReadonlyArray<{ readonly root: string; readonly time: number }>>;
    readonly held: Ref.Ref<HeldScans | null>;
    readonly heldCount: Ref.Ref<number>;
  }
>()("t3/wayfinder/WayfinderMapsRefresh.test/Probe") {
  static readonly layer = Layer.effect(
    Probe,
    Effect.gen(function* () {
      return {
        mapLookups: yield* Ref.make<ReadonlyArray<number>>([]),
        workspaceRoot: yield* Ref.make(""),
        rootStatted: yield* Queue.unbounded<void>(),
        scanStarts: yield* Ref.make<ReadonlyArray<{ root: string; time: number }>>([]),
        held: yield* Ref.make<HeldScans | null>(null),
        heldCount: yield* Ref.make(0),
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
        /[\\/]\.plan[\\/]maps$/.test(path)
          ? Effect.gen(function* () {
              const root = path.slice(0, -"/.plan/maps".length);
              const time = yield* Clock.currentTimeMillis;
              yield* Ref.update(probe.scanStarts, (all) => [...all, { root, time }]);
              const held = yield* Ref.get(probe.held);
              if (held?.roots.includes(root)) {
                const count = yield* Ref.updateAndGet(probe.heldCount, (n) => n + 1);
                if (count === held.roots.length) yield* Deferred.succeed(held.entered, undefined);
                yield* Deferred.await(held.release);
              }
              return yield* fileSystem.realPath(path);
            })
          : /[\\/]map\.md$/.test(path)
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
                  path === root ? Queue.offer(probe.rootStatted, undefined) : Effect.void,
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
      yield* Ref.set(probe.mapLookups, []);
      // Roots are keyed, and their last stat made, by real path.
      yield* Ref.set(probe.workspaceRoot, yield* fileSystem.realPath(cwd));

      // A refresh of a root nobody watches has nothing to update and costs no scan.
      yield* maps.refresh(cwd);
      expect(yield* Ref.get(probe.mapLookups)).toEqual([]);

      // Subscribing is one scan, not an initialisation scan plus one.
      yield* maps.stream(cwd).pipe(Stream.runHead);
      expect(scanTimes(yield* Ref.get(probe.mapLookups))).toEqual([0]);

      // Callers arriving together share the next scan, which has to wait out the interval.
      yield* Queue.clear(probe.rootStatted);
      const callers = yield* Effect.forEach(
        Array.from({ length: REFRESH_CALLERS }, () => maps.refresh(cwd)),
        (refresh) => Effect.forkChild(refresh),
      );
      yield* Effect.forEach(callers, () => Queue.take(probe.rootStatted), { discard: true });
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
  it.effect("spaces two scans of one root by the interval when they wait for a scan slot", () =>
    Effect.gen(function* () {
      const maps = yield* WayfinderMaps.WayfinderMaps;
      const probe = yield* Probe;
      const fileSystem = yield* FileSystem.FileSystem;
      const makeRoot = Effect.gen(function* () {
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-wayfinder-gate-" });
        yield* writeText(cwd, "wayfinder-map.md", mapMarkdown("Gate"));
        return yield* fileSystem.realPath(cwd);
      });
      const [first, second, victim] = yield* Effect.all([makeRoot, makeRoot, makeRoot]);
      const interval = Duration.toMillis(WayfinderMaps.WAYFINDER_MAPS_DEFAULT_MIN_SCAN_INTERVAL);
      const start = yield* Clock.currentTimeMillis;

      // The victim is watched and scanned once. Then two other roots take both scan slots.
      yield* maps.stream(victim).pipe(Stream.runHead);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Ref.set(probe.heldCount, 0);
      yield* Ref.set(probe.held, { roots: [first, second], entered, release });
      const blockers = yield* Effect.forEach([first, second], (root) =>
        maps.stream(root).pipe(Stream.runHead, Effect.forkChild),
      );
      yield* Deferred.await(entered);

      // One refresh is due at once but waits for a slot; another arrives while it waits.
      yield* TestClock.adjust(Duration.millis(interval));
      yield* Ref.set(probe.workspaceRoot, victim);
      yield* Queue.clear(probe.rootStatted);
      const early = yield* Effect.forkChild(maps.refresh(victim));
      yield* Queue.take(probe.rootStatted);
      yield* TestClock.adjust(Duration.millis(3 * interval));
      const late = yield* Effect.forkChild(maps.refresh(victim));
      yield* Queue.take(probe.rootStatted);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(early);
      // Lets a trailing scan, if the late refresh needed one, wait out its interval.
      yield* TestClock.adjust(Duration.millis(10 * interval));
      yield* Fiber.joinAll([late, ...blockers]);
      yield* Ref.set(probe.held, null);

      const victimStarts = (yield* Ref.get(probe.scanStarts))
        .filter((scan) => scan.root === victim)
        .map((scan) => scan.time - start);
      expect(victimStarts[0]).toBe(0);
      expect(victimStarts[1]).toBe(4 * interval);
      for (let index = 1; index < victimStarts.length; index++) {
        expect(victimStarts[index]! - victimStarts[index - 1]!).toBeGreaterThanOrEqual(interval);
      }
    }),
  );
});
