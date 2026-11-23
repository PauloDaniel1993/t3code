import {
  CheckpointId,
  CheckpointScopeId,
  type CommandId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  ProviderThreadId,
  repositoryRewindCheckpoint,
  ThreadId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type * as ServerConfig from "../config.ts";
import type * as ServerSettings from "../serverSettings.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import {
  withCheckpointRestoreReservation,
  withWorkspaceLease,
} from "../workspace/workspaceLease.ts";
import { makeCheckoutLeaseKeys } from "./checkoutLease.ts";
import { makeManagedWorktreeRecreation } from "./managedWorktreeRecreation.ts";
import { makeRecreateMissingWorktrees } from "./WorktreeSetService.ts";
import {
  restoreIsolationRefusal,
  isCheckpointRestoreIsolated,
  fileRestoreRefusal,
  fileRestoreRefusalMessage,
  fileRestoreRefusalReason,
} from "./CheckpointRestoreSafety.ts";
import { checkpointRestoreParts } from "./CheckpointScopeParts.ts";
import { CheckpointRestoreError, CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { GIT_INDEX_LOCKED_DETAIL } from "../vcs/VcsProcess.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { probeUnavailableFolderPaths, RuntimePolicyV2 } from "./RuntimePolicy.ts";
import { RuntimePolicyAboveCeilingError } from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export const ROLLBACK_FAILED_MESSAGE =
  "The provider could not roll back this conversation. Try again; if it keeps failing, check the provider and server logs.";

/** The message for a rewind whose conversation was rolled back but whose files weren't all restored. */
function filesNotRestoredMessage(input: {
  readonly restoredFolders: ReadonlyArray<string>;
  readonly unrestoredFolders: ReadonlyArray<string>;
}): string {
  if (input.unrestoredFolders.length === 0) {
    return "The conversation was rewound, but its files couldn't be restored.";
  }
  const restored =
    input.restoredFolders.length === 0
      ? ""
      : ` Files in ${input.restoredFolders.join(", ")} were restored.`;
  return `The conversation was rewound, but files in ${input.unrestoredFolders.join(", ")} couldn't be restored.${restored}`;
}

export class CheckpointRollbackExecutionError extends Schema.TaggedError<CheckpointRollbackExecutionError>()(
  "CheckpointRollbackExecutionError",
  {
    reason: Schema.Literals([
      "rollback-target-invalid",
      "active-provider-changed",
      "provider-turn-unavailable",
      "unexpected-failure",
      "file-restore-refused",
      "files-not-restored",
    ]),
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
    /** What the user sees for a refused or partial file restore. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "rollback-target-invalid":
        return `Rollback target ${this.checkpointId} for provider thread ${this.providerThreadId} on thread ${this.threadId} is incomplete or invalid.`;
      case "active-provider-changed":
        return `Active provider changed before rollback target ${this.checkpointId} could execute on thread ${this.threadId}.`;
      case "provider-turn-unavailable":
        return `Provider turn for rollback target ${this.checkpointId} is unavailable on provider thread ${this.providerThreadId}.`;
      case "file-restore-refused":
      case "files-not-restored":
        return this.detail ?? ROLLBACK_FAILED_MESSAGE;
      case "unexpected-failure":
        return ROLLBACK_FAILED_MESSAGE;
    }
  }
}

const isCheckpointRollbackExecutionError = Schema.is(CheckpointRollbackExecutionError);
const isVcsProcessExitError = Schema.is(VcsProcessExitError);
const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);
const isRuntimePolicyAboveCeilingError = Schema.is(RuntimePolicyAboveCeilingError);

/**
 * Refused or partial restores name their folders, and a held Git index lock
 * gets its own explanation. Internal ids and raw Git failures stay private.
 */
export function rollbackFailureClientMessage(error: CheckpointRollbackExecutionError): string {
  if (isRuntimePolicyAboveCeilingError(error.cause)) return error.cause.message;
  const restoreCause = isCheckpointRestoreError(error.cause) ? error.cause.cause : undefined;
  if (isVcsProcessExitError(restoreCause) && restoreCause.detail === GIT_INDEX_LOCKED_DETAIL) {
    return GIT_INDEX_LOCKED_DETAIL;
  }
  return error.reason === "file-restore-refused" || error.reason === "files-not-restored"
    ? error.message
    : ROLLBACK_FAILED_MESSAGE;
}

/**
 * What a client sees when a rollback gives up. A refused or partial file
 * restore names its folders; any other failure keeps a fixed message, and the
 * worker logs its cause.
 */
export function rollbackFailureMessage(cause: Cause.Cause<unknown>): string {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && isCheckpointRollbackExecutionError(reason.error)) {
      const message = rollbackFailureClientMessage(reason.error);
      if (message !== ROLLBACK_FAILED_MESSAGE) return message;
    }
  }
  return ROLLBACK_FAILED_MESSAGE;
}

export interface CheckpointRollbackServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
    readonly restoreFiles?: boolean;
    /** The rewind command: names the request when repositories are reported as left unrestored. */
    readonly requestId?: CommandId;
  }) => Effect.Effect<void, CheckpointRollbackExecutionError>;
}

