import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Path from "effect/Path";

import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { makeWayfinderFiles } from "./WayfinderFiles.ts";
import {
  parseWayfinderMaps,
  type WayfinderMap,
  type WayfinderMarkdownFile,
  type WayfinderMapsSnapshot,
  type WayfinderMapSource,
} from "./WayfinderMarkdown.ts";

export const WAYFINDER_MAPS_MAX_MAPS = 24;
export const WAYFINDER_MAPS_MAX_TICKETS_PER_MAP = 200;
export const WAYFINDER_MAPS_MAX_TOTAL_NODES = 600;
export const WAYFINDER_MAPS_MAX_TICKET_BYTES = 64 * 1024;
export const WAYFINDER_MAPS_MAX_MAP_BYTES = 256 * 1024;
export const WAYFINDER_MAPS_MAX_TITLE_CHARACTERS = 200;
// Enumeration budgets: the caps above bound what a snapshot holds, these bound what a scan
// looks at to build it. Reaching one marks the snapshot truncated.
export const WAYFINDER_MAPS_MAX_DISCOVERY_ENTRIES = 256;
export const WAYFINDER_MAPS_MAX_CANDIDATES = 128;
export const WAYFINDER_MAPS_MAX_TICKET_DIRECTORY_ENTRIES = 512;
export const WAYFINDER_MAPS_MAX_CONCURRENT_SCANS = 2;
export const WAYFINDER_MAPS_DEFAULT_BOOTSTRAP_PROBE_INTERVAL = Duration.seconds(1);
export const WAYFINDER_MAPS_DEFAULT_MIN_SCAN_INTERVAL = Duration.seconds(1);
export const WAYFINDER_MAPS_DEFAULT_WATCH_DEBOUNCE = Duration.millis(100);
export const WAYFINDER_MAPS_IDLE_TIME_TO_LIVE = "1 minute";

/** Timing knobs. Production uses the defaults; tests provide shorter ones. */
export class WayfinderMapsTuning extends Context.Reference<{
  /** Least time between the starts of two scans of one root. */
  readonly minScanInterval: Duration.Duration;
  readonly watchDebounce: Duration.Duration;
}>("t3/wayfinder/WayfinderMapsTuning", {
  defaultValue: () => ({
    minScanInterval: WAYFINDER_MAPS_DEFAULT_MIN_SCAN_INTERVAL,
    watchDebounce: WAYFINDER_MAPS_DEFAULT_WATCH_DEBOUNCE,
  }),
}) {}

/** Scans running at once across every root, so rotating `cwd` cannot fan out disk work. */
class WayfinderScanGate extends Context.Service<WayfinderScanGate, Semaphore.Semaphore>()(
  "t3/wayfinder/WayfinderMaps/WayfinderScanGate",
) {
  static readonly layer = Layer.effect(
    WayfinderScanGate,
    Semaphore.make(WAYFINDER_MAPS_MAX_CONCURRENT_SCANS),
  );
}

export type WayfinderMapsError =
  | WorkspacePaths.WorkspaceRootNotExistsError
  | WorkspacePaths.WorkspaceRootCreateFailedError
  | WorkspacePaths.WorkspaceRootStatFailedError
  | WorkspacePaths.WorkspaceRootNotDirectoryError
  | WorkspacePaths.WorkspacePathOutsideRootError;

export interface WayfinderMapsStreamOptions {
  readonly automaticBootstrapProbeInterval?: Effect.Effect<Duration.Duration, never>;
}

interface MapCandidate {
  readonly id: string;
  readonly mapRelativePath: string;
  readonly ticketsRelativePath: string;
}

interface WayfinderMapsRootService {
  readonly refresh: Effect.Effect<void, WorkspacePaths.WorkspacePathOutsideRootError>;
  readonly stream: (
    options?: WayfinderMapsStreamOptions,
  ) => Stream.Stream<WayfinderMapsSnapshot, WorkspacePaths.WorkspacePathOutsideRootError>;
}

class WayfinderMapsRoot extends Context.Service<WayfinderMapsRoot, WayfinderMapsRootService>()(
  "t3/wayfinder/WayfinderMaps/WayfinderMapsRoot",
) {}

