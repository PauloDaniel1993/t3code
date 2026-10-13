import {
  CheckpointId,
  CheckpointScopeId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  fileRestoreRefusal,
  fileRestoreRefusalMessage,
  fileRestoreRefusalReason,
} from "./CheckpointRestoreSafety.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { probeUnavailableFolderPaths, RuntimePolicyV2 } from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export const ROLLBACK_FAILED_MESSAGE =
  "The provider could not roll back this conversation. Try again; if it keeps failing, check the provider and server logs.";

/** The message for a rewind whose conversation was rolled back but whose files weren't all restored. */
export function filesNotRestoredMessage(input: {
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

/**
 * What a client sees when a rollback gives up. A refused or partial file
 * restore names its folders; any other failure keeps a fixed message, and the
 * worker logs its cause.
 */
export function rollbackFailureMessage(cause: Cause.Cause<unknown>): string {
  for (const reason of cause.reasons) {
    if (
      Cause.isFailReason(reason) &&
      isCheckpointRollbackExecutionError(reason.error) &&
      (reason.error.reason === "file-restore-refused" ||
        reason.error.reason === "files-not-restored")
    ) {
      return reason.error.message;
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
  | EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStoreV2
  | ProviderSessionManagerV2
  | RuntimePolicyV2
  | FileSystem.FileSystem
  | Path.Path
  | ProjectStore.ProjectStoreV2
  | ThreadCommandExecutor.ThreadCommandExecutor
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const path = yield* Path.Path;
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;

    // Rewinds the provider conversation to the target turn.
    const rollbackProvider = Effect.fn("orchestrationV2.checkpointRollback.rollbackProvider")(
      function* (rollback: {
        readonly projection: Pick<
          OrchestrationV2ThreadProjection,
          "thread" | "providerSessions" | "runs" | "attempts" | "providerTurns"
        >;
        readonly threadId: ThreadId;
        readonly providerThread: OrchestrationV2ProviderThread;
        readonly providerSessionId: ProviderSessionId;
        readonly checkpointId: CheckpointId;
        readonly targetOrdinal: number;
      }) {
        const { projection, threadId, providerThread, providerSessionId, checkpointId } = rollback;
        const targetOrdinal = rollback.targetOrdinal;
        const modelSelection = projection.thread.modelSelection;
        // Outside a run, so the folders it can reach are probed now. A rewind
        // needs only the conversation, so a provider that can't reach every
        // folder isn't given them.
        const folderScope = yield* runtimePolicy.resolve({
          thread: projection.thread,
          modelSelection,
          unavailableFolderPaths: yield* probeUnavailableFolderPaths(projection.thread).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          ),
        });
        const folderAccess = yield* Effect.result(
          runtimePolicy.requireWorkspaceFolderAccess({
            threadId,
            providerInstanceId: modelSelection.instanceId,
            scope: folderScope,
          }),
        );
        const resolvedRuntimePolicy =
          folderAccess._tag === "Success"
            ? folderScope
            : { ...folderScope, additionalDirectories: [] };
        const existingSession = projection.providerSessions.find(
          (candidate) => candidate.id === providerSessionId,
        );
        const session = yield* sessions.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
          ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
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

        // Rolled-back turns stay in the audit history, but no longer exist in
        // the provider conversation and must not be counted by a later rewind.
        const rolledBackRunIds = new Set(
          projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
        );
        const rolledBackAttemptIds = new Set(
          projection.attempts
            .filter((attempt) => rolledBackRunIds.has(attempt.runId))
            .map((attempt) => attempt.id),
        );
        const providerThreadTurns = projection.providerTurns.filter(
          (turn) =>
            turn.providerThreadId === providerThread.id &&
            (turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId)),
        );
        const target: ProviderAdapter.ProviderAdapterV2RollbackTarget =
          targetOrdinal === 0
            ? {
                type: "thread_start",
                checkpointId,
                appRunOrdinal: 0,
              }
            : yield* Effect.gen(function* () {
                const targetRun = projection.runs.find((run) => run.ordinal === targetOrdinal);
                const targetAttempt = projection.attempts.find(
                  (attempt) => attempt.id === targetRun?.activeAttemptId,
                );
                const targetTurn =
                  latestProviderTurnForAttempt(projection.providerTurns, targetAttempt?.id) ??
                  projection.providerTurns.find(
                    (turn) => turn.id === targetAttempt?.providerTurnId,
                  );
                if (targetTurn === undefined || targetTurn.providerThreadId !== providerThread.id) {
                  return yield* new CheckpointRollbackExecutionError({
                    reason: "provider-turn-unavailable",
                    threadId,
                    providerThreadId: providerThread.id,
                    checkpointId,
                  });
                }
                return {
                  type: "provider_turn" as const,
                  checkpointId,
                  appRunOrdinal: targetOrdinal,
                  providerTurn: targetTurn,
                };
              });
        return yield* session.rollbackThread({ providerThread, target, providerThreadTurns });
      },
    );

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
      readonly restoreFiles?: boolean;
    }) {
      const projection = yield* projections.getThreadRecords(input.threadId, [
        "providerThreads",
        "providerSessions",
        "checkpoints",
        "checkpointScopes",
        "runs",
        "attempts",
        "nodes",
        "providerTurns",
      ]);
      const restoreFiles = input.restoreFiles !== false;
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === input.providerThreadId,
      );
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.id === input.checkpointId,
      );
      const scope = projection.checkpointScopes.find((candidate) => candidate.id === input.scopeId);
      // Only a file restore needs a ready checkpoint; a conversation-only
      // rewind needs a turn that wasn't rolled back.
      if (
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        checkpoint === undefined ||
        scope === undefined ||
        checkpoint.scopeId !== scope.id ||
        checkpoint.status === "stale"
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }
      if (
        providerThread.id !== projection.thread.activeProviderThreadId ||
        providerThread.providerInstanceId !== projection.thread.modelSelection.instanceId
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "active-provider-changed",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const targetOrdinal = checkpoint.appRunOrdinal ?? 0;
      // Stopped and failed runs after the target leave the provider
      // conversation too, so they must not stay visible.
      const runsToRollback = projection.runs.filter(
        (run) =>
          run.ordinal > targetOrdinal &&
          (run.status === "completed" ||
            run.status === "interrupted" ||
            run.status === "failed" ||
            run.status === "cancelled"),
      );

      // Refused before the provider rewinds: file restore is all or nothing.
      if (restoreFiles) {
        const refusal = yield* fileRestoreRefusal(projection.thread, scope, checkpoint, {
          checkpoints,
          fileSystem,
          projections,
          projects,
          path,
        });
        if (refusal !== undefined) {
          // A retry has nothing left to rewind, so its refusal is about files only.
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
      // A retry after the conversation was committed finds no run left to roll
      // back, so it skips the provider and restores the files only.
      const snapshot =
        runsToRollback.length === 0
          ? { providerThread }
          : yield* rollbackProvider({
              projection,
              threadId: input.threadId,
              providerThread,
              providerSessionId: providerThread.providerSessionId,
              checkpointId: checkpoint.id,
              targetOrdinal,
            });

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
            const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
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
        yield* checkpoints.restore({ scope, checkpoint }).pipe(
          Effect.catchTag("CheckpointRestoreError", (error) =>
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
          ),
        );
      }

      // The rolled-back turns' checkpoints go stale last, so a client waiting
      // on them knows the files are back too.
      const staleCheckpoints = projection.checkpoints.filter(
        (candidate) =>
          candidate.scopeId === scope.id &&
          candidate.appRunOrdinal !== null &&
          candidate.appRunOrdinal > targetOrdinal &&
          candidate.status !== "stale",
      );
      if (staleCheckpoints.length === 0) return;
      // Conversation and files are both back; a ref left behind costs only disk.
      yield* checkpoints.deleteStaleRefs({ scope, checkpoints: staleCheckpoints }).pipe(
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
      execute: (input) =>
        execute(input).pipe(
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
    });
  }),
);
