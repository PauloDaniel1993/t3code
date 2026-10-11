import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointPart,
  OrchestrationV2CheckpointScope,
  type OrchestrationV2CheckpointScopePart,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import type { WorkspaceThread } from "@t3tools/shared/workspaceFolders";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import {
  checkpointFolderDiffs,
  collectCheckpointDiffs,
} from "../checkpointing/CheckpointFolderDiffs.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import {
  checkpointBarrierStatus,
  checkpointRestoreParts,
  checkpointScopeParts,
  PRIMARY_CHECKPOINT_PART_KEY,
} from "./CheckpointScopeParts.ts";
import * as IdAllocator from "./IdAllocator.ts";

const CHECKPOINT_REFS_PREFIX = "refs/t3/orchestration-v2/checkpoints";
const ROOT_CHECKPOINT_SCOPE_NAME = "root";

export class CheckpointRootScopePrepareError extends Schema.TaggedError<CheckpointRootScopePrepareError>()(
  "CheckpointRootScopePrepareError",
  {
    threadId: ThreadId,
    runId: RunId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prepare root checkpoint scope for run ${this.runId}.`;
  }
}

export class CheckpointScopeEnsureError extends Schema.TaggedError<CheckpointScopeEnsureError>()(
  "CheckpointScopeEnsureError",
  {
    scopeId: CheckpointScopeId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ensure checkpoint scope ${this.scopeId}.`;
  }
}

export class CheckpointBaselineCaptureError extends Schema.TaggedError<CheckpointBaselineCaptureError>()(
  "CheckpointBaselineCaptureError",
  {
    scopeId: CheckpointScopeId,
    ordinalWithinScope: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint baseline ${this.ordinalWithinScope} for scope ${this.scopeId}.`;
  }
}

export class CheckpointCaptureError extends Schema.TaggedError<CheckpointCaptureError>()(
  "CheckpointCaptureError",
  {
    scopeId: CheckpointScopeId,
    parentCheckpointId: Schema.optional(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint for scope ${this.scopeId}.`;
  }
}

export class CheckpointRestoreError extends Schema.TaggedError<CheckpointRestoreError>()(
  "CheckpointRestoreError",
  {
    scopeId: CheckpointScopeId,
    checkpointId: CheckpointId,
    /** Labels of the folders whose checkout was restored before another failed. */
    restoredFolders: Schema.optional(Schema.Array(Schema.String)),
    /** Labels of the folders whose checkout wasn't restored. */
    unrestoredFolders: Schema.optional(Schema.Array(Schema.String)),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to restore checkpoint ${this.checkpointId} for scope ${this.scopeId}.`;
  }
}

export class CheckpointDeleteStaleRefsError extends Schema.TaggedError<CheckpointDeleteStaleRefsError>()(
  "CheckpointDeleteStaleRefsError",
  {
    scopeId: CheckpointScopeId,
    checkpointIds: Schema.Array(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete stale checkpoint refs for scope ${this.scopeId}.`;
  }
}

export const CheckpointServiceV2Error = Schema.Union([
  CheckpointRootScopePrepareError,
  CheckpointScopeEnsureError,
  CheckpointBaselineCaptureError,
  CheckpointCaptureError,
  CheckpointRestoreError,
  CheckpointDeleteStaleRefsError,
]);
export type CheckpointServiceV2Error = typeof CheckpointServiceV2Error.Type;

const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);

/**
 * Why a turn's files can't be restored. Restore is all or nothing, so one part
 * refuses it all. `folders` are the labels of the parts at fault, empty for a
 * checkpoint without parts.
 */
export interface FileRestoreRefusal {
  readonly reason: "not-ready" | "missing-checkout" | "missing-ref" | "shared";
  readonly folders: ReadonlyArray<string>;
}