function compareEdges(left: WayfinderMap["edges"][number], right: WayfinderMap["edges"][number]) {
  return (
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.kind.localeCompare(right.kind)
  );
}

function snapshotFingerprint(snapshot: WayfinderMapsSnapshot): string {
  return JSON.stringify({
    ...snapshot,
    maps: snapshot.maps.map((map) => ({
      ...map,
      edges: [...map.edges].sort(compareEdges),
    })),
  });
}

function truncateTitle(title: string): { readonly title: string; readonly truncated: boolean } {
  const characters = Array.from(title);
  if (characters.length <= WAYFINDER_MAPS_MAX_TITLE_CHARACTERS) {
    return { title, truncated: false };
  }
  return {
    title: characters.slice(0, WAYFINDER_MAPS_MAX_TITLE_CHARACTERS).join(""),
    truncated: true,
  };
}

function enforceTitleCap(snapshot: WayfinderMapsSnapshot): WayfinderMapsSnapshot {
  const lints = [...snapshot.lints];
  let truncated = snapshot.truncated;
  const maps = snapshot.maps.map((map) => {
    const cappedTitle = truncateTitle(map.title);
    if (!cappedTitle.truncated) {
      return map;
    }
    truncated = true;
    if (!lints.some((lint) => lint.code === "map_truncated" && lint.mapId === map.id)) {
      lints.push({
        code: "map_truncated",
        message: `Map ${map.id} title was truncated to ${WAYFINDER_MAPS_MAX_TITLE_CHARACTERS} characters.`,
        mapId: map.id,
      });
    }
    return {
      ...map,
      title: cappedTitle.title,
      truncated: true,
    };
  });
  return { maps, lints, truncated };
}

type ScanDeferred = Deferred.Deferred<void, WorkspacePaths.WorkspacePathOutsideRootError>;

interface WatchSpec {
  readonly label: string;
  /** Real path to watch, or null while it is absent or resolves outside the project. */
  readonly resolve: Effect.Effect<string | null, WorkspacePaths.WorkspacePathOutsideRootError>;
  readonly recursive: boolean;
  readonly accepts: (event: FileSystem.WatchEvent) => boolean;
}

const ROOT_MAP_FILE_NAME = "wayfinder-map.md";

