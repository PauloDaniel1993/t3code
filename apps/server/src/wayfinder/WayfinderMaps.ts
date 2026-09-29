import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import type { PlatformError } from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Path from "effect/Path";

import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
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
export const WAYFINDER_MAPS_DEFAULT_BOOTSTRAP_PROBE_INTERVAL = Duration.seconds(1);
export const WAYFINDER_MAPS_IDLE_TIME_TO_LIVE = "1 minute";

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
  readonly stream: (options?: WayfinderMapsStreamOptions) => Stream.Stream<WayfinderMapsSnapshot>;
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

const rootLayer = (workspaceRoot: string) =>
  Layer.effect(
    WayfinderMapsRoot,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

      const resolveRelativePath = (relativePath: string) =>
        workspacePaths.resolveRelativePathWithinRoot({ workspaceRoot, relativePath });

      const planTarget = yield* resolveRelativePath(".plan");
      const planMapsTarget = yield* resolveRelativePath(path.join(".plan", "maps"));
      const scratchTarget = yield* resolveRelativePath(".scratch");
      const rootMapTarget = yield* resolveRelativePath("wayfinder-map.md");

      const logProbeFailure = (operation: string, relativePath: string, cause: PlatformError) =>
        Effect.logWarning("Wayfinder filesystem probe failed", {
          operation,
          relativePath,
          reason: cause.reason._tag,
        });

      const readDirectory = Effect.fn("WayfinderMaps.readDirectory")(function* (
        relativePath: string,
      ) {
        const target = yield* resolveRelativePath(relativePath);
        return yield* fileSystem
          .readDirectory(target.absolutePath)
          .pipe(
            Effect.catch((cause) =>
              cause.reason._tag === "NotFound"
                ? Effect.succeed([])
                : logProbeFailure("read-directory", target.relativePath, cause).pipe(
                    Effect.as<Array<string>>([]),
                  ),
            ),
          );
      });

      const statFile = Effect.fn("WayfinderMaps.statFile")(function* (relativePath: string) {
        const target = yield* resolveRelativePath(relativePath);
        return yield* fileSystem.stat(target.absolutePath).pipe(
          Effect.matchEffect({
            onFailure: (cause) =>
              cause.reason._tag === "NotFound"
                ? Effect.succeed(false)
                : logProbeFailure("stat", target.relativePath, cause).pipe(Effect.as(false)),
            onSuccess: (info) => Effect.succeed(info.type === "File"),
          }),
        );
      });

      const readBounded = Effect.fn("WayfinderMaps.readBounded")(function* (
        relativePath: string,
        byteLimit: number,
      ): Effect.fn.Return<
        WayfinderMarkdownFile | null,
        WorkspacePaths.WorkspacePathOutsideRootError
      > {
        const target = yield* resolveRelativePath(relativePath);
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.open(target.absolutePath, { flag: "r" });
            const info = yield* file.stat;
            if (info.type !== "File") {
              return null;
            }
            const truncated = info.size > BigInt(byteLimit);
            const bytesToRead = truncated ? byteLimit : Number(info.size);
            if (bytesToRead === 0) {
              return { relativePath: target.relativePath, contents: "", truncated: false };
            }
            const buffer = new Uint8Array(bytesToRead);
            const bytesRead = Number(yield* file.read(buffer));
            return {
              relativePath: target.relativePath,
              contents: new TextDecoder("utf-8").decode(buffer.subarray(0, bytesRead)),
              truncated,
            };
          }).pipe(
            Effect.catch((cause) =>
              cause.reason._tag === "NotFound"
                ? Effect.succeed(null)
                : logProbeFailure("bounded-read", target.relativePath, cause).pipe(
                    Effect.as<WayfinderMarkdownFile | null>(null),
                  ),
            ),
          ),
        );
      });

      const discoverCandidates = Effect.fn("WayfinderMaps.discoverCandidates")(function* () {
        const [planMapsEntries, planEntries, scratchEntries, rootMapExists] = yield* Effect.all(
          [
            readDirectory(planMapsTarget.relativePath),
            readDirectory(planTarget.relativePath),
            readDirectory(scratchTarget.relativePath),
            statFile(rootMapTarget.relativePath),
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
        addDirectoryCandidates(planMapsTarget.relativePath, planMapsEntries, "tickets", "maps");
        addDirectoryCandidates(planTarget.relativePath, planEntries, "tickets");
        addDirectoryCandidates(scratchTarget.relativePath, scratchEntries, "issues", "scratch");
        if (rootMapExists) {
          candidates.set(rootMapTarget.relativePath, {
            id: "wayfinder-map",
            mapRelativePath: rootMapTarget.relativePath,
            ticketsRelativePath: path.join(planTarget.relativePath, "tickets"),
          });
        }
        return [...candidates.values()].toSorted((left, right) =>
          left.mapRelativePath.localeCompare(right.mapRelativePath),
        );
      });

      const loadTickets = Effect.fn("WayfinderMaps.loadTickets")(function* (
        candidate: MapCandidate,
        remainingNodeCapacity: number,
      ) {
        const ticketEntries = (yield* readDirectory(candidate.ticketsRelativePath))
          .filter((entry) => entry.toLowerCase().endsWith(".md"))
          .toSorted((left, right) => left.localeCompare(right));
        const perMapEntries = ticketEntries.slice(0, WAYFINDER_MAPS_MAX_TICKETS_PER_MAP);
        const selectedEntries = perMapEntries.slice(0, remainingNodeCapacity);
        const totalNodeCapReached = perMapEntries.length > selectedEntries.length;
        const truncated = ticketEntries.length > selectedEntries.length;
        const tickets = (yield* Effect.all(
          selectedEntries.map((entry) =>
            readBounded(
              path.join(candidate.ticketsRelativePath, entry),
              WAYFINDER_MAPS_MAX_TICKET_BYTES,
            ),
          ),
          { concurrency: 16 },
        )).filter((ticket): ticket is WayfinderMarkdownFile => ticket !== null);
        return { tickets, truncated, totalNodeCapReached };
      });

      const discoverSnapshot = Effect.fn("WayfinderMaps.discoverSnapshot")(function* () {
        const candidates = yield* discoverCandidates();
        const sources: Array<WayfinderMapSource> = [];
        let totalNodes = 0;
        let snapshotTruncated = false;

        for (const candidate of candidates) {
          const map = yield* readBounded(candidate.mapRelativePath, WAYFINDER_MAPS_MAX_MAP_BYTES);
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

      const initialSnapshot = yield* discoverSnapshot();
      const snapshotRef = yield* Ref.make(initialSnapshot);
      const fingerprintRef = yield* Ref.make(snapshotFingerprint(initialSnapshot));
      const changes = yield* PubSub.sliding<WayfinderMapsSnapshot>(1);
      const refreshMutex = yield* Semaphore.make(1);
      const watcherStartedRef = yield* Ref.make(false);
      const watcherScope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() =>
        Scope.close(watcherScope, Exit.void).pipe(Effect.andThen(PubSub.shutdown(changes))),
      );

      const refresh = refreshMutex.withPermits(1)(
        Effect.gen(function* () {
          const snapshot = yield* discoverSnapshot();
          const fingerprint = snapshotFingerprint(snapshot);
          const changed = yield* Ref.modify(fingerprintRef, (previous) => [
            previous !== fingerprint,
            fingerprint,
          ]);
          if (!changed) {
            return;
          }
          yield* Ref.set(snapshotRef, snapshot);
          yield* PubSub.publish(changes, snapshot);
        }),
      );

      const watchTargets = [planTarget, scratchTarget] as const;

      const directoryExists = (target: (typeof watchTargets)[number]) =>
        fileSystem.stat(target.absolutePath).pipe(
          Effect.matchEffect({
            onFailure: (cause) =>
              cause.reason._tag === "NotFound"
                ? Effect.succeed(false)
                : logProbeFailure("stat", target.relativePath, cause).pipe(Effect.as(false)),
            onSuccess: (info) => Effect.succeed(info.type === "Directory"),
          }),
        );

      const runWatcher = Effect.fn("WayfinderMaps.runWatcher")(function* (
        target: (typeof watchTargets)[number],
      ) {
        // NodeFileSystem always watches recursively. Watching the workspace root would
        // recurse through node_modules and .git and can exhaust fs.inotify.max_user_watches
        // on Linux, so this service must only ever watch the bounded .plan and .scratch
        // subtrees with one independently supervised watcher per directory.
        const watchRefreshes = fileSystem.watch(target.absolutePath).pipe(
          Stream.debounce(Duration.millis(100)),
          Stream.runForEach(() => refresh),
        );
        yield* Effect.all([refresh, watchRefreshes], { concurrency: "unbounded", discard: true });
      });

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
        for (const target of watchTargets) {
          const waitForDirectory = Effect.gen(function* () {
            while (!(yield* directoryExists(target))) {
              yield* sleepUntilNextProbe;
            }
          });
          const superviseWatcher = Effect.forever(
            waitForDirectory.pipe(
              Effect.andThen(runWatcher(target)),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("Wayfinder watcher stopped; re-arming", {
                      cause,
                      relativePath: target.relativePath,
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
            const subscription = yield* subscribeBeforeSnapshot(
              changes,
              Ref.get(snapshotRef),
              refreshMutex,
            );
            return Stream.concat(Stream.make(subscription.latest), subscription.changes);
          }),
        );

      return WayfinderMapsRoot.of({ refresh, stream });
    }),
  );

export class WayfinderMapsMap extends LayerMap.Service<WayfinderMapsMap>()(
  "t3/wayfinder/WayfinderMapsMap",
  {
    lookup: rootLayer,
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
