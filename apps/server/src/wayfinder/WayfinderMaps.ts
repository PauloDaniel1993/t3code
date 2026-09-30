import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Path from "effect/Path";

import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { makeWayfinderFiles, resolveRealRoot, watchDirectory } from "./WayfinderFiles.ts";
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
// Admission: what one server holds for all clients, and what one connection may hold of it.
export const WAYFINDER_MAPS_MAX_LIVE_ROOTS = 32;
export const WAYFINDER_MAPS_MAX_SUBSCRIPTIONS_PER_CONNECTION = 16;
export const WAYFINDER_MAPS_BOOTSTRAP_PROBE_INTERVAL = Duration.seconds(1);
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

/** A new root or subscription was refused because its admission cap is reached. */
export class WayfinderMapsCapacityError extends Data.TaggedError("WayfinderMapsCapacityError")<{
  readonly message: string;
}> {}

export type WayfinderMapsError =
  | WayfinderMapsCapacityError
  | WorkspacePaths.WorkspaceRootNotExistsError
  | WorkspacePaths.WorkspaceRootCreateFailedError
  | WorkspacePaths.WorkspaceRootStatFailedError
  | WorkspacePaths.WorkspaceRootNotDirectoryError
  | WorkspacePaths.WorkspacePathOutsideRootError;

interface MapCandidate {
  readonly id: string;
  readonly mapRelativePath: string;
  readonly ticketsRelativePath: string;
}

interface WayfinderMapsRootService {
  readonly refresh: Effect.Effect<void, WorkspacePaths.WorkspacePathOutsideRootError>;
  readonly stream: Stream.Stream<
    WayfinderMapsSnapshot,
    WorkspacePaths.WorkspacePathOutsideRootError
  >;
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
  /** Where the watched directory sits, relative to the workspace root ("" for the root). */
  readonly relativePath: string;
  /** Real path to watch, or null while it is absent or resolves outside the project. */
  readonly resolve: Effect.Effect<string | null, WorkspacePaths.WorkspacePathOutsideRootError>;
  readonly recursive: boolean;
}

const ROOT_MAP_FILE_NAME = "wayfinder-map.md";
/** Where discovery looks: `<container>/<effort>/map.md`, tickets in `<effort>/<tickets>/`. */
const MAP_CONTAINERS = [
  { segments: [".plan", "maps"], tickets: "tickets" },
  { segments: [".plan"], tickets: "tickets" },
  { segments: [".scratch"], tickets: "issues" },
] as const;

/**
 * What a path, relative to the workspace root, can be to discovery: a file it reads, a
 * folder whose appearance or removal changes what it finds, or nothing. Discovery filters
 * ticket names with it and the watchers filter every event with it. Names compare without
 * case, because discovery's fixed names (`map.md`, `wayfinder-map.md`, `tickets`) also match
 * other spellings on Windows and macOS; on Linux the extra match costs a scan, nothing else.
 * The containers overlap (`.plan/maps/map.md` is the map of the `.plan` effort `maps`), so a
 * file match in any container wins over a folder match in another.
 */
export function wayfinderPathKind(relativePath: string): "file" | "folder" | null {
  const segments = relativePath
    .toLowerCase()
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
  const [first, second, third, ...deeper] = segments;
  if (second === undefined) {
    if (first === ROOT_MAP_FILE_NAME) return "file";
    return first === ".plan" || first === ".scratch" ? "folder" : null;
  }
  // The root map's tickets.
  if (first === ".plan" && second === "tickets" && third?.endsWith(".md") && deeper.length === 0) {
    return "file";
  }
  let kind: "folder" | null = null;
  for (const container of MAP_CONTAINERS) {
    if (!container.segments.every((name, index) => segments[index] === name)) continue;
    const [effort, entry, ticket, ...rest] = segments.slice(container.segments.length);
    if (rest.length > 0) continue;
    if (effort === undefined || entry === undefined) {
      kind = "folder";
    } else if (ticket === undefined) {
      if (entry === "map.md") return "file";
      if (entry === container.tickets) kind = "folder";
    } else if (entry === container.tickets && ticket.endsWith(".md")) {
      return "file";
    }
  }
  return kind;
}