const rootLayer = (workspaceRoot: string) =>
  Layer.effect(
    WayfinderMapsRoot,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
      const tuning = yield* WayfinderMapsTuning;
      const scanGate = yield* WayfinderScanGate;
      const files = yield* makeWayfinderFiles(workspaceRoot);

      const resolveRelativePath = (relativePath: string) =>
        workspacePaths.resolveRelativePathWithinRoot({ workspaceRoot, relativePath });

      const planTarget = yield* resolveRelativePath(".plan");
      const planMapsTarget = yield* resolveRelativePath(path.join(".plan", "maps"));
      const scratchTarget = yield* resolveRelativePath(".scratch");
      const rootMapTarget = yield* resolveRelativePath(ROOT_MAP_FILE_NAME);

      const discoverCandidates = Effect.fn("WayfinderMaps.discoverCandidates")(function* () {
        const [planMaps, plan, scratch, rootMapExists] = yield* Effect.all(
          [
            files.listDirectory(planMapsTarget.relativePath, WAYFINDER_MAPS_MAX_DISCOVERY_ENTRIES),
            files.listDirectory(planTarget.relativePath, WAYFINDER_MAPS_MAX_DISCOVERY_ENTRIES),
            files.listDirectory(scratchTarget.relativePath, WAYFINDER_MAPS_MAX_DISCOVERY_ENTRIES),
            files.isFile(rootMapTarget.relativePath),
          ],
          { concurrency: "unbounded" },
        );
        const candidates = new Map<string, MapCandidate>();
        const addDirectoryCandidates = (
          container: string,
          entries: ReadonlyArray<string>,
          ticketsDirectoryName: "issues" | "tickets",
          idPrefix?: string,
        ) => {
          for (const entry of entries.toSorted((left, right) => left.localeCompare(right))) {
            const mapRelativePath = path.join(container, entry, "map.md");
            const ticketsRelativePath = path.join(container, entry, ticketsDirectoryName);
            const id = idPrefix ? `${idPrefix}/${entry}` : entry;
            candidates.set(mapRelativePath, { id, mapRelativePath, ticketsRelativePath });
          }
        };
        addDirectoryCandidates(planMapsTarget.relativePath, planMaps.entries, "tickets", "maps");
        addDirectoryCandidates(planTarget.relativePath, plan.entries, "tickets");
        addDirectoryCandidates(scratchTarget.relativePath, scratch.entries, "issues", "scratch");
        if (rootMapExists) {
          candidates.set(rootMapTarget.relativePath, {
            id: "wayfinder-map",
            mapRelativePath: rootMapTarget.relativePath,
            ticketsRelativePath: path.join(planTarget.relativePath, "tickets"),
          });
        }
        const sorted = [...candidates.values()].toSorted((left, right) =>
          left.mapRelativePath.localeCompare(right.mapRelativePath),
        );
        return {
          candidates: sorted.slice(0, WAYFINDER_MAPS_MAX_CANDIDATES),
          truncated:
            planMaps.truncated ||
            plan.truncated ||
            scratch.truncated ||
            sorted.length > WAYFINDER_MAPS_MAX_CANDIDATES,
        };
      });

      const loadTickets = Effect.fn("WayfinderMaps.loadTickets")(function* (
        candidate: MapCandidate,
        remainingNodeCapacity: number,
      ) {
        const listing = yield* files.listDirectory(
          candidate.ticketsRelativePath,
          WAYFINDER_MAPS_MAX_TICKET_DIRECTORY_ENTRIES,
        );
        const ticketEntries = listing.entries
          .filter((entry) => entry.toLowerCase().endsWith(".md"))
          .toSorted((left, right) => left.localeCompare(right));
        const perMapEntries = ticketEntries.slice(0, WAYFINDER_MAPS_MAX_TICKETS_PER_MAP);
        const selectedEntries = perMapEntries.slice(0, remainingNodeCapacity);
        const totalNodeCapReached = perMapEntries.length > selectedEntries.length;
        const truncated = listing.truncated || ticketEntries.length > selectedEntries.length;
        const tickets = (yield* Effect.all(
          selectedEntries.map((entry) =>
            files.readBounded(
              path.join(candidate.ticketsRelativePath, entry),
              WAYFINDER_MAPS_MAX_TICKET_BYTES,
            ),
          ),
          { concurrency: 16 },
        )).filter((ticket): ticket is WayfinderMarkdownFile => ticket !== null);
        return { tickets, truncated, totalNodeCapReached };
      });

      const discoverSnapshot = Effect.fn("WayfinderMaps.discoverSnapshot")(function* () {
        const discovered = yield* discoverCandidates();
        const sources: Array<WayfinderMapSource> = [];
        let totalNodes = 0;
        let snapshotTruncated = discovered.truncated;

        for (const candidate of discovered.candidates) {
          const map = yield* files.readBounded(
            candidate.mapRelativePath,
            WAYFINDER_MAPS_MAX_MAP_BYTES,
          );
          if (!map) {
            continue;
          }
          if (sources.length >= WAYFINDER_MAPS_MAX_MAPS) {
            snapshotTruncated = true;
            break;
          }
          const loaded = yield* loadTickets(
            candidate,
            Math.max(0, WAYFINDER_MAPS_MAX_TOTAL_NODES - totalNodes),
          );
          totalNodes += loaded.tickets.length;
          snapshotTruncated ||= loaded.totalNodeCapReached;
          sources.push({
            id: candidate.id,
            map,
            tickets: loaded.tickets,
            truncated: loaded.truncated,
          });
        }

        return enforceTitleCap(parseWayfinderMaps(sources, snapshotTruncated));
      });

      // The first scan is lazy: a refresh on a fresh root is one scan, not an initialisation
      // scan followed by the requested one.
      const snapshotRef = yield* Ref.make(Option.none<WayfinderMapsSnapshot>());
      const fingerprintRef = yield* Ref.make("");
      const changes = yield* PubSub.sliding<WayfinderMapsSnapshot>(1);
      // Held only to swap the snapshot and publish it, and to subscribe against it.
      const publishMutex = yield* Semaphore.make(1);
      const scanMutex = yield* Semaphore.make(1);
      const pendingScanRef = yield* Ref.make(Option.none<ScanDeferred>());
      const lastScanStartRef = yield* Ref.make(Option.none<number>());
      const watcherStartedRef = yield* Ref.make(false);
      const watcherScope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() =>
        Scope.close(watcherScope, Exit.void).pipe(Effect.andThen(PubSub.shutdown(changes))),
      );

      const scanAndPublish = Effect.gen(function* () {
        const snapshot = yield* discoverSnapshot();
        const fingerprint = snapshotFingerprint(snapshot);
        yield* publishMutex.withPermits(1)(
          Effect.gen(function* () {
            const previous = yield* Ref.getAndSet(fingerprintRef, fingerprint);
            const hadSnapshot = Option.isSome(yield* Ref.get(snapshotRef));
            if (hadSnapshot && previous === fingerprint) {
              return;
            }
            yield* Ref.set(snapshotRef, Option.some(snapshot));
            yield* PubSub.publish(changes, snapshot);
          }),
        );
      });

      // Runs one scan for everything that asked while it was waiting. It clears the pending
      // slot only once it starts scanning, so requests arriving during the throttle wait join
      // it, and requests arriving during the scan queue exactly one more.
      const runPendingScan = scanMutex.withPermits(1)(
        Effect.gen(function* () {
          const lastStart = yield* Ref.get(lastScanStartRef);
          const now = yield* Clock.currentTimeMillis;
          const waitMillis = Option.match(lastStart, {
            onNone: () => 0,
            onSome: (start) => Math.max(0, start + Duration.toMillis(tuning.minScanInterval) - now),
          });
          if (waitMillis > 0) {
            yield* Effect.sleep(Duration.millis(waitMillis));
          }
          yield* Ref.set(pendingScanRef, Option.none());
          yield* Ref.set(lastScanStartRef, Option.some(yield* Clock.currentTimeMillis));
          yield* scanGate.withPermits(1)(scanAndPublish);
        }),
      );

      /** Ask for a scan. Concurrent callers share one; scans start at most once per interval. */
      const requestScan = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const fresh = yield* Deferred.make<void, WorkspacePaths.WorkspacePathOutsideRootError>();
          const claimed = yield* Ref.modify(
            pendingScanRef,
            (current): [Option.Option<ScanDeferred>, Option.Option<ScanDeferred>] =>
              Option.isSome(current) ? [current, current] : [Option.none(), Option.some(fresh)],
          );
          const pending = Option.getOrElse(claimed, () => fresh);
          if (Option.isNone(claimed)) {
            yield* runPendingScan.pipe(
              Effect.onExit((exit) => Deferred.done(pending, exit)),
              Effect.forkIn(watcherScope),
            );
          }
          return yield* restore(Deferred.await(pending));
        }),
      );

      const latestSnapshot = Effect.gen(function* () {
        if (Option.isNone(yield* Ref.get(snapshotRef))) {
          yield* requestScan;
        }
        return yield* Ref.get(snapshotRef).pipe(Effect.map(Option.getOrThrow));
      });

      const watchSpecs: ReadonlyArray<WatchSpec> = [
        // Recursive so a change to any ticket or map below `.plan` or `.scratch` reaches
        // subscribers. Only these two subtrees are watched this way; the workspace root is
        // never watched recursively because it holds node_modules and .git.
        {
          label: planTarget.relativePath,
          resolve: files.resolveDirectory(planTarget.relativePath, { quiet: true }),
          recursive: true,
          accepts: () => true,
        },
        {
          label: scratchTarget.relativePath,
          resolve: files.resolveDirectory(scratchTarget.relativePath, { quiet: true }),
          recursive: true,
          accepts: () => true,
        },
        // The root map file sits directly in the workspace root: watch that one directory
        // without recursion and react only to the map file.
        {
          label: ROOT_MAP_FILE_NAME,
          resolve: Effect.succeed(workspaceRoot),
          recursive: false,
          accepts: (event) => event.path === ROOT_MAP_FILE_NAME,
        },
      ];

      const runWatcher = Effect.fn("WayfinderMaps.runWatcher")(function* (
        directory: string,
        spec: WatchSpec,
      ) {
        // Taking the pull is what creates the OS watch, so it comes first: the arming scan
        // below then cannot miss a change made before the watch existed.
        const pull = yield* Stream.toPull(
          fileSystem.watch(directory, { recursive: spec.recursive }),
        );
        yield* requestScan;
        yield* Stream.fromPull(Effect.succeed(pull)).pipe(
          Stream.filter(spec.accepts),
          Stream.debounce(tuning.watchDebounce),
          Stream.runForEach(() => requestScan),
        );
      }, Effect.scoped);

      const startWatcher = Effect.fn("WayfinderMaps.startWatcher")(function* (
        options?: WayfinderMapsStreamOptions,
      ) {
        const shouldStart = yield* Ref.modify(watcherStartedRef, (started) => [!started, true]);
        if (!shouldStart) {
          return;
        }
        const probeInterval =
          options?.automaticBootstrapProbeInterval ??
          Effect.succeed(WAYFINDER_MAPS_DEFAULT_BOOTSTRAP_PROBE_INTERVAL);
        const sleepUntilNextProbe = probeInterval.pipe(Effect.flatMap(Effect.sleep));
        for (const spec of watchSpecs) {
          const superviseWatcher = Effect.forever(
            Effect.gen(function* () {
              let directory = yield* spec.resolve;
              while (directory === null) {
                yield* sleepUntilNextProbe;
                directory = yield* spec.resolve;
              }
              yield* runWatcher(directory, spec);
            }).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("Wayfinder watcher stopped; re-arming", {
                      cause,
                      relativePath: spec.label,
                    }),
              ),
              Effect.andThen(sleepUntilNextProbe),
            ),
          );
          yield* superviseWatcher.pipe(Effect.forkIn(watcherScope));
        }
      });

      const stream: WayfinderMapsRootService["stream"] = (options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* startWatcher(options);
            // The first scan must finish before the mutex is taken to subscribe: it publishes
            // under the same mutex.
            yield* latestSnapshot;
            const subscription = yield* subscribeBeforeSnapshot(
              changes,
              Ref.get(snapshotRef).pipe(Effect.map(Option.getOrThrow)),
              publishMutex,
            );
            return Stream.concat(Stream.make(subscription.latest), subscription.changes);
          }),
        );

      return WayfinderMapsRoot.of({ refresh: requestScan, stream });
    }),
  );