export interface CheckpointServiceV2Shape {
  readonly prepareRootRunScope: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly rootNodeId: NodeId;
    readonly providerThreadId: ProviderThreadId;
    readonly cwd: string;
    /** A thread with several snapshot folders gets one part per checkout. */
    readonly thread: WorkspaceThread;
    /** The run's record of snapshot folders it can't reach. */
    readonly unavailableFolderPaths?: ReadonlyArray<string> | undefined;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  readonly ensureScope: (
    scope: OrchestrationV2CheckpointScope,
  ) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  readonly captureBaseline: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  readonly materializeBaselineCheckpoint: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  readonly capture: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly runId: RunId | null;
    readonly nodeId: NodeId;
    readonly ordinalWithinScope: number;
    readonly appRunOrdinal: number | null;
    readonly capturedAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  /**
   * Whether every git part of `checkpoint` can be restored: ready, its
   * checkout present, and its ref there. Undefined when all can.
   */
  readonly preflightRestore: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoint: OrchestrationV2Checkpoint;
  }) => Effect.Effect<FileRestoreRefusal | undefined>;
  /**
   * Restores every git part's files in parallel; HEAD never moves. Restoring
   * again converges, and a failure names the folders restored and not.
   */
  readonly restore: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoint: OrchestrationV2Checkpoint;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  readonly deleteStaleRefs: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
}

export class CheckpointServiceV2 extends Context.Service<
  CheckpointServiceV2,
  CheckpointServiceV2Shape
>()("t3/orchestration-v2/CheckpointService/CheckpointServiceV2") {}

