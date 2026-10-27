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
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { isGitImport, parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
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
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

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

export const checkpointRefForScopeOrdinal = Effect.fn("checkpointRefForScopeOrdinal")(
  function* (input: {
    readonly scopeId: CheckpointScopeId;
    readonly ordinalWithinScope: number;
    readonly partKey?: string;
  }) {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(input.scopeId))
      .pipe(Effect.orDie);
    const scopeKey = Hex.encode(digest).slice(0, 32);
    const part =
      input.partKey === undefined || input.partKey === PRIMARY_CHECKPOINT_PART_KEY
        ? ""
        : `/part-${input.partKey}`;
    return CheckpointRef.make(
      `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(scopeKey)}${part}/ordinal/${input.ordinalWithinScope}`,
    );
  },
);
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
  idAllocator: IdAllocator.IdAllocatorV2["Service"],
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

const makeRootRunScope = Effect.fn("CheckpointService.makeRootRunScope")(function* (input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly cwd: string;
  readonly thread: WorkspaceThread;
  readonly unavailableFolderPaths?: ReadonlyArray<string> | undefined;
  readonly createdAt: DateTime.Utc;
}) {
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
  readonly ref: CheckpointRef;
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
    ref: input.ref,
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
  | CheckpointStore.CheckpointStore
  | Crypto.Crypto
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
> = Layer.effect(
  CheckpointServiceV2,
  Effect.gen(function* () {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const crypto = yield* Crypto.Crypto;
    const checkpointRefFor = (input: Parameters<typeof checkpointRefForScopeOrdinal>[0]) =>
      checkpointRefForScopeOrdinal(input).pipe(Effect.provideService(Crypto.Crypto, crypto));
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const checkoutLocks = yield* KeyedLock.make<string>();
    // Canonical checkout paths share a lock across every scope and folder part.
    const withCheckoutLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
      fileSystem.realPath(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
        Effect.map((path) => (isWindowsAbsolutePath(path) ? path.toLowerCase() : path)),
        Effect.flatMap((path) => checkoutLocks.withLock(path, effect)),
      );

    const isGitCheckpointable = (cwd: string) =>
      checkpointStore.isGitRepository(cwd).pipe(Effect.orElseSucceed(() => false));

    const partRef = (
      scope: OrchestrationV2CheckpointScope,
      part: OrchestrationV2CheckpointScopePart,
      ordinalWithinScope: number,
    ) => checkpointRefFor({ scopeId: scope.id, ordinalWithinScope, partKey: part.key });

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

          const checkpointRef = yield* partRef(scope, part, ordinalWithinScope);
          const exists = yield* checkpointStore.hasCheckpointRef({
            cwd: part.cwd,
            checkpointRef,
          });
          if (exists) {
            return;
          }

          yield* checkpointStore
            .captureCheckpoint({
              cwd: part.cwd,
              checkpointRef,
              pathspecs: part.pathspecs,
            })
            .pipe(Effect.catchTags({ VcsUnsupportedOperationError: () => Effect.void }));
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
      return withCheckoutLock(
        part.cwd,
        Effect.gen(function* () {
          const checkpointRef = yield* partRef(scope, part, ordinalWithinScope);
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
      Effect.fn("CheckpointServiceV2.materializeBaselineCheckpoint")(
        function* (input) {
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
            ref: yield* checkpointRefFor({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
            }),
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
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new CheckpointCaptureError({
                  scopeId: input.scope.id,
                  cause,
                }),
            ),
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
      return withCheckoutLock(
        part.cwd,
        Effect.gen(function* () {
          const checkpointRef = yield* partRef(scope, part, ordinalWithinScope);
          const previousCheckpointRef = yield* partRef(
            scope,
            part,
            Math.max(0, ordinalWithinScope - 1),
          );
          if (!(yield* isGitCheckpointable(part.cwd))) {
            return { part: { ...part, ref: checkpointRef, status: "missing" }, files: [] } as const;
          }

          const captureStatus = yield* checkpointStore
            .captureCheckpoint({
              cwd: part.cwd,
              checkpointRef,
              pathspecs: part.pathspecs,
            })
            .pipe(
              Effect.as("ready" as const),
              Effect.catchTags({
                VcsUnsupportedOperationError: () => Effect.succeed("missing" as const),
              }),
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 checkpoint capture failed", {
                  scopeId: scope.id,
                  checkpointRef,
                  cause: String(cause),
                }).pipe(Effect.as("error" as const)),
              ),
            );

          if (captureStatus !== "ready") {
            return {
              part: { ...part, ref: checkpointRef, status: captureStatus },
              files: [],
            } as const;
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
          const refs = {
            cwd: part.cwd,
            fromCheckpointRef: previousCheckpointRef,
            toCheckpointRef: checkpointRef,
          };
          // A pull or rebase can change thousands of files the turn did not write.
          const files = previousExists
            ? yield* Effect.all([
                checkpointStore.diffCheckpoints({
                  ...refs,
                  fallbackFromToHead: false,
                  ignoreWhitespace: false,
                  format: "numstat",
                }),
                checkpointStore.listAuthoredPaths(refs).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration V2 checkpoint authored paths failed", {
                      scopeId: scope.id,
                      checkpointRef,
                      cause: String(cause),
                    }).pipe(Effect.as(null)),
                  ),
                ),
              ]).pipe(
                Effect.map(([diff, authoredPaths]) =>
                  parseTurnDiffFilesFromNumstat(diff)
                    .filter((file) => !isGitImport(file, authoredPaths))
                    .map((file) => ({
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
    const capture: CheckpointServiceV2Shape["capture"] = Effect.fn("CheckpointServiceV2.capture")(
      function* (input) {
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
          const authoredByFolder = new Map<
            string,
            { readonly paths: ReadonlySet<string> | null; readonly prefix: string }
          >();
          for (const { part } of captured) {
            if (part.vcs !== "git" || part.status !== "ready" || part.ref === null) continue;
            const previousCheckpointRef = yield* partRef(
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
            ).pipe(Effect.orElseSucceed(() => false));
            if (!previousExists) continue;
            const authoredPaths = yield* withCheckoutLock(
              part.cwd,
              checkpointStore.listAuthoredPaths({
                cwd: part.cwd,
                fromCheckpointRef: previousCheckpointRef,
                toCheckpointRef: part.ref,
              }),
            ).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 checkpoint authored paths failed", {
                  scopeId: input.scope.id,
                  checkpointRef: part.ref,
                  cause: String(cause),
                }).pipe(Effect.as(null)),
              ),
            );
            for (const folderDiff of checkpointFolderDiffs(part)) {
              authoredByFolder.set(folderDiff.folder.label, {
                paths: authoredPaths,
                prefix: folderDiff.relativePath,
              });
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
          files = diffs.flatMap(({ label, diff }) => {
            const authored = label === undefined ? undefined : authoredByFolder.get(label);
            const repositoryPath = (path: string) =>
              authored?.prefix ? `${authored.prefix}/${path}` : path;
            return parseTurnDiffFilesFromNumstat(diff)
              .filter(
                (file) =>
                  !isGitImport(
                    {
                      ...file,
                      path: repositoryPath(file.path),
                      ...(file.previousPath === undefined
                        ? {}
                        : { previousPath: repositoryPath(file.previousPath) }),
                    },
                    authored?.paths ?? null,
                  ),
              )
              .map((file) => ({
                path: `${label}/${file.path}`,
                kind: "modified" as const,
                additions: file.additions,
                deletions: file.deletions,
              }));
          });
        }

        return makeCheckpoint({
          ref: yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          }),
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
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointCaptureError({
                scopeId: input.scope.id,
                cause,
              }),
          ),
        ),
    );

    const partLabels = (parts: ReadonlyArray<OrchestrationV2CheckpointPart>) =>
      parts.flatMap((part) => part.folders.map((folder) => folder.label));

    const preflightRestore: CheckpointServiceV2Shape["preflightRestore"] = Effect.fn(
      "CheckpointServiceV2.preflightRestore",
    )(function* (input) {
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
    const restore: CheckpointServiceV2Shape["restore"] = Effect.fn("CheckpointServiceV2.restore")(
      function* (input) {
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
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isCheckpointRestoreError(cause)
              ? cause
              : new CheckpointRestoreError({
                  scopeId: input.scope.id,
                  checkpointId: input.checkpoint.id,
                  cause,
                }),
          ),
        ),
    );

    // Only ready parts have known refs; missing secondary checkouts make their deletion best effort.
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
