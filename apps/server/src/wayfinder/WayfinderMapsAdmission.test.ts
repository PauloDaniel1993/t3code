// @effect-diagnostics nodeBuiltinImport:off - links can only be created through the native fs.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WayfinderMaps from "./WayfinderMaps.ts";
import { makeWayfinderRpcHandlers } from "./WayfinderRpcHandlers.ts";

/** Roots scanned so far, one entry per scan: only a scan looks `.plan/maps` up. */
class Scans extends Context.Service<Scans, Ref.Ref<ReadonlyArray<string>>>()(
  "t3/wayfinder/WayfinderMapsAdmission.test/Scans",
) {
  static readonly layer = Layer.effect(Scans, Ref.make<ReadonlyArray<string>>([]));
}

const observedFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const scans = yield* Scans;
    return FileSystem.make({
      ...fileSystem,
      realPath: (path) =>
        /[\\/]\.plan[\\/]maps$/.test(path)
          ? Ref.update(scans, (all) => [...all, path.slice(0, -"/.plan/maps".length)]).pipe(
              Effect.andThen(fileSystem.realPath(path)),
            )
          : fileSystem.realPath(path),
    });
  }),
);

// The test clock never reaches the idle time-to-live, so every root stays live.
const platform = Layer.provideMerge(
  observedFileSystem,
  Layer.mergeAll(NodeServices.layer, TestClock.layer(), Scans.layer),
);
const workspace = Layer.merge(platform, WorkspacePaths.layer.pipe(Layer.provide(platform)));
const TestLayer = Layer.merge(workspace, WayfinderMaps.layer.pipe(Layer.provide(workspace)));

const makeProject = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-wayfinder-admit-" });
  yield* fileSystem
    .writeFileString(path.join(cwd, "wayfinder-map.md"), "# Admission")
    .pipe(Effect.orDie);
  return yield* fileSystem.realPath(cwd);
});

it.layer(TestLayer, { excludeTestServices: true })("WayfinderMaps admission", (it) => {
  it.effect("shares one root between spellings of a folder: letter case and a link", () =>
    Effect.gen(function* () {
      const maps = yield* WayfinderMaps.WayfinderMaps;
      const scans = yield* Scans;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeProject;
      const link = `${root}-link`;
      yield* Effect.promise(() => NodeFSP.symlink(root, link, "junction"));
      yield* Effect.addFinalizer(() => Effect.promise(() => NodeFSP.unlink(link)));
      const spellings = [root, link];
      // Another letter case names the same folder only on a case-insensitive file system.
      const upper = path.join(path.dirname(root), path.basename(root).toUpperCase());
      if (upper !== root && (yield* fileSystem.exists(upper).pipe(Effect.orDie))) {
        spellings.push(upper);
      }
      yield* Ref.set(scans, []);

      for (const spelling of spellings) {
        yield* maps.stream(spelling).pipe(Stream.runHead);
      }

      expect(yield* Ref.get(scans)).toEqual([root]);
    }),
  );

  it.effect("limits the subscriptions one connection holds and frees a slot when one ends", () =>
    Effect.gen(function* () {
      const handlers = yield* makeWayfinderRpcHandlers;
      const other = yield* makeWayfinderRpcHandlers;
      const cwd = yield* makeProject;
      const firstSnapshots = yield* Queue.unbounded<void>();
      const open = () =>
        handlers.subscribe({ cwd }).pipe(
          Stream.runForEach(() => Queue.offer(firstSnapshots, undefined)),
          Effect.forkChild,
        );
      const held = yield* Effect.forEach(
        Array.from({ length: WayfinderMaps.WAYFINDER_MAPS_MAX_SUBSCRIPTIONS_PER_CONNECTION }),
        open,
      );
      yield* Effect.forEach(held, () => Queue.take(firstSnapshots), { discard: true });

      const refused = yield* handlers.subscribe({ cwd }).pipe(Stream.runHead, Effect.flip);
      expect(refused.failure).toBe("capacity_reached");
      // Another connection has its own allowance.
      expect(yield* other.subscribe({ cwd }).pipe(Stream.runHead, Effect.exit)).toSatisfy(
        Exit.isSuccess,
      );

      yield* Fiber.interrupt(held[0]!);
      expect(yield* handlers.subscribe({ cwd }).pipe(Stream.runHead, Effect.exit)).toSatisfy(
        Exit.isSuccess,
      );
      yield* Fiber.interruptAll(held);
    }),
  );

  it.effect("refuses a root past the live-root cap and keeps serving the live ones", () =>
    Effect.gen(function* () {
      const maps = yield* WayfinderMaps.WayfinderMaps;
      // Earlier tests left roots live; fill whatever room remains.
      const first = yield* makeProject;
      yield* maps.stream(first).pipe(Stream.runHead);
      const extra: Array<string> = [];
      let refused: Exit.Exit<unknown, WayfinderMaps.WayfinderMapsError> = Exit.void;
      while (Exit.isSuccess(refused)) {
        const cwd = yield* makeProject;
        refused = yield* maps.stream(cwd).pipe(Stream.runHead, Effect.exit);
        if (Exit.isSuccess(refused)) extra.push(cwd);
        expect(extra.length).toBeLessThan(WayfinderMaps.WAYFINDER_MAPS_MAX_LIVE_ROOTS);
      }

      expect(Exit.isFailure(refused) && refused.cause.toString()).toContain(
        "WayfinderMapsCapacityError",
      );
      // A live root is not a new one: it is still served.
      expect(yield* maps.stream(first).pipe(Stream.runHead, Effect.exit)).toSatisfy(Exit.isSuccess);
    }),
  );
});
