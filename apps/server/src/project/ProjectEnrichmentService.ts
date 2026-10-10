import type {
  ProjectId,
  ProjectWorkspaceFolder,
  RepositoryIdentity,
  WorkspaceFileStatus,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import { describeRemoteFolder } from "./workspaceFileDefinition.ts";
import * as WorkspaceFolderResolver from "./WorkspaceFolderResolver.ts";

const DEFAULT_CACHE_CAPACITY = 512;
const DEFAULT_MAX_PENDING = 512;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_SUCCESS_TTL = Duration.minutes(1);
const DEFAULT_FAILURE_TTL = Duration.seconds(5);
const FOLDER_PROBE_CONCURRENCY = 4;

export interface ProjectEnrichment {
  readonly repositoryIdentity: RepositoryIdentity | null;
  readonly faviconPath: string | null;
  /** True when identity resolution completed successfully, including cached null. */
  readonly repositoryIdentityResolved: boolean;
}

export interface ProjectEnrichmentChange {
  readonly workspaceRoot: string;
  readonly enrichment: ProjectEnrichment;
  readonly repositoryIdentityResolved: boolean;
}

export interface ProjectEnrichmentServiceOptions {
  readonly cacheCapacity?: number;
  /** Maximum active and queued roots for each enrichment field. */
  readonly maxPending?: number;
  /** Worker concurrency for each enrichment field. */
  readonly concurrency?: number;
  readonly successTtl?: Duration.Input;
  readonly failureTtl?: Duration.Input;
}

export class ProjectEnrichmentService extends Context.Service<
  ProjectEnrichmentService,
  {
    /** Read resolved metadata without starting or awaiting filesystem work. */
    readonly peek: (workspaceRoot: string) => Effect.Effect<ProjectEnrichment>;
    /** Schedule missing metadata for bounded background resolution. */
    readonly request: (workspaceRoot: string) => Effect.Effect<void>;
    /** Read immediately available metadata and schedule anything missing. */
    readonly getAvailable: (workspaceRoot: string) => Effect.Effect<ProjectEnrichment>;
    /**
     * Probe workspace folders now, at most 4 at a time: availability, and the
     * git checkout of each available one. Admission reads this, never the
     * cache, which these results refresh.
     */
    readonly probeFolders: (
      paths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<WorkspaceFolderResolver.WorkspaceFolderProbe>>;
    /**
     * A linked project's folders with their cached availability and git facts.
     * Facts not probed yet stay absent and resolve in the background.
     */
    readonly getAvailableFolders: (
      folders: ReadonlyArray<ProjectWorkspaceFolder>,
    ) => Effect.Effect<ReadonlyArray<ProjectWorkspaceFolder>>;
    /** A linked project's workspace-file sync health; undefined until its file is read. */
    readonly getWorkspaceFileStatus: (
      projectId: ProjectId,
    ) => Effect.Effect<WorkspaceFileStatus | undefined>;
    /** Record a linked project's sync health, or forget it with undefined. */
    readonly setWorkspaceFileStatus: (
      projectId: ProjectId,
      status: WorkspaceFileStatus | undefined,
    ) => Effect.Effect<void>;
    /** Invalidate workspace-derived metadata. */
    readonly invalidate: (workspaceRoots: Iterable<string>) => Effect.Effect<void>;
    /** Subscribe to ephemeral completion notifications. */
    readonly subscribeChanges: Effect.Effect<
      PubSub.Subscription<ProjectEnrichmentChange>,
      never,
      Scope.Scope
    >;
  }
>()("t3/project/ProjectEnrichmentService") {}

function availableValue<A, E>(cached: Option.Option<Exit.Exit<A, E>>): A | null {
  return Option.match(cached, {
    onNone: () => null,
    onSome: (exit) =>
      Exit.match(exit, {
        onFailure: () => null,
        onSuccess: (value) => value,
      }),
  });
}

function isSuccessfullyResolved<A, E>(cached: Option.Option<Exit.Exit<A, E>>): boolean {
  return Option.match(cached, {
    onNone: () => false,
    onSome: (exit) => Exit.isSuccess(exit),
  });
}

type EnrichmentField = "repositoryIdentity" | "faviconPath" | "workspaceFolder";

interface EnrichmentWorkLane {
  readonly pendingRoots: Ref.Ref<ReadonlySet<string>>;
  readonly queue: Queue.Queue<string>;
}

export const make = Effect.fn("ProjectEnrichmentService.make")(function* (
  options: ProjectEnrichmentServiceOptions = {},
) {
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const faviconResolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
  const folderResolver = yield* WorkspaceFolderResolver.WorkspaceFolderResolver;
  const cacheCapacity = Math.max(1, options.cacheCapacity ?? DEFAULT_CACHE_CAPACITY);
  const maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const successTtl = options.successTtl ?? DEFAULT_SUCCESS_TTL;
  const failureTtl = options.failureTtl ?? DEFAULT_FAILURE_TTL;

  const repositoryIdentityCache = yield* Cache.makeWith(
    (workspaceRoot: string) => Effect.exit(repositoryIdentityResolver.resolve(workspaceRoot)),
    {
      capacity: cacheCapacity,
      timeToLive: Exit.match({
        onFailure: () => failureTtl,
        onSuccess: (result) => (Exit.isSuccess(result) ? successTtl : failureTtl),
      }),
    },
  );
  const faviconCache = yield* Cache.makeWith(
    (workspaceRoot: string) => Effect.exit(faviconResolver.resolvePath(workspaceRoot)),
    {
      capacity: cacheCapacity,
      timeToLive: Exit.match({
        onFailure: () => failureTtl,
        onSuccess: (result) => (Exit.isSuccess(result) ? successTtl : failureTtl),
      }),
    },
  );
  // Display facts for workspace folders, keyed by folder path. A probe never fails.
  const folderCache = yield* Cache.makeWith(
    (path: string) => folderResolver.probe(path, { vcs: true }),
    { capacity: cacheCapacity, timeToLive: () => successTtl },
  );
  const makeWorkLane = Effect.gen(function* () {
    const pendingRoots = yield* Ref.make<ReadonlySet<string>>(new Set());
    const queue = yield* Effect.acquireRelease(Queue.dropping<string>(maxPending), (queue) =>
      Queue.shutdown(queue),
    );
    return { pendingRoots, queue } satisfies EnrichmentWorkLane;
  });
  const repositoryIdentityLane = yield* makeWorkLane;
  const faviconLane = yield* makeWorkLane;
  const folderLane = yield* makeWorkLane;
  // Linked projects' workspace-file health, by project. It is never an event,
  // so a restart derives it again.
  const workspaceFileStatuses = yield* Ref.make<ReadonlyMap<ProjectId, WorkspaceFileStatus>>(
    new Map(),
  );
  const changes = yield* Effect.acquireRelease(
    PubSub.sliding<ProjectEnrichmentChange>(256),
    (pubsub) => PubSub.shutdown(pubsub),
  );

  const removePending = (lane: EnrichmentWorkLane, workspaceRoot: string) =>
    Ref.update(lane.pendingRoots, (current) => {
      if (!current.has(workspaceRoot)) return current;
      const next = new Set(current);
      next.delete(workspaceRoot);
      return next;
    });

  const reservePending = (lane: EnrichmentWorkLane, workspaceRoot: string) =>
    Ref.modify(lane.pendingRoots, (current) => {
      if (current.has(workspaceRoot) || current.size >= maxPending) {
        return [false, current] as const;
      }
      const next = new Set(current);
      next.add(workspaceRoot);
      return [true, next] as const;
    });

  const logFailure = <A, E>(
    workspaceRoot: string,
    field: EnrichmentField,
    result: Exit.Exit<A, E>,
  ) =>
    Exit.isFailure(result)
      ? Effect.logWarning("Failed to enrich optional project metadata", {
          workspaceRoot,
          field,
          cause: Cause.pretty(result.cause),
        })
      : Effect.void;

  const resolveRepositoryIdentity = Effect.fn("ProjectEnrichmentService.resolveRepositoryIdentity")(
    function* (workspaceRoot: string) {
      const repositoryIdentity = yield* Cache.get(repositoryIdentityCache, workspaceRoot);
      yield* logFailure(workspaceRoot, "repositoryIdentity", repositoryIdentity);
      const faviconPath = yield* Cache.getSuccess(faviconCache, workspaceRoot);
      const repositoryIdentityResolved = Exit.isSuccess(repositoryIdentity);
      yield* PubSub.publish(changes, {
        workspaceRoot,
        repositoryIdentityResolved,
        enrichment: {
          repositoryIdentity: availableValue(Option.some(repositoryIdentity)),
          faviconPath: availableValue(faviconPath),
          repositoryIdentityResolved,
        },
      });
    },
  );

  const resolveFavicon = Effect.fn("ProjectEnrichmentService.resolveFavicon")(function* (
    workspaceRoot: string,
  ) {
    const faviconPath = yield* Cache.get(faviconCache, workspaceRoot);
    yield* logFailure(workspaceRoot, "faviconPath", faviconPath);
  });

  const startWorkers = (
    lane: EnrichmentWorkLane,
    resolve: (workspaceRoot: string) => Effect.Effect<void>,
  ) => {
    const worker = Queue.take(lane.queue).pipe(
      Effect.flatMap((workspaceRoot) =>
        resolve(workspaceRoot).pipe(Effect.ensuring(removePending(lane, workspaceRoot))),
      ),
      Effect.forever,
    );
    return Effect.forEach(Array.from({ length: concurrency }), () => Effect.forkScoped(worker), {
      discard: true,
    });
  };
  yield* Effect.all(
    [
      startWorkers(repositoryIdentityLane, resolveRepositoryIdentity),
      startWorkers(faviconLane, resolveFavicon),
      startWorkers(folderLane, (path) => Cache.get(folderCache, path).pipe(Effect.asVoid)),
    ],
    { concurrency: "unbounded", discard: true },
  );

  const requestLane = Effect.fn("ProjectEnrichmentService.requestLane")(function* (
    lane: EnrichmentWorkLane,
    workspaceRoot: string,
    field: EnrichmentField,
  ) {
    if (!(yield* reservePending(lane, workspaceRoot))) return;
    if (!(yield* Queue.offer(lane.queue, workspaceRoot))) {
      yield* removePending(lane, workspaceRoot);
      yield* Effect.logWarning("Project metadata enrichment queue is full", {
        workspaceRoot,
        field,
      });
    }
  });

  const peek: ProjectEnrichmentService["Service"]["peek"] = Effect.fn(
    "ProjectEnrichmentService.peek",
  )(function* (workspaceRoot) {
    const [repositoryIdentity, faviconPath] = yield* Effect.all(
      [
        Cache.getSuccess(repositoryIdentityCache, workspaceRoot),
        Cache.getSuccess(faviconCache, workspaceRoot),
      ] as const,
      { concurrency: "unbounded" },
    );
    return {
      repositoryIdentity: availableValue(repositoryIdentity),
      faviconPath: availableValue(faviconPath),
      repositoryIdentityResolved: isSuccessfullyResolved(repositoryIdentity),
    };
  });

  const request: ProjectEnrichmentService["Service"]["request"] = Effect.fn(
    "ProjectEnrichmentService.request",
  )(function* (workspaceRoot) {
    const [hasRepositoryIdentity, hasFaviconPath] = yield* Effect.all(
      [Cache.has(repositoryIdentityCache, workspaceRoot), Cache.has(faviconCache, workspaceRoot)],
      { concurrency: "unbounded" },
    );
    yield* Effect.all(
      [
        hasRepositoryIdentity
          ? Effect.void
          : requestLane(repositoryIdentityLane, workspaceRoot, "repositoryIdentity"),
        hasFaviconPath ? Effect.void : requestLane(faviconLane, workspaceRoot, "faviconPath"),
      ],
      { concurrency: "unbounded", discard: true },
    );
  });

  const getAvailable: ProjectEnrichmentService["Service"]["getAvailable"] = Effect.fn(
    "ProjectEnrichmentService.getAvailable",
  )(function* (workspaceRoot) {
    const available = yield* peek(workspaceRoot);
    yield* request(workspaceRoot);
    return available;
  });

  const probeFolders: ProjectEnrichmentService["Service"]["probeFolders"] = Effect.fn(
    "ProjectEnrichmentService.probeFolders",
  )(function* (paths) {
    const probes = new Map(
      yield* Effect.forEach(
        new Set(paths),
        (path) =>
          folderResolver.probe(path, { vcs: true }).pipe(
            Effect.tap((probe) => Cache.set(folderCache, path, probe)),
            Effect.map((probe) => [path, probe] as const),
          ),
        { concurrency: FOLDER_PROBE_CONCURRENCY },
      ),
    );
    return paths.map((path) => probes.get(path)!);
  });

  // A folder's own repository identity, cached by folder path like a root's.
  const availableRepositoryIdentity = Effect.fn(
    "ProjectEnrichmentService.availableRepositoryIdentity",
  )(function* (path: string) {
    const cached = yield* Cache.getSuccess(repositoryIdentityCache, path);
    if (isSuccessfullyResolved(cached)) return availableValue(cached);
    yield* requestLane(repositoryIdentityLane, path, "repositoryIdentity");
    return undefined;
  });

  const getAvailableFolders: ProjectEnrichmentService["Service"]["getAvailableFolders"] = Effect.fn(
    "ProjectEnrichmentService.getAvailableFolders",
  )(function* (folders) {
    return yield* Effect.forEach(folders, (folder, index) =>
      Effect.gen(function* (): Effect.fn.Return<ProjectWorkspaceFolder> {
        if (folder.path === undefined) {
          const remoteDescription =
            folder.uri === undefined ? undefined : describeRemoteFolder(folder.uri);
          return {
            ...folder,
            availability: "unavailable",
            unavailableReason: "remote",
            ...(remoteDescription === undefined ? {} : { remoteDescription }),
          };
        }
        const cached = yield* Cache.getSuccess(folderCache, folder.path);
        if (Option.isNone(cached)) {
          yield* requestLane(folderLane, folder.path, "workspaceFolder");
          return folder;
        }
        const probe = cached.value;
        if (probe.availability === "unavailable") {
          return {
            ...folder,
            availability: "unavailable",
            ...(probe.unavailableReason === undefined
              ? {}
              : { unavailableReason: probe.unavailableReason }),
          };
        }
        if (probe.vcs == null) {
          return {
            ...folder,
            availability: "available",
            ...(probe.vcs === null ? { vcs: null } : {}),
          };
        }
        // The primary's identity is the project's own `repositoryIdentity`.
        const repositoryIdentity =
          index === 0 ? undefined : yield* availableRepositoryIdentity(folder.path);
        return {
          ...folder,
          availability: "available",
          vcs: {
            checkoutRoot: probe.vcs.checkoutRoot,
            ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
          },
        };
      }),
    );
  });

  const getWorkspaceFileStatus: ProjectEnrichmentService["Service"]["getWorkspaceFileStatus"] = (
    projectId,
  ) => Ref.get(workspaceFileStatuses).pipe(Effect.map((statuses) => statuses.get(projectId)));

  const setWorkspaceFileStatus: ProjectEnrichmentService["Service"]["setWorkspaceFileStatus"] = (
    projectId,
    status,
  ) =>
    Ref.update(workspaceFileStatuses, (current) => {
      const next = new Map(current);
      if (status === undefined) next.delete(projectId);
      else next.set(projectId, status);
      return next;
    });

  const invalidate: ProjectEnrichmentService["Service"]["invalidate"] = Effect.fn(
    "ProjectEnrichmentService.invalidate",
  )(function* (workspaceRoots) {
    yield* Effect.forEach(
      new Set(workspaceRoots),
      (workspaceRoot) =>
        Effect.all(
          [
            Cache.invalidate(repositoryIdentityCache, workspaceRoot),
            Cache.invalidate(faviconCache, workspaceRoot),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      { discard: true },
    );
  });

  return ProjectEnrichmentService.of({
    peek,
    request,
    getAvailable,
    probeFolders,
    getAvailableFolders,
    getWorkspaceFileStatus,
    setWorkspaceFileStatus,
    invalidate,
    subscribeChanges: PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(ProjectEnrichmentService, make());