/**
 * Whether a watch event can change a snapshot. A folder only matters when it appears, goes or
 * is renamed: its `change` events are timestamp updates from the files inside, which arrive
 * with their own names.
 */
export function isWayfinderMapChange(event: "rename" | "change", relativePath: string): boolean {
  const kind = wayfinderPathKind(relativePath);
  return kind === "file" || (kind === "folder" && event === "rename");
}

const rootLayer = (workspaceRoot: string) =>
  Layer.effect(
    WayfinderMapsRoot,
    Effect.gen(function* () {
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
          .filter(
            (entry) =>
              wayfinderPathKind(path.join(candidate.ticketsRelativePath, entry)) === "file",
          )
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
      const runningScanRef = yield* Ref.make(Option.none<ScanDeferred>());
      const lastScanStartRef = yield* Ref.make(Option.none<number>());
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
      // slot and stamps the start only once it holds a global permit and starts scanning, so
      // requests arriving during the throttle or permit wait join it, requests arriving during
      // the scan queue exactly one more, and that one waits a full interval from this start.
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
          yield* scanGate.withPermits(1)(
            Effect.gen(function* () {
              yield* Ref.set(runningScanRef, yield* Ref.getAndSet(pendingScanRef, Option.none()));
              yield* Ref.set(lastScanStartRef, Option.some(yield* Clock.currentTimeMillis));
              yield* scanAndPublish.pipe(Effect.ensuring(Ref.set(runningScanRef, Option.none())));
            }),
          );
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

      // A root's first subscribers share its first scan: one arriving while it runs waits
      // for it rather than queueing another scan a full interval later.
      const latestSnapshot = Effect.gen(function* () {
        if (Option.isNone(yield* Ref.get(snapshotRef))) {
          const running = yield* Ref.get(runningScanRef);
          yield* Option.isSome(running) ? Deferred.await(running.value) : requestScan;
        }
        return yield* Ref.get(snapshotRef).pipe(Effect.map(Option.getOrThrow));
      });

      // Recursive on `.plan` and `.scratch` so a change to any ticket or map below them is
      // seen; the workspace root is watched without recursion because it holds node_modules
      // and .git. Every event is filtered by `wayfinderPathKind` before anything else runs.
      const watchSpecs: ReadonlyArray<WatchSpec> = [
        {
          relativePath: planTarget.relativePath,
          resolve: files.resolveDirectory(planTarget.relativePath, { quiet: true }),
          recursive: true,
        },
        {
          relativePath: scratchTarget.relativePath,
          resolve: files.resolveDirectory(scratchTarget.relativePath, { quiet: true }),
          recursive: true,
        },
        { relativePath: "", resolve: Effect.succeed(workspaceRoot), recursive: false },
      ];

      // The root's whole pending watch state: one slot, full when a relevant change has been
      // seen since the last scan was requested. Further events while it is full are dropped.
      const changed = yield* Queue.dropping<void>(1);
      const noteChange = (spec: WatchSpec) => (event: "rename" | "change", name: string) => {
        if (isWayfinderMapChange(event, path.join(spec.relativePath, name))) {
          Queue.offerUnsafe(changed, undefined);
        }
      };

      /**
       * Keeps one watch alive, re-arming it when its directory appears or the watch fails.
       * `armed` completes once the first attempt has either armed it or found nothing to watch.
       */
      const superviseWatcher = (spec: WatchSpec, armed: Deferred.Deferred<void>) => {
        // After the first attempt, a new watch may have missed changes and must be followed
        // by a scan. The first one precedes the root's first scan.
        let missedChanges = false;
        const attempt = Effect.gen(function* () {
          const directory = yield* spec.resolve;
          if (directory === null) {
            missedChanges = true;
            return;
          }
          yield* Effect.scoped(
            Effect.gen(function* () {
              const closed = yield* watchDirectory(directory, spec.recursive, noteChange(spec));
              yield* Deferred.succeed(armed, undefined);
              if (missedChanges) {
                yield* requestScan;
              }
              missedChanges = true;
              yield* Deferred.await(closed);
            }),
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("Wayfinder watcher stopped; re-arming", {
                  cause,
                  relativePath: spec.relativePath,
                }),
          ),
        );
        return Effect.forever(
          attempt.pipe(
            Effect.andThen(Deferred.succeed(armed, undefined)),
            Effect.andThen(Effect.sleep(WAYFINDER_MAPS_BOOTSTRAP_PROBE_INTERVAL)),
          ),
        );
      };

      // Turns the slot into scans: wait out the debounce so a burst of writes lands in one
      // scan, empty the slot, scan. Changes during the scan refill the slot for the next one.
      const scanOnChange = Effect.forever(
        Queue.take(changed).pipe(
          Effect.andThen(Effect.sleep(tuning.watchDebounce)),
          Effect.andThen(Queue.clear(changed)),
          Effect.andThen(requestScan),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("Wayfinder change scan failed", { cause }),
          ),
        ),
      );

      // The root is built only once each watch has had its first attempt, so every subscriber
      // and refresh reaches a root whose watches already exist and no change can fall between
      // a watch and the first scan. Watch events turn into scans only from then on as well.
      const armed = yield* Effect.forEach(watchSpecs, (spec) =>
        Effect.gen(function* () {
          const specArmed = yield* Deferred.make<void>();
          yield* superviseWatcher(spec, specArmed).pipe(Effect.forkIn(watcherScope));
          return specArmed;
        }),
      );
      yield* Effect.forEach(armed, Deferred.await, { discard: true });
      yield* scanOnChange.pipe(Effect.forkIn(watcherScope));

      const stream: WayfinderMapsRootService["stream"] = Stream.unwrap(
        Effect.gen(function* () {
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
    readonly stream: (cwd: string) => Stream.Stream<WayfinderMapsSnapshot, WayfinderMapsError>;
  }
>()("t3/wayfinder/WayfinderMaps") {}

export const make = Effect.gen(function* () {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const maps = yield* WayfinderMapsMap;
  const admission = yield* Semaphore.make(1);

  // Roots are keyed by real path, so every spelling of one folder (letter case, a link to
  // it) shares one set of watches, one throttle and one scan. A path that cannot be resolved
  // (missing, or `~`) goes to `normalizeWorkspaceRoot` as given, which expands or reports it.
  const rootKey = (cwd: string) =>
    resolveRealRoot(cwd).pipe(
      Effect.orElseSucceed(() => cwd),
      Effect.flatMap((root) => workspacePaths.normalizeWorkspaceRoot(root)),
    );

  /** A root that is live or can still be admitted under the live-root cap. */
  const acquireRoot = (workspaceRoot: string) =>
    admission.withPermits(1)(
      Effect.gen(function* () {
        const live = Array.from(yield* RcMap.keys(maps.rcMap));
        if (!live.includes(workspaceRoot) && live.length >= WAYFINDER_MAPS_MAX_LIVE_ROOTS) {
          return yield* new WayfinderMapsCapacityError({
            message: `This server is already showing maps for ${WAYFINDER_MAPS_MAX_LIVE_ROOTS} folders. Close some map panels and try again in a minute.`,
          });
        }
        return yield* maps.contextEffect(workspaceRoot);
      }),
    );

  // A refresh only rescans a root that is live: with nobody subscribed there is nothing to
  // update, so it never creates a root.
  const refresh: WayfinderMaps["Service"]["refresh"] = Effect.fn("WayfinderMaps.refresh")(
    function* (cwd) {
      const context = yield* maps.contextEffectOption(yield* rootKey(cwd));
      if (Option.isSome(context)) {
        yield* Context.get(context.value, WayfinderMapsRoot).refresh;
      }
    },
    Effect.scoped,
  );

  const stream: WayfinderMaps["Service"]["stream"] = (cwd) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const context = yield* acquireRoot(yield* rootKey(cwd));
        return Context.get(context, WayfinderMapsRoot).stream;
      }),
    );

  return WayfinderMaps.of({ refresh, stream });
});

export const layer = Layer.effect(WayfinderMaps, make).pipe(Layer.provide(WayfinderMapsMap.layer));