export class CheckpointRollbackServiceV2 extends Context.Service<
  CheckpointRollbackServiceV2,
  CheckpointRollbackServiceV2Shape
>()("t3/orchestration-v2/CheckpointRollbackService/CheckpointRollbackServiceV2") {}

export const layer: Layer.Layer<
  CheckpointRollbackServiceV2,
  never,
  | CheckpointServiceV2
  | GitWorkflowService.GitWorkflowService
  | EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStoreV2
  | ProviderSessionManagerV2
  | RuntimePolicyV2
  | FileSystem.FileSystem
  | Path.Path
  | ProjectStore.ProjectStoreV2
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | TaskFolders.TaskFolders
  | ThreadCommandExecutor.ThreadCommandExecutor
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const path = yield* Path.Path;
    const taskFolders = yield* TaskFolders.TaskFolders;
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const { keys: checkoutLeaseKeys } = yield* makeCheckoutLeaseKeys;
    const recreateManagedWorktrees = yield* makeManagedWorktreeRecreation;
    const recreateMissing = makeRecreateMissingWorktrees({
      fileSystem,
      git: gitWorkflow,
      getProjectRoot: (projectId) =>
        projects.get(projectId).pipe(
          Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
          Effect.orElseSucceed(() => undefined),
        ),
    });

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
      readonly restoreFiles?: boolean;
      readonly requestId?: CommandId;
    }) {
      const context = yield* projections.getCheckpointRollbackContext(input.threadId, input);
      if (context.thread.deletedAt != null) return;
      const { providerThread, checkpoint, scope, targetAttempt, runsToRollback, staleCheckpoints } =
        context;
      const restoreFiles = input.restoreFiles !== false;
      const { worktreePath, branch } = context.thread;
      const recordedTaskFolder =
        worktreePath === null ||
        context.thread.worktrees !== undefined ||
        context.thread.workspaceFolders !== undefined ||
        checkpoint?.parts !== undefined
          ? null
          : yield* taskFolders.find(worktreePath);
      const taskFolder =
        recordedTaskFolder?.projectId === context.thread.projectId ? recordedTaskFolder : null;
      // A linked project folder is not a repository: it has no snapshot, by design.
      const linkedProjectFolder = taskFolder !== null && !taskFolder.projectIsWorktree;
      const invalidTarget = () =>
        new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      if (
        (recordedTaskFolder !== null && taskFolder === null) ||
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        checkpoint === undefined ||
        scope === undefined ||
        // A repository's checkpoints follow the thread's; they are not a place to rewind to.
        typeof scope.repositoryPath === "string" ||
        checkpoint.scopeId !== scope.id ||
        // Missing or failed snapshots support conversation rewind; missing ones also restoring a
        // task folder's repositories.
        checkpoint.status === "stale" ||
        (taskFolder !== null &&
          restoreFiles &&
          checkpoint.status !== "ready" &&
          !(checkpoint.status === "missing" && linkedProjectFolder))
      ) {
        return yield* invalidTarget();
      }
      if (
        providerThread.id !== context.thread.activeProviderThreadId ||
        providerThread.providerInstanceId !== context.thread.modelSelection.instanceId
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "active-provider-changed",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const targetOrdinal = checkpoint.appRunOrdinal ?? 0;
      const rollbackTarget: ProviderAdapter.ProviderAdapterV2RollbackTarget | undefined =
        runsToRollback.length === 0
          ? undefined
          : targetOrdinal === 0
            ? { type: "thread_start", checkpointId: checkpoint.id, appRunOrdinal: 0 }
            : yield* Effect.gen(function* () {
                const targetTurn =
                  latestProviderTurnForAttempt(context.providerTurns, targetAttempt?.id) ??
                  context.providerTurns.find((turn) => turn.id === targetAttempt?.providerTurnId);
                if (
                  targetAttempt === undefined ||
                  targetTurn === undefined ||
                  targetTurn.providerThreadId !== providerThread.id
                ) {
                  return yield* new CheckpointRollbackExecutionError({
                    reason: "provider-turn-unavailable",
                    threadId: input.threadId,
                    providerThreadId: input.providerThreadId,
                    checkpointId: input.checkpointId,
                  });
                }
                const { attempt } = yield* projections.getProviderControlContext(input.threadId, {
                  providerThreadId: providerThread.id,
                  providerTurnId: targetTurn.id,
                  attemptId: targetAttempt.id,
                });
                const message =
                  attempt === undefined
                    ? undefined
                    : yield* projections.getRunMessage(input.threadId, attempt.runId);
                return {
                  type: "provider_turn" as const,
                  checkpointId: checkpoint.id,
                  appRunOrdinal: targetOrdinal,
                  providerTurn: targetTurn,
                  ...(message === undefined ? {} : { message }),
                };
              });
      if (taskFolder !== null) {
        if (
          restoreFiles &&
          !(yield* isCheckpointRestoreIsolated(context.thread, scope, taskFolder, {
            fileSystem,
            projections,
            projects,
            path,
          }))
        ) {
          return yield* new CheckpointRollbackExecutionError({
            reason: "file-restore-refused",
            threadId: input.threadId,
            providerThreadId: input.providerThreadId,
            checkpointId: input.checkpointId,
            detail: fileRestoreRefusalMessage({ reason: "shared", folders: [] }),
          });
        }
        if (branch !== null) {
          // Cleanup can remove any of the folder's checkouts; the linked project folder has none.
          yield* taskFolders.restore({
            taskFolder,
            branch,
            recreate: (checkout) =>
              gitWorkflow.pruneWorktrees({ cwd: checkout.repositoryPath }).pipe(
                Effect.andThen(
                  gitWorkflow.createWorktree({
                    cwd: checkout.repositoryPath,
                    refName: branch,
                    path: checkout.worktreePath,
                  }),
                ),
              ),
          });
        }
      } else {
        const managedPaths: string[] = [];
        yield* recreateManagedWorktrees(context.thread, (managed) =>
          Effect.sync(() => {
            managedPaths.push(
              ...(managed.worktrees?.map((member) => member.path) ??
                (managed.worktreePath === null ? [] : [managed.worktreePath])),
            );
          }),
        );
        const leftoverPaths = restoreFiles
          ? yield* Effect.filter(managedPaths, (location) =>
              fileSystem
                .exists(location)
                .pipe(
                  Effect.flatMap((exists) =>
                    exists
                      ? fileSystem
                          .exists(path.join(location, ".git"))
                          .pipe(Effect.map((git) => !git))
                      : Effect.succeed(false),
                  ),
                ),
            )
          : [];
        const leftovers = leftoverPaths.filter(
          (location) =>
            !leftoverPaths.some((other) => {
              if (location === other) return false;
              const relative = path.relative(other, location);
              return (
                relative !== "" &&
                relative !== ".." &&
                !relative.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relative)
              );
            }),
        );
        if (leftovers.length > 0) {
          const refusal = yield* restoreIsolationRefusal(
            context.thread,
            checkpointRestoreParts(scope, checkpoint),
            {
              fileSystem,
              projections,
              projects,
              path,
            },
          );
          if (refusal !== undefined)
            return yield* new CheckpointRollbackExecutionError({
              reason: "file-restore-refused",
              threadId: input.threadId,
              providerThreadId: input.providerThreadId,
              checkpointId: input.checkpointId,
              detail: fileRestoreRefusalMessage(refusal),
            });
        }
        yield* Effect.acquireUseRelease(
          Effect.succeed([] as Array<{ location: string; aside: string }>),
          (saved) =>
            Effect.gen(function* () {
              for (const location of leftovers) {
                const aside = yield* fileSystem.makeTempDirectory({
                  directory: path.dirname(location),
                  prefix: ".t3-replaced-",
                });
                yield* fileSystem.rename(location, path.join(aside, "folder"));
                saved.push({ location, aside });
              }
              yield* recreateManagedWorktrees(context.thread, recreateMissing);
            }),
          (saved, exit) =>
            Effect.forEach(
              [...saved].reverse(),
              ({ location, aside }) =>
                (Exit.isSuccess(exit)
                  ? Effect.void
                  : fileSystem
                      .remove(location, { recursive: true, force: true })
                      .pipe(Effect.andThen(fileSystem.rename(path.join(aside, "folder"), location)))
                ).pipe(
                  Effect.andThen(fileSystem.remove(aside, { recursive: true, force: true })),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Edit from here left a worktree folder set aside", {
                      worktreePath: location,
                      setAside: path.join(aside, "folder"),
                      cause,
                    }),
                  ),
                ),
              { discard: true },
            ),
        );
      }
      if (restoreFiles && taskFolder === null) {
        const refusal = yield* fileRestoreRefusal(context.thread, scope, checkpoint, {
          checkpoints,
          fileSystem,
          projections,
          projects,
          path,
          allowMissingWorktrees: false,
        });
        if (refusal !== undefined) {
          const rewound = runsToRollback.length === 0;
          return yield* new CheckpointRollbackExecutionError({
            reason: rewound ? "files-not-restored" : "file-restore-refused",
            threadId: input.threadId,
            providerThreadId: input.providerThreadId,
            checkpointId: input.checkpointId,
            detail: rewound
              ? `The conversation was rewound, but its files weren't restored. ${fileRestoreRefusalReason(refusal)}`
              : fileRestoreRefusalMessage(refusal),
          });
        }
      }
      // Before the provider conversation changes: a rewind with nothing to restore is refused.
      const readable =
        restoreFiles && taskFolder !== null
          ? yield* checkpoints.repositoryScopesIfReadable({
              rootScope: scope,
              projectId: context.thread.projectId,
              worktreePath,
            })
          : [];
      // Unknown repositories are not "none": the rewind would leave their changes unmentioned.
      if (readable === null) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "unexpected-failure",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
          cause: new Error("The thread's repositories could not be read."),
        });
      }
      const repositories = readable;
      const recorded =
        repositories.length === 0
          ? []
          : (yield* projections.getCheckpointContext(input.threadId)).checkpoints;
      const repositoryTargets = repositories.flatMap((repository) => {
        const target = repositoryRewindCheckpoint(
          recorded.filter((candidate) => candidate.scopeId === repository.id),
          targetOrdinal,
        );
        return target === null ? [] : [{ scope: repository, checkpoint: target }];
      });
      // Changed by a discarded run, with no snapshot of how it was before: left as it is.
      const unrestorable = repositories.filter(
        (repository) =>
          !repositoryTargets.some((target) => target.scope.id === repository.id) &&
          recorded.some(
            (candidate) =>
              candidate.scopeId === repository.id &&
              candidate.ordinalWithinScope > targetOrdinal &&
              (candidate.status === "ready" || candidate.runId !== null),
          ),
      );
      if (unrestorable.length > 0) {
        yield* Effect.logWarning("Edit from here cannot restore repositories without a snapshot", {
          threadId: input.threadId,
          repositories: unrestorable.map((repository) => repository.cwd),
        });
      }
      const restoreTargets = [
        ...(checkpoint.status === "ready" ? [{ scope, checkpoint }] : []),
        ...repositoryTargets,
      ];
      if (restoreFiles && taskFolder !== null && restoreTargets.length === 0)
        return yield* invalidTarget();

      if (restoreFiles && taskFolder !== null) {
        for (const target of restoreTargets) {
          const refusal = yield* checkpoints.preflightRestore(target);
          if (refusal !== undefined) {
            return yield* new CheckpointRollbackExecutionError({
              reason: "unexpected-failure",
              threadId: input.threadId,
              providerThreadId: input.providerThreadId,
              checkpointId: input.checkpointId,
              cause: fileRestoreRefusalReason(refusal),
            });
          }
        }
      }
      let snapshot = { providerThread };
      // A retry after the conversation commit only restores files; it must not rewind again.
      if (rollbackTarget !== undefined) {
        const modelSelection = context.thread.modelSelection;
        const folderScope = yield* runtimePolicy.resolve({
          thread: context.thread,
          modelSelection,
          unavailableFolderPaths: yield* probeUnavailableFolderPaths(context.thread).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          ),
        });
        const folderAccess = yield* Effect.result(
          runtimePolicy.requireWorkspaceFolderAccess({
            threadId: input.threadId,
            providerInstanceId: modelSelection.instanceId,
            scope: folderScope,
          }),
        );
        const session = yield* sessions.open({
          threadId: input.threadId,
          providerSessionId: providerThread.providerSessionId,
          modelSelection,
          runtimePolicy:
            folderAccess._tag === "Success"
              ? folderScope
              : { ...folderScope, additionalDirectories: [] },
          ...(context.providerSession === undefined
            ? {}
            : { resumeFromSession: context.providerSession }),
          ...(providerThread.nativeThreadRef?.nativeId == null
            ? {}
            : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
          ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        });
        const rolledBackAttemptIds = new Set(context.rolledBackAttemptIds);
        snapshot = yield* session.rollbackThread({
          providerThread,
          target: rollbackTarget,
          providerThreadTurns: context.providerTurns.filter(
            (turn) =>
              turn.providerThreadId === providerThread.id &&
              (turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId)),
          ),
        });
      }
      const makeEvent = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
        Effect.map(
          ids.allocate.event({ threadId: event.threadId }),
          (id) =>
            ({
              ...event,
              id,
            }) as Event,
        );
      // The conversation is committed once the provider has rewound, before any
      // file is touched. Codex rewinds by a turn count, so rolling the provider
      // back again on a retry would lose more turns.
      // Serialize the provider-thread replacement with normal command writes.
      yield* threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const rewoundAt = yield* DateTime.now;
          const conversation: Array<OrchestrationV2DomainEvent> = [];
          // First, so a client that sees the runs rolled back already knows what was left.
          if (input.requestId !== undefined && unrestorable.length > 0) {
            const thread = yield* projections.getThread(input.threadId);
            conversation.push(
              yield* makeEvent({
                type: "thread.metadata-updated",
                threadId: input.threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: rewoundAt,
                payload: {
                  ...thread,
                  rollbackUnrestored: {
                    requestId: input.requestId,
                    repositories: unrestorable.map(
                      (repository) => repository.label ?? path.basename(repository.cwd),
                    ),
                  },
                  updatedAt: rewoundAt,
                },
              }),
            );
          }
          conversation.push(
            yield* makeEvent({
              type: "provider-thread.updated",
              threadId: input.threadId,
              driver: providerThread.driver,
              providerInstanceId: providerThread.providerInstanceId,
              occurredAt: rewoundAt,
              payload: {
                ...snapshot.providerThread,
                lastRunOrdinal: targetOrdinal === 0 ? null : targetOrdinal,
                updatedAt: rewoundAt,
              },
            }),
          );
          for (const run of runsToRollback) {
            const rootNode = context.rootNodes.find((candidate) => candidate.id === run.rootNodeId);
            conversation.push(
              yield* makeEvent({
                type: "run.updated",
                threadId: input.threadId,
                runId: run.id,
                ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
                providerInstanceId: run.providerInstanceId,
                occurredAt: rewoundAt,
                payload: { ...run, status: "rolled_back", completedAt: rewoundAt },
              }),
            );
            if (rootNode !== undefined) {
              conversation.push(
                yield* makeEvent({
                  type: "node.updated",
                  threadId: input.threadId,
                  runId: run.id,
                  nodeId: rootNode.id,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: rewoundAt,
                  payload: { ...rootNode, status: "rolled_back", completedAt: rewoundAt },
                }),
              );
            }
          }
          yield* eventSink.write({ events: conversation });
        }),
      );

      if (restoreFiles) {
        const restore =
          checkpoint.parts !== undefined
            ? checkpoints.restoreParts({ scope, checkpoint })
            : checkpoints.restore({ targets: restoreTargets, scopes: [scope, ...repositories] });
        yield* restore.pipe(
          Effect.catchTags({
            CheckpointRestoreError: (error) =>
              Effect.fail(
                new CheckpointRollbackExecutionError({
                  reason: "files-not-restored",
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                  detail: filesNotRestoredMessage({
                    restoredFolders: error.restoredFolders ?? [],
                    unrestoredFolders: error.unrestoredFolders ?? [],
                  }),
                  cause: error,
                }),
              ),
          }),
        );
      }

      // The rolled-back turns' checkpoints go stale last, so a client waiting
      // on them knows the files are back too.
      if (context.thread.workspaceFolders === undefined && context.thread.worktrees === undefined) {
        yield* checkpoints.discardRepositorySnapshots({
          rootScope: scope,
          thread: context.thread,
          ordinals: [
            ...new Set([
              ...runsToRollback.map((run) => run.ordinal),
              ...staleCheckpoints.map((stale) => stale.ordinalWithinScope),
            ]),
          ],
        });
      }
      if (staleCheckpoints.length === 0) return;
      // Conversation and files are both back; a ref left behind costs only disk.
      const staleRoot = staleCheckpoints.filter((stale) => stale.scopeId === scope.id);
      if (staleRoot.length > 0)
        yield* checkpoints.deleteStaleRefs({ scope, checkpoints: staleRoot }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("orchestration V2 stale checkpoint refs kept after a rewind", {
              threadId: input.threadId,
              cause: String(cause),
            }),
          ),
        );
      const staleAt = yield* DateTime.now;
      const stale: Array<OrchestrationV2DomainEvent> = [];
      for (const staleCheckpoint of staleCheckpoints) {
        stale.push(
          yield* makeEvent({
            type: "checkpoint.captured",
            threadId: input.threadId,
            ...(staleCheckpoint.runId === null ? {} : { runId: staleCheckpoint.runId }),
            nodeId: staleCheckpoint.nodeId,
            providerInstanceId: providerThread.providerInstanceId,
            occurredAt: staleAt,
            payload: { ...staleCheckpoint, status: "stale" },
          }),
        );
      }
      yield* threadCommands.withLock(input.threadId, eventSink.write({ events: stale }));
    });

    return CheckpointRollbackServiceV2.of({
      // The inner execute owns the rollback span; this wrapper selects the workspace lease.
      execute: Effect.fnUntraced(
        function* (input) {
          // Storage cleanup removes worktrees under the same lease.
          const thread = yield* projections.getThread(input.threadId);
          const locations = [
            ...(thread.worktrees ?? []).map((member) => member.path),
            ...(thread.worktreePath === null ? [] : [thread.worktreePath]),
          ];
          const leases = yield* checkoutLeaseKeys(locations);
          const rollback = leases.reduceRight(
            (effect, location) => withWorkspaceLease(location, effect),
            execute(input),
          );
          const roots = leases.filter(
            (location) =>
              !leases.some((other) => {
                if (other === location) return false;
                const relative = path.relative(other, location);
                return (
                  relative !== "" &&
                  relative !== ".." &&
                  !relative.startsWith(`..${path.sep}`) &&
                  !path.isAbsolute(relative)
                );
              }),
          );
          yield* input.restoreFiles === false
            ? rollback
            : roots.reduceRight(
                (effect, location) =>
                  withCheckpointRestoreReservation(fileSystem, path, location, effect),
                rollback,
              );
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isCheckpointRollbackExecutionError(cause)
                ? cause
                : new CheckpointRollbackExecutionError({
                    reason: "unexpected-failure",
                    threadId: input.threadId,
                    providerThreadId: input.providerThreadId,
                    checkpointId: input.checkpointId,
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);
