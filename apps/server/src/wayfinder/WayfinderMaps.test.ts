import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as WayfinderMaps from "./WayfinderMaps.ts";
import type { WayfinderMapsSnapshot } from "./WayfinderMarkdown.ts";

const PlatformLayer = Layer.merge(NodeServices.layer, TestClock.layer());
const WorkspaceLayer = Layer.merge(
  PlatformLayer,
  WorkspacePaths.layer.pipe(Layer.provide(PlatformLayer)),
);
const TestLayer = Layer.merge(
  WorkspaceLayer,
  WayfinderMaps.layer.pipe(Layer.provide(WorkspaceLayer)),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-wayfinder-maps-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

const firstSnapshot = Effect.fn("firstSnapshot")(function* (cwd: string) {
  const maps = yield* WayfinderMaps.WayfinderMaps;
  return yield* maps.stream(cwd).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
});

const frontmatterMap = (title: string) =>
  ["---", `title: ${title}`, "destination: Test discovery.", "---", `# ${title}`].join("\n");

const frontmatterTicket = (title: string, answer?: string) =>
  [
    "---",
    "type: task",
    "blocked_by: []",
    "---",
    `# ${title}`,
    ...(answer ? ["", "## Answer", "", answer] : []),
  ].join("\n");

it.layer(TestLayer, { excludeTestServices: true })("WayfinderMaps", (it) => {
  describe("discovery", () => {
    it.effect("discovers both markdown dialects in one workspace", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".plan/maps/frontmatter/map.md", frontmatterMap("Frontmatter"));
        yield* writeTextFile(
          cwd,
          ".plan/maps/frontmatter/tickets/01-first.md",
          frontmatterTicket("First"),
        );
        yield* writeTextFile(
          cwd,
          ".plan/field-lines/map.md",
          ["**Title:** Field lines", "**Destination:** Test discovery.", "", "# Field lines"].join(
            "\n",
          ),
        );
        yield* writeTextFile(
          cwd,
          ".plan/field-lines/tickets/01-second.md",
          ["# Second", "", "**Type:** task", "**Blocked by:** []"].join("\n"),
        );
        yield* writeTextFile(
          cwd,
          "wayfinder-map.md",
          ["**Title:** Root map", "**Destination:** Test the root probe."].join("\n"),
        );
        yield* writeTextFile(
          cwd,
          ".plan/tickets/01-root.md",
          ["# Root", "", "**Type:** task", "**Blocked by:** []"].join("\n"),
        );

        const snapshot = yield* firstSnapshot(cwd);

        expect(new Set(snapshot.maps.map((map) => map.dialect))).toEqual(
          new Set(["field-lines", "frontmatter"]),
        );
        expect(snapshot.maps.map((map) => map.mapRelativePath)).toEqual([
          ".plan/field-lines/map.md",
          ".plan/maps/frontmatter/map.md",
          "wayfinder-map.md",
        ]);
        expect(snapshot.maps.flatMap((map) => map.nodes.map((node) => node.relativePath))).toEqual([
          ".plan/field-lines/tickets/01-second.md",
          ".plan/maps/frontmatter/tickets/01-first.md",
          ".plan/tickets/01-root.md",
        ]);
      }),
    );

    it.effect("discovers .scratch issues alongside .plan tickets without id collisions", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".plan/design/map.md", frontmatterMap("Plan design"));
        yield* writeTextFile(
          cwd,
          ".plan/design/tickets/01-plan.md",
          frontmatterTicket("Plan ticket"),
        );
        yield* writeTextFile(cwd, ".scratch/design/map.md", frontmatterMap("Scratch design"));
        yield* writeTextFile(
          cwd,
          ".scratch/design/issues/01-scratch.md",
          frontmatterTicket("Scratch issue"),
        );

        const snapshot = yield* firstSnapshot(cwd);

        expect(snapshot.maps.map((map) => map.id)).toEqual(["design", "scratch/design"]);
        expect(snapshot.maps.map((map) => map.mapRelativePath)).toEqual([
          ".plan/design/map.md",
          ".scratch/design/map.md",
        ]);
        expect(snapshot.maps.flatMap((map) => map.nodes.map((node) => node.relativePath))).toEqual([
          ".plan/design/tickets/01-plan.md",
          ".scratch/design/issues/01-scratch.md",
        ]);
      }),
    );

    it.effect("returns an empty snapshot when discovery directories are absent", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;

        expect(yield* firstSnapshot(cwd)).toEqual({ maps: [], lints: [], truncated: false });
      }),
    );
  });

  describe("caps", () => {
    it.effect("bounds file reads and title length while surfacing truncation", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        const longTitle = "t".repeat(WayfinderMaps.WAYFINDER_MAPS_MAX_TITLE_CHARACTERS + 5);
        const largeMap = `${frontmatterMap(longTitle)}\n${"m".repeat(
          WayfinderMaps.WAYFINDER_MAPS_MAX_MAP_BYTES,
        )}`;
        const largeTicket = `${frontmatterTicket("Large ticket")}\n${"x".repeat(
          WayfinderMaps.WAYFINDER_MAPS_MAX_TICKET_BYTES,
        )}`;
        yield* writeTextFile(cwd, ".plan/large/map.md", largeMap);
        yield* writeTextFile(cwd, ".plan/large/tickets/01-large.md", largeTicket);

        const snapshot = yield* firstSnapshot(cwd);
        const map = snapshot.maps[0];

        expect(snapshot.truncated).toBe(true);
        expect(map?.truncated).toBe(true);
        expect(Array.from(map?.title ?? "")).toHaveLength(
          WayfinderMaps.WAYFINDER_MAPS_MAX_TITLE_CHARACTERS,
        );
        expect(snapshot.lints.map((lint) => lint.code)).toEqual(
          expect.arrayContaining(["map_truncated", "ticket_truncated"]),
        );
      }),
    );

    it.effect("enforces map, per-map ticket, and total-node caps", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        const writes: Array<Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>> = [];
        for (let mapIndex = 0; mapIndex < WayfinderMaps.WAYFINDER_MAPS_MAX_MAPS + 1; mapIndex++) {
          const isScratchMap = mapIndex >= 12;
          const root = isScratchMap ? ".scratch" : ".plan";
          const ticketDirectory = isScratchMap ? "issues" : "tickets";
          const rootMapIndex = isScratchMap ? mapIndex - 12 : mapIndex;
          const mapId = `map-${String(rootMapIndex).padStart(2, "0")}`;
          writes.push(writeTextFile(cwd, `${root}/${mapId}/map.md`, frontmatterMap(mapId)));
          if (![0, 1, 12, 13].includes(mapIndex)) {
            continue;
          }
          for (
            let ticketIndex = 0;
            ticketIndex < WayfinderMaps.WAYFINDER_MAPS_MAX_TICKETS_PER_MAP + 1;
            ticketIndex++
          ) {
            const ticketId = String(ticketIndex + 1).padStart(3, "0");
            writes.push(
              writeTextFile(
                cwd,
                `${root}/${mapId}/${ticketDirectory}/${ticketId}.md`,
                frontmatterTicket(`${mapId}-${ticketId}`),
              ),
            );
          }
        }
        yield* Effect.all(writes, { concurrency: 32, discard: true });

        const snapshot = yield* firstSnapshot(cwd);
        const nodeCount = snapshot.maps.reduce((total, map) => total + map.nodes.length, 0);

        expect(snapshot.maps).toHaveLength(WayfinderMaps.WAYFINDER_MAPS_MAX_MAPS);
        expect(snapshot.maps.find((map) => map.id === "map-00")?.nodes).toHaveLength(
          WayfinderMaps.WAYFINDER_MAPS_MAX_TICKETS_PER_MAP,
        );
        expect(snapshot.maps.find((map) => map.id === "scratch/map-00")?.nodes).toHaveLength(
          WayfinderMaps.WAYFINDER_MAPS_MAX_TICKETS_PER_MAP,
        );
        expect(nodeCount).toBe(WayfinderMaps.WAYFINDER_MAPS_MAX_TOTAL_NODES);
        expect(snapshot.truncated).toBe(true);
        expect(snapshot.lints.map((lint) => lint.code)).toEqual(
          expect.arrayContaining(["map_truncated", "snapshot_truncated"]),
        );
      }),
    );
  });

  describe("publication", () => {
    it.effect("dedupes watcher-style refresh bursts and republishes a content change once", () =>
      Effect.gen(function* () {
        const maps = yield* WayfinderMaps.WayfinderMaps;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".plan/dedupe/map.md", frontmatterMap("Dedupe"));
        yield* writeTextFile(cwd, ".plan/dedupe/tickets/01-ticket.md", frontmatterTicket("Ticket"));
        const snapshotsRef = yield* Ref.make<ReadonlyArray<WayfinderMapsSnapshot>>([]);
        const firstEmission = yield* Deferred.make<void>();
        const secondEmission = yield* Deferred.make<void>();
        yield* maps.stream(cwd).pipe(
          Stream.runForEach((snapshot) =>
            Ref.updateAndGet(snapshotsRef, (snapshots) => [...snapshots, snapshot]).pipe(
              Effect.flatMap((snapshots) =>
                snapshots.length === 1
                  ? Deferred.succeed(firstEmission, undefined).pipe(Effect.ignore)
                  : snapshots.length === 2
                    ? Deferred.succeed(secondEmission, undefined).pipe(Effect.ignore)
                    : Effect.void,
              ),
            ),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(firstEmission);

        yield* maps.refresh(cwd);
        yield* maps.refresh(cwd);
        yield* Effect.yieldNow;
        expect(yield* Ref.get(snapshotsRef)).toHaveLength(1);

        yield* writeTextFile(
          cwd,
          ".plan/dedupe/tickets/01-ticket.md",
          frontmatterTicket("Ticket", "Resolved now."),
        );
        yield* Effect.all([maps.refresh(cwd), maps.refresh(cwd), maps.refresh(cwd)], {
          concurrency: "unbounded",
          discard: true,
        });
        yield* Deferred.await(secondEmission);
        yield* Effect.all([maps.refresh(cwd), maps.refresh(cwd)], {
          concurrency: "unbounded",
          discard: true,
        });

        const snapshots = yield* Ref.get(snapshotsRef);
        expect(snapshots).toHaveLength(2);
        expect(snapshots[0]?.maps[0]?.nodes[0]?.status).toBe("open");
        expect(snapshots[1]?.maps[0]?.nodes[0]?.status).toBe("resolved");
      }),
    );

    it.effect(
      "uses TestClock-driven bootstrap probes until both discovery roots can be watched",
      () =>
        Effect.gen(function* () {
          const maps = yield* WayfinderMaps.WayfinderMaps;
          const cwd = yield* makeTempDir;
          const emissionsRef = yield* Ref.make<ReadonlyArray<WayfinderMapsSnapshot>>([]);
          const initialEmission = yield* Deferred.make<void>();
          const discoveredEmission = yield* Deferred.make<void>();
          yield* maps
            .stream(cwd, {
              automaticBootstrapProbeInterval: Effect.succeed(Duration.seconds(1)),
            })
            .pipe(
              Stream.runForEach((snapshot) =>
                Ref.updateAndGet(emissionsRef, (emissions) => [...emissions, snapshot]).pipe(
                  Effect.flatMap((emissions) =>
                    emissions.length === 1
                      ? Deferred.succeed(initialEmission, undefined).pipe(Effect.ignore)
                      : emissions.length === 2
                        ? Deferred.succeed(discoveredEmission, undefined).pipe(Effect.ignore)
                        : Effect.void,
                  ),
                ),
              ),
              Effect.forkScoped,
            );
          yield* Deferred.await(initialEmission);
          yield* Effect.yieldNow;

          yield* writeTextFile(cwd, ".plan/later/map.md", frontmatterMap("Later"));
          yield* writeTextFile(cwd, ".plan/later/tickets/01-later.md", frontmatterTicket("Later"));
          yield* writeTextFile(cwd, ".scratch/later/map.md", frontmatterMap("Scratch later"));
          yield* writeTextFile(
            cwd,
            ".scratch/later/issues/01-later.md",
            frontmatterTicket("Scratch later"),
          );
          yield* TestClock.adjust(Duration.seconds(1));
          yield* Deferred.await(discoveredEmission);
          yield* Effect.yieldNow;

          const emissions = yield* Ref.get(emissionsRef);
          expect(emissions).toHaveLength(2);
          expect(emissions[0]).toEqual({ maps: [], lints: [], truncated: false });
          expect(emissions[1]?.maps.map((map) => map.id)).toEqual(["later", "scratch/later"]);
        }),
    );
  });
});