export class WayfinderMapsMap extends LayerMap.Service<WayfinderMapsMap>()(
  "t3/wayfinder/WayfinderMapsMap",
  {
    lookup: rootLayer,
    dependencies: [WayfinderScanGate.layer],
    idleTimeToLive: WAYFINDER_MAPS_IDLE_TIME_TO_LIVE,
  },
) {}

export class WayfinderMaps extends Context.Service<
  WayfinderMaps,
  {
    readonly refresh: (cwd: string) => Effect.Effect<void, WayfinderMapsError>;
    readonly stream: (
      cwd: string,
      options?: WayfinderMapsStreamOptions,
    ) => Stream.Stream<WayfinderMapsSnapshot, WayfinderMapsError>;
  }
>()("t3/wayfinder/WayfinderMaps") {}

export const make = Effect.gen(function* () {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const maps = yield* WayfinderMapsMap;

  const normalizeRoot = (cwd: string) => workspacePaths.normalizeWorkspaceRoot(cwd);

  const refresh: WayfinderMaps["Service"]["refresh"] = Effect.fn("WayfinderMaps.refresh")(
    function* (cwd) {
      const workspaceRoot = yield* normalizeRoot(cwd);
      const context = yield* maps.contextEffect(workspaceRoot);
      return yield* Context.get(context, WayfinderMapsRoot).refresh;
    },
    Effect.scoped,
  );

  const stream: WayfinderMaps["Service"]["stream"] = (cwd, options) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const workspaceRoot = yield* normalizeRoot(cwd);
        const context = yield* maps.contextEffect(workspaceRoot);
        return Context.get(context, WayfinderMapsRoot).stream(options);
      }),
    );

  return WayfinderMaps.of({ refresh, stream });
});

export const layer = Layer.effect(WayfinderMaps, make).pipe(Layer.provide(WayfinderMapsMap.layer));
