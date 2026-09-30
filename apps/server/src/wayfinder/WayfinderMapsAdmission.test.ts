// @effect-diagnostics nodeBuiltinImport:off - links can only be created through the native fs.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

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

const platform = Layer.provideMerge(
  observedFileSystem,
  Layer.mergeAll(NodeServices.layer, Scans.layer),
);
const workspace = Layer.merge(platform, WorkspacePaths.layer.pipe(Layer.provide(platform)));
// Refreshes of a live root scan at once, so each one is visible in `Scans` without waiting.
const quickTuning = Layer.succeed(WayfinderMaps.WayfinderMapsTuning, {
  minScanInterval: Duration.zero,
  watchDebounce: WayfinderMaps.WAYFINDER_MAPS_DEFAULT_WATCH_DEBOUNCE,
});
const TestLayer = Layer.merge(
  workspace,
  WayfinderMaps.layer.pipe(Layer.provide(workspace), Layer.provide(quickTuning)),
);

const makeProject = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-wayfinder-admit-" });
  yield* fileSystem
    .writeFileString(path.join(cwd, "wayfinder-map.md"), "# Admission")
    .pipe(Effect.orDie);
  return yield* fileSystem.realPath(cwd);
});

/** Runs a subscription in the background and returns once its first snapshot is in. */
const hold = Effect.fn("hold")(function* <E>(
  snapshots: Stream.Stream<unknown, E>,
  fork: <A>(effect: Effect.Effect<A, E>) => Effect.Effect<Fiber.Fiber<A, E>, never, never>,
) {
  const first = yield* Deferred.make<void>();
  const fiber = yield* fork(
    snapshots.pipe(Stream.runForEach(() => Deferred.succeed(first, undefined))),
  );
  yield* Deferred.await(first);
  return fiber;
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
        yield* hold(maps.stream(spelling), Effect.forkChild);
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

  it.effect("closes a root with its last subscriber; a refresh neither keeps nor revives it", () =>
    Effect.gen(function* () {
      const maps = yield* WayfinderMaps.WayfinderMaps;
      const scans = yield* Scans;
      const cwd = yield* makeProject;
      const first = yield* hold(maps.stream(cwd), Effect.forkChild);
      const second = yield* hold(maps.stream(cwd), Effect.forkChild);

      yield* Fiber.interrupt(first);
      yield* Ref.set(scans, []);
      yield* maps.refresh(cwd);
      // The other subscriber still holds it.
      expect(yield* Ref.get(scans)).toEqual([cwd]);

      yield* Fiber.interrupt(second);
      yield* Ref.set(scans, []);
      yield* maps.refresh(cwd);
      yield* maps.refresh(cwd);
      expect(yield* Ref.get(scans)).toEqual([]);
    }),
  );

  it.effect(
    "lets no connection shut another out, by holding roots or by churning through them",
    () =>
      Effect.gen(function* () {
        const maps = yield* WayfinderMaps.WayfinderMaps;
        const scans = yield* Scans;
        const perConnection = WayfinderMaps.WAYFINDER_MAPS_MAX_SUBSCRIPTIONS_PER_CONNECTION;

        // One connection opens and closes more folders than two connections can hold at once,
        // refreshing each after closing it.
        const churner = yield* makeWayfinderRpcHandlers;
        for (let index = 0; index < 3 * perConnection; index++) {
          const cwd = yield* makeProject;
          yield* churner.subscribe({ cwd }).pipe(Stream.runHead);
          yield* churner.refresh({ cwd });
        }

        // Two connections, from one client, each hold their full allowance.
        const connections = [yield* Scope.make(), yield* Scope.make()];
        const held: Array<string> = [];
        for (const connection of connections) {
          const handlers = yield* makeWayfinderRpcHandlers;
          for (let index = 0; index < perConnection; index++) {
            const cwd = yield* makeProject;
            held.push(cwd);
            yield* hold(handlers.subscribe({ cwd }), Effect.forkIn(connection));
          }
        }

        const other = yield* makeWayfinderRpcHandlers;
        const otherCwd = yield* makeProject;
        expect(
          yield* other.subscribe({ cwd: otherCwd }).pipe(Stream.runHead, Effect.exit),
        ).toSatisfy(Exit.isSuccess);

        // Closing a connection releases every root it held.
        yield* Effect.forEach(connections, (connection) => Scope.close(connection, Exit.void), {
          discard: true,
        });
        yield* Ref.set(scans, []);
        yield* Effect.forEach(held, (cwd) => maps.refresh(cwd), { discard: true });
        expect(yield* Ref.get(scans)).toEqual([]);
      }),
  );
});