export function checkpointRefForScopeOrdinal(input: {
  readonly scopeId: CheckpointScopeId;
  readonly ordinalWithinScope: number;
  /** The part the ref holds. The primary part keeps the scope's own refs. */
  readonly partKey?: string;
}): CheckpointRef {
  const scopeKey = NodeCrypto.createHash("sha256").update(input.scopeId).digest("hex").slice(0, 32);
  const part =
    input.partKey === undefined || input.partKey === PRIMARY_CHECKPOINT_PART_KEY
      ? ""
      : `/part-${input.partKey}`;
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(scopeKey)}${part}/ordinal/${input.ordinalWithinScope}`,
  );
}

// A scope without parts checkpoints its whole cwd as its one primary part.
function scopeParts(
  scope: OrchestrationV2CheckpointScope,
): ReadonlyArray<OrchestrationV2CheckpointScopePart> {
  return (
    scope.parts ?? [
      {
        key: PRIMARY_CHECKPOINT_PART_KEY,
        cwd: scope.cwd,
        vcs: "git",
        pathspecs: ["."],
        folders: [],
      },
    ]
  );
}

function checkpointIdForScopeOrdinal(
  idAllocator: IdAllocator.IdAllocatorV2Shape,
  input: {
    readonly scopeId: CheckpointScopeId;
    readonly ordinalWithinScope: number;
  },
) {
  return idAllocator.allocate.checkpoint({
    checkpointScopeId: input.scopeId,
    name: String(input.ordinalWithinScope),
  });
}

function makeRootRunScope(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2Shape;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly cwd: string;
  readonly thread: WorkspaceThread;
  readonly unavailableFolderPaths?: ReadonlyArray<string> | undefined;
  readonly createdAt: DateTime.Utc;
}) {
  return Effect.gen(function* () {
    const scopeId = yield* input.idAllocator.allocate.checkpointScope({
      threadId: input.threadId,
      name: ROOT_CHECKPOINT_SCOPE_NAME,
    });
    const parts = checkpointScopeParts({
      thread: input.thread,
      unavailableFolderPaths: input.unavailableFolderPaths,
    });
    return {
      id: scopeId,
      threadId: input.threadId,
      runId: input.runId,
      nodeId: input.rootNodeId,
      parentScopeId: null,
      providerThreadId: input.providerThreadId,
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: parts?.[0]?.cwd ?? input.cwd,
      ...(parts === undefined ? {} : { parts }),
      createdAt: input.createdAt,
    } satisfies OrchestrationV2CheckpointScope;
  });
}

function makeCheckpoint(input: {
  readonly id: CheckpointId;
  readonly scope: OrchestrationV2CheckpointScope;
  readonly runId: RunId | null;
  readonly nodeId: NodeId;
  readonly parentCheckpointId: CheckpointId | null;
  readonly ordinalWithinScope: number;
  readonly appRunOrdinal: number | null;
  readonly parts: ReadonlyArray<OrchestrationV2CheckpointPart>;
  readonly files: OrchestrationV2Checkpoint["files"];
  readonly capturedAt: DateTime.Utc;
}): OrchestrationV2Checkpoint {
  return {
    id: input.id,
    threadId: input.scope.threadId,
    scopeId: input.scope.id,
    runId: input.runId,
    nodeId: input.nodeId,
    parentCheckpointId: input.parentCheckpointId,
    ordinalWithinScope: input.ordinalWithinScope,
    appRunOrdinal: input.appRunOrdinal,
    ref: checkpointRefForScopeOrdinal({
      scopeId: input.scope.id,
      ordinalWithinScope: input.ordinalWithinScope,
    }),
    status: checkpointBarrierStatus(input.parts),
    files: input.files,
    // The checkpoint keeps its own part table: the scope is rewritten every run.
    ...(input.scope.parts === undefined ? {} : { parts: input.parts }),
    capturedAt: input.capturedAt,
  };
}

// Parts are checkpointed in parallel, under the global git process cap.
const PART_CONCURRENCY = 4;

export const layer: Layer.Layer<
  CheckpointServiceV2,
  never,
  CheckpointStore.CheckpointStore | IdAllocator.IdAllocatorV2 | FileSystem.FileSystem
> = Layer.effect(
  CheckpointServiceV2,
  Effect.gen(function* () {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const checkoutSemaphores = yield* Ref.make(new Map<string, Semaphore.Semaphore>());

    const getCheckoutSemaphore = (key: string) =>
      Effect.gen(function* () {
        const existing = (yield* Ref.get(checkoutSemaphores)).get(key);
        if (existing !== undefined) {
          return existing;
        }

        const created = yield* Semaphore.make(1);
        return yield* Ref.modify(checkoutSemaphores, (current) => {
          const concurrent = current.get(key);
          if (concurrent !== undefined) {
            return [concurrent, current];
          }
          const updated = new Map(current);
          updated.set(key, created);
          return [created, updated];
        });
      });

    // One lock per checkout, whatever the spelling of its path. An operation
    // holds one part's lock at a time, so locks never wait on each other.
    const withCheckoutLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
      fileSystem.realPath(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
        Effect.map((path) => (isWindowsAbsolutePath(path) ? path.toLowerCase() : path)),
        Effect.flatMap(getCheckoutSemaphore),
        Effect.flatMap((semaphore) => semaphore.withPermits(1)(effect)),
      );

    const isGitCheckpointable = (cwd: string) =>
      checkpointStore.isGitRepository(cwd).pipe(Effect.orElseSucceed(() => false));

    const partRef = (
      scope: OrchestrationV2CheckpointScope,
      part: OrchestrationV2CheckpointScopePart,
      ordinalWithinScope: number,
    ) => checkpointRefForScopeOrdinal({ scopeId: scope.id, ordinalWithinScope, partKey: part.key });

    const ensureScope: CheckpointServiceV2Shape["ensureScope"] = (scope) => Effect.succeed(scope);

    const captureBaselinePart = (
      scope: OrchestrationV2CheckpointScope,
      part: OrchestrationV2CheckpointScopePart,
      ordinalWithinScope: number,
    ) =>
      withCheckoutLock(
        part.cwd,
        Effect.gen(function* () {
          if (!(yield* isGitCheckpointable(part.cwd))) {
            return;
          }

          const checkpointRef = partRef(scope, part, ordinalWithinScope);
          const exists = yield* checkpointStore.hasCheckpointRef({
            cwd: part.cwd,
            checkpointRef,
          });
          if (exists) {
            return;
          }

          yield* checkpointStore.captureCheckpoint({
            cwd: part.cwd,
            checkpointRef,
            pathspecs: part.pathspecs,
          });
        }),
      );

    // A part that joins mid-thread gets its baseline here too. One part's
    // failure doesn't stop the others.
    const captureBaseline: CheckpointServiceV2Shape["captureBaseline"] = (input) =>
      Effect.forEach(
        scopeParts(input.scope).filter((part) => part.vcs === "git"),
        (part) => Effect.result(captureBaselinePart(input.scope, part, input.ordinalWithinScope)),
        { concurrency: PART_CONCURRENCY },
      ).pipe(
        Effect.flatMap((results) => {
          const failed = results.find(Result.isFailure);
          return failed === undefined ? Effect.void : Effect.fail(failed.failure);
        }),
        Effect.mapError(
          (cause) =>
            new CheckpointBaselineCaptureError({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
              cause,
            }),
        ),
      );

    const materializeBaselinePart = (
      scope: OrchestrationV2CheckpointScope,
      part: OrchestrationV2CheckpointScopePart,
      ordinalWithinScope: number,
    ): Effect.Effect<OrchestrationV2CheckpointPart> => {
      if (part.vcs === null) {
        return Effect.succeed({ ...part, ref: null, status: "missing" });
      }
      const checkpointRef = partRef(scope, part, ordinalWithinScope);
      return withCheckoutLock(
        part.cwd,
        Effect.gen(function* () {
          const checkpointable = yield* isGitCheckpointable(part.cwd);
          const available = checkpointable
            ? yield* checkpointStore
                .hasCheckpointRef({
                  cwd: part.cwd,
                  checkpointRef,
                })
                .pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration V2 baseline ref lookup failed", {
                      scopeId: scope.id,
                      checkpointRef,
                      cause: String(cause),
                    }).pipe(Effect.as(false)),
                  ),
                )
            : false;
          return { ...part, ref: checkpointRef, status: available ? "ready" : "missing" } as const;
        }),
      );
    };

    const materializeBaselineCheckpoint: CheckpointServiceV2Shape["materializeBaselineCheckpoint"] =
      (input) =>
        Effect.gen(function* () {
          const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const parts = yield* Effect.forEach(
            scopeParts(input.scope),
            (part) => materializeBaselinePart(input.scope, part, input.ordinalWithinScope),
            { concurrency: PART_CONCURRENCY },
          );
          return makeCheckpoint({
            id: checkpointId,
            scope: input.scope,
            runId: null,
            nodeId: input.scope.nodeId,
            parentCheckpointId: null,
            ordinalWithinScope: input.ordinalWithinScope,
            appRunOrdinal: null,
            parts,
            files: [],
            capturedAt: input.scope.createdAt,
          });
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointCaptureError({
                scopeId: input.scope.id,
                cause,
              }),
          ),
        );

    // A part's failure becomes its status, never the run's. Legacy scopes also
    // summarize their files here; parts share one summary budget after capture.
    const capturePart = (
      scope: OrchestrationV2CheckpointScope,
      part: OrchestrationV2CheckpointScopePart,
      ordinalWithinScope: number,
    ): Effect.Effect<{
      readonly part: OrchestrationV2CheckpointPart;
      readonly files: OrchestrationV2Checkpoint["files"];
    }> => {
      if (part.vcs === null) {
        return Effect.succeed({ part: { ...part, ref: null, status: "missing" }, files: [] });
      }
      const checkpointRef = partRef(scope, part, ordinalWithinScope);
      const previousCheckpointRef = partRef(scope, part, Math.max(0, ordinalWithinScope - 1));
      return withCheckoutLock(
        part.cwd,
        Effect.gen(function* () {
          if (!(yield* isGitCheckpointable(part.cwd))) {
            return { part: { ...part, ref: checkpointRef, status: "missing" }, files: [] } as const;
          }

          const captured = yield* checkpointStore
            .captureCheckpoint({
              cwd: part.cwd,
              checkpointRef,
              pathspecs: part.pathspecs,
            })
            .pipe(
              Effect.as(true),
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 checkpoint capture failed", {
                  scopeId: scope.id,
                  checkpointRef,
                  cause: String(cause),
                }).pipe(Effect.as(false)),
              ),
            );

          if (!captured) {
            return { part: { ...part, ref: checkpointRef, status: "error" }, files: [] } as const;
          }
          if (scope.parts !== undefined) {
            return { part: { ...part, ref: checkpointRef, status: "ready" }, files: [] } as const;
          }

          const previousExists = yield* checkpointStore
            .hasCheckpointRef({
              cwd: part.cwd,
              checkpointRef: previousCheckpointRef,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 previous checkpoint ref lookup failed", {
                  scopeId: scope.id,
                  checkpointRef: previousCheckpointRef,
                  cause: String(cause),
                }).pipe(Effect.as(false)),
              ),
            );
          const files = previousExists
            ? yield* checkpointStore
                .diffCheckpoints({
                  cwd: part.cwd,
                  fromCheckpointRef: previousCheckpointRef,
                  toCheckpointRef: checkpointRef,
                  fallbackFromToHead: false,
                  ignoreWhitespace: false,
                  format: "numstat",
                })
                .pipe(
                  Effect.map((diff) =>
                    parseTurnDiffFilesFromNumstat(diff).map((file) => ({
                      path: file.path,
                      kind: "modified",
                      additions: file.additions,
                      deletions: file.deletions,
                    })),
                  ),
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration V2 checkpoint diff summary failed", {
                      scopeId: scope.id,
                      checkpointRef,
                      cause: String(cause),
                    }).pipe(Effect.as([])),
                  ),
                )
            : [];
          return { part: { ...part, ref: checkpointRef, status: "ready" }, files } as const;
        }),
      );
    };

    // Writes every part's ref. The caller's one `checkpoint.captured` event
    // then publishes them all at once.
    const capture: CheckpointServiceV2Shape["capture"] = (input) =>
      Effect.gen(function* () {
        const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
          scopeId: input.scope.id,
          ordinalWithinScope: input.ordinalWithinScope,
        });
        const parentCheckpointId =
          input.ordinalWithinScope > 0
            ? yield* checkpointIdForScopeOrdinal(idAllocator, {
                scopeId: input.scope.id,
                ordinalWithinScope: input.ordinalWithinScope - 1,
              })
            : null;
        const captured = yield* Effect.forEach(
          scopeParts(input.scope),
          (part) => capturePart(input.scope, part, input.ordinalWithinScope),
          { concurrency: PART_CONCURRENCY },
        );

        let files = captured.flatMap(({ files }) => files);
        if (input.scope.parts !== undefined) {
          const diffInputs: Array<CheckpointStore.DiffCheckpointsInput & { label: string }> = [];
          for (const { part } of captured) {
            if (part.vcs !== "git" || part.status !== "ready" || part.ref === null) continue;
            const previousCheckpointRef = partRef(
              input.scope,
              part,
              Math.max(0, input.ordinalWithinScope - 1),
            );
            const previousExists = yield* withCheckoutLock(
              part.cwd,
              checkpointStore.hasCheckpointRef({
                cwd: part.cwd,
                checkpointRef: previousCheckpointRef,
              }),
            ).pipe(Effect.catch(() => Effect.succeed(false)));
            if (!previousExists) continue;
            for (const folderDiff of checkpointFolderDiffs(part)) {
              diffInputs.push({
                cwd: part.cwd,
                fromCheckpointRef: previousCheckpointRef,
                toCheckpointRef: part.ref,
                fallbackFromToHead: false,
                ignoreWhitespace: false,
                format: "numstat",
                label: folderDiff.folder.label,
                relativePath: folderDiff.relativePath,
                pathspecs: folderDiff.pathspecs,
              });
            }
          }
          const diffs = yield* collectCheckpointDiffs(diffInputs, (diffInput) =>
            withCheckoutLock(diffInput.cwd, checkpointStore.diffCheckpoints(diffInput)).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 checkpoint diff summary failed", {
                  scopeId: input.scope.id,
                  checkpointRef: diffInput.toCheckpointRef,
                  cause: String(cause),
                }).pipe(Effect.as("")),
              ),
            ),
          );
          files = diffs.flatMap(({ label, diff }) =>
            parseTurnDiffFilesFromNumstat(diff).map((file) => ({
              path: `${label}/${file.path}`,
              kind: "modified" as const,
              additions: file.additions,
              deletions: file.deletions,
            })),
          );
        }

        return makeCheckpoint({
          id: checkpointId,
          scope: input.scope,
          runId: input.runId,
          nodeId: input.nodeId,
          parentCheckpointId,
          ordinalWithinScope: input.ordinalWithinScope,
          appRunOrdinal: input.appRunOrdinal,
          parts: captured.map(({ part }) => part),
          files,
          capturedAt: input.capturedAt,
        });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointCaptureError({
              scopeId: input.scope.id,
              cause,
            }),
        ),
      );

    const partLabels = (parts: ReadonlyArray<OrchestrationV2CheckpointPart>) =>
      parts.flatMap((part) => part.folders.map((folder) => folder.label));

    const preflightRestore: CheckpointServiceV2Shape["preflightRestore"] = (input) =>
      Effect.gen(function* () {
        const parts = checkpointRestoreParts(input.scope, input.checkpoint);
        const notReady = parts.filter((part) => part.status !== "ready" || part.ref === null);
        if (input.checkpoint.status !== "ready" || parts.length === 0 || notReady.length > 0) {
          return { reason: "not-ready", folders: partLabels(notReady) } as const;
        }
        const missing = yield* Effect.filter(
          parts,
          (part) =>
            fileSystem.exists(part.cwd).pipe(
              Effect.map((exists) => !exists),
              Effect.orElseSucceed(() => true),
            ),
          { concurrency: PART_CONCURRENCY },
        );
        if (missing.length > 0) {
          return { reason: "missing-checkout", folders: partLabels(missing) } as const;
        }
        const unresolved = yield* Effect.filter(
          parts,
          (part) =>
            part.ref === null
              ? Effect.succeed(true)
              : checkpointStore.hasCheckpointRef({ cwd: part.cwd, checkpointRef: part.ref }).pipe(
                  Effect.map((exists) => !exists),
                  Effect.orElseSucceed(() => true),
                ),
          { concurrency: PART_CONCURRENCY },
        );
        if (unresolved.length > 0) {
          return { reason: "missing-ref", folders: partLabels(unresolved) } as const;
        }
        return undefined;
      });

    // Each part holds its own checkout's lock, so parts restore in parallel.
    // Restore is idempotent, so a retry after a part failed converges.
    const restore: CheckpointServiceV2Shape["restore"] = (input) =>
      Effect.gen(function* () {
        const parts = checkpointRestoreParts(input.scope, input.checkpoint);
        if (input.checkpoint.status !== "ready") {
          return yield* new CheckpointRestoreError({
            scopeId: input.scope.id,
            checkpointId: input.checkpoint.id,
            restoredFolders: [],
            unrestoredFolders: partLabels(parts),
            cause: `Checkpoint status is ${input.checkpoint.status}.`,
          });
        }
        const results = yield* Effect.forEach(
          parts,
          (part) =>
            Effect.result(
              withCheckoutLock(
                part.cwd,
                Effect.gen(function* () {
                  if (part.status !== "ready" || part.ref === null) {
                    return yield* Effect.fail(`Checkpoint part status is ${part.status}.`);
                  }
                  const restored = yield* checkpointStore.restoreCheckpoint({
                    cwd: part.cwd,
                    checkpointRef: part.ref,
                    pathspecs: part.pathspecs,
                    fallbackToHead: false,
                  });
                  if (!restored) return yield* Effect.fail("Checkpoint ref is unavailable.");
                }),
              ).pipe(
                Effect.tapError((cause) =>
                  Effect.logWarning("orchestration V2 checkpoint part restore failed", {
                    scopeId: input.scope.id,
                    checkpointId: input.checkpoint.id,
                    cwd: part.cwd,
                    cause: String(cause),
                  }),
                ),
              ),
            ),
          { concurrency: PART_CONCURRENCY },
        );
        const failure = results.find(Result.isFailure);
        if (failure === undefined) return;
        return yield* new CheckpointRestoreError({
          scopeId: input.scope.id,
          checkpointId: input.checkpoint.id,
          restoredFolders: partLabels(
            parts.filter((_, index) => Result.isSuccess(results[index]!)),
          ),
          unrestoredFolders: partLabels(
            parts.filter((_, index) => Result.isFailure(results[index]!)),
          ),
          cause: failure.failure,
        });
      }).pipe(
        Effect.mapError((cause) =>
          isCheckpointRestoreError(cause)
            ? cause
            : new CheckpointRestoreError({
                scopeId: input.scope.id,
                checkpointId: input.checkpoint.id,
                cause,
              }),
        ),
      );

    // Each part's refs live in its own repository, reached through the part's
    // current checkout when the scope still has it. The primary part's refs are
    // deleted as before; another part's checkout may be gone, so those are best
    // effort. Only a ready part's ref was surely written, so a non-ready
    // checkpoint gives up just its healthy parts' refs.
    const deleteStaleRefs: CheckpointServiceV2Shape["deleteStaleRefs"] = (input) => {
      const current = scopeParts(input.scope);
      const refsByPart = new Map<
        string,
        { readonly cwd: string; readonly refs: CheckpointRef[] }
      >();
      for (const checkpoint of input.checkpoints) {
        const parts = checkpoint.parts ?? [
          {
            key: PRIMARY_CHECKPOINT_PART_KEY,
            cwd: input.scope.cwd,
            vcs: "git",
            ref: checkpoint.ref,
            status: checkpoint.status,
          },
        ];
        for (const part of parts) {
          if (part.vcs === null || part.ref === null || part.status !== "ready") continue;
          const group = refsByPart.get(part.key) ?? {
            cwd: current.find((candidate) => candidate.key === part.key)?.cwd ?? part.cwd,
            refs: [],
          };
          group.refs.push(part.ref);
          refsByPart.set(part.key, group);
        }
      }
      return Effect.forEach(
        [...refsByPart],
        ([key, { cwd, refs }]) => {
          const deleted = withCheckoutLock(
            cwd,
            checkpointStore.deleteCheckpointRefs({ cwd, checkpointRefs: refs }),
          );
          return key === PRIMARY_CHECKPOINT_PART_KEY
            ? deleted
            : deleted.pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("orchestration V2 stale checkpoint part refs kept", {
                    scopeId: input.scope.id,
                    cwd,
                    cause: String(cause),
                  }),
                ),
              );
        },
        { concurrency: PART_CONCURRENCY, discard: true },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointDeleteStaleRefsError({
              scopeId: input.scope.id,
              checkpointIds: input.checkpoints.map((checkpoint) => checkpoint.id),
              cause,
            }),
        ),
      );
    };

    return CheckpointServiceV2.of({
      prepareRootRunScope: (input) =>
        makeRootRunScope({ ...input, idAllocator }).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointRootScopePrepareError({
                threadId: input.threadId,
                runId: input.runId,
                cause,
              }),
          ),
        ),
      ensureScope,
      captureBaseline,
      materializeBaselineCheckpoint,
      capture,
      preflightRestore,
      restore,
      deleteStaleRefs,
    } satisfies CheckpointServiceV2Shape);
  }),
);
