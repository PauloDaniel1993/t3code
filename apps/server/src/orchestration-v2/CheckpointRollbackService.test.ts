import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Layer from "effect/Layer";

import { resolveCodexRollbackTurnCount } from "./Adapters/CodexAdapterV2.ts";
import {
  restoreIsolationRefusal,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "./CheckpointRestoreSafety.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2RollbackThreadInput } from "./ProviderAdapter.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

// A root that does not exist never overlaps, so other owners decide isolation.
const unrelatedProject = Option.some({
  workspaceRoot: "/nonexistent/t3-rollback-project",
} as never);
const checkpointRollbackServiceLayer = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(unrelatedProject) }),
    ),
  ),
);

it.effect("rejects a non-ready checkpoint before opening a session or restoring files", () => {
  const threadId = ThreadId.make("thread:rollback-non-ready");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-non-ready");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-non-ready");
  const checkpointId = CheckpointId.make("checkpoint:rollback-non-ready");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-non-ready");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_non_ready");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      worktreePath: process.cwd(),
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    checkpoints: [{ id: checkpointId, scopeId, status: "stale" }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointService.CheckpointServiceV2)({ restore }),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: resolveRuntimePolicy,
          requireWorkspaceFolderAccess: () => Effect.void,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "rollback-target-invalid");
    assert.equal(
      error.message,
      `Rollback target ${checkpointId} for provider thread ${providerThreadId} on thread ${threadId} is incomplete or invalid.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects a rollback when another provider thread became active", () => {
  const threadId = ThreadId.make("thread:rollback-inactive-provider-thread");
  const requestedProviderThreadId = ProviderThreadId.make(
    "provider-thread:rollback-inactive-provider-thread:requested",
  );
  const activeProviderThreadId = ProviderThreadId.make(
    "provider-thread:rollback-inactive-provider-thread:active",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-inactive-provider-thread",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-inactive-provider-thread");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-inactive-provider-thread");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_inactive_provider_thread");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      activeProviderThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [
      {
        id: requestedProviderThreadId,
        providerSessionId,
        providerInstanceId,
      },
    ],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready" }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointService.CheckpointServiceV2)({ restore }),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: resolveRuntimePolicy,
          requireWorkspaceFolderAccess: () => Effect.void,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId: requestedProviderThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "active-provider-changed");
    assert.equal(
      error.message,
      `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects a rollback when provider selection changed before execution", () => {
  const threadId = ThreadId.make("thread:rollback-provider-selection-changed");
  const providerThreadId = ProviderThreadId.make(
    "provider-thread:rollback-provider-selection-changed",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-provider-selection-changed",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-provider-selection-changed");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-provider-selection-changed");
  const originalProviderInstanceId = ProviderInstanceId.make(
    "provider_rollback_provider_selection_changed_original",
  );
  const selectedProviderInstanceId = ProviderInstanceId.make(
    "provider_rollback_provider_selection_changed_selected",
  );
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      worktreePath: process.cwd(),
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: selectedProviderInstanceId, model: "test-model" },
    },
    providerThreads: [
      {
        id: providerThreadId,
        providerSessionId,
        providerInstanceId: originalProviderInstanceId,
      },
    ],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready" }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointService.CheckpointServiceV2)({ restore }),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: resolveRuntimePolicy,
          requireWorkspaceFolderAccess: () => Effect.void,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "active-provider-changed");
    assert.equal(
      error.message,
      `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("reports a missing provider turn as a structured rollback failure", () => {
  const threadId = ThreadId.make("thread:rollback-provider-turn-unavailable");
  const providerThreadId = ProviderThreadId.make(
    "provider-thread:rollback-provider-turn-unavailable",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-provider-turn-unavailable",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-provider-turn-unavailable");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-provider-turn-unavailable");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_provider_turn_unavailable");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const projection = {
    thread: {
      worktreePath: process.cwd(),
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    providerSessions: [],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready", appRunOrdinal: 1 }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
    runs: [{ id: "later-run", ordinal: 2, status: "completed" }],
    attempts: [],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointService.CheckpointServiceV2)({
          preflightRestore: () => Effect.succeed(undefined),
          restore,
        }),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () => Effect.succeed({} as never),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
          requireWorkspaceFolderAccess: () => Effect.void,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "provider-turn-unavailable");
    assert.equal(
      error.message,
      `Provider turn for rollback target ${checkpointId} is unavailable on provider thread ${providerThreadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rewinds a provider that can't reach every folder without handing it the others", () => {
  const threadId = ThreadId.make("thread:rollback-folder-access");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-folder-access");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-folder-access");
  const checkpointId = CheckpointId.make("checkpoint:rollback-folder-access");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-folder-access");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_folder_access");
  const projection = {
    thread: {
      worktreePath: process.cwd(),
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    providerSessions: [],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready", appRunOrdinal: 1 }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
    runs: [{ id: "later-run", ordinal: 2, status: "completed" }],
    attempts: [],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const open = vi.fn((_input: { readonly runtimePolicy: unknown }) => Effect.succeed({} as never));
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointService.CheckpointServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () =>
            Effect.succeed({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: process.cwd(),
              additionalDirectories: ["/work/lib"],
            }),
          requireWorkspaceFolderAccess: () =>
            Effect.fail(
              new RuntimePolicy.ProviderWorkspaceFolderAccessError({
                threadId,
                providerInstanceId,
              }),
            ),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    // The rewind itself fails later for want of a provider turn; only its open matters here.
    yield* service
      .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles: false })
      .pipe(Effect.flip);
    assert.deepEqual(open.mock.calls[0]?.[0].runtimePolicy, {
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
      additionalDirectories: [],
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect.each([
  { restoreFiles: true, shared: "none" },
  { restoreFiles: false, shared: "root" },
  { restoreFiles: true, shared: "root" },
  { restoreFiles: true, shared: "worktree" },
  { restoreFiles: false, shared: "worktree" },
  { restoreFiles: true, shared: "historical" },
  { restoreFiles: false, shared: "none", targetOrdinal: 1 },
])("rewinds safely with %s", ({ restoreFiles, shared, targetOrdinal = 0 }) => {
  const threadId = ThreadId.make("rewind-files");
  const providerThreadId = ProviderThreadId.make("rewind-provider");
  const providerSessionId = ProviderSessionId.make("rewind-session");
  const instanceId = ProviderInstanceId.make("rewind-instance");
  const checkpointId = CheckpointId.make("rewind-start");
  const scopeId = CheckpointScopeId.make("rewind-scope");
  const calls: string[] = [];
  const providerThread = {
    id: providerThreadId,
    providerSessionId,
    providerInstanceId: instanceId,
  };
  const projection = {
    thread: {
      worktreePath: shared === "root" ? null : process.cwd(),
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId, model: "test" },
    },
    providerThreads: [providerThread],
    providerSessions: [],
    // Turn 3 remains in the audit history after an earlier rollback.
    providerTurns: [1, 2, 3].map((ordinal) => ({
      id: `turn-${ordinal}`,
      providerThreadId,
      runAttemptId: `attempt-${ordinal}`,
      ordinal,
      status: "completed",
    })),
    nodes: [],
    attempts: [1, 2, 3].map((ordinal) => ({ id: `attempt-${ordinal}`, runId: `run-${ordinal}` })),
    checkpoints: [
      { id: checkpointId, scopeId, status: "ready", appRunOrdinal: targetOrdinal || null },
    ],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
    runs: [1, 2, 3].map((ordinal) => ({
      id: `run-${ordinal}`,
      ordinal,
      status: ordinal === 3 ? "rolled_back" : "completed",
      rootNodeId: null,
      activeAttemptId: `attempt-${ordinal}`,
    })),
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointService.CheckpointServiceV2)({
          preflightRestore: () => Effect.succeed(undefined),
          restore: () =>
            Effect.sync(() => {
              calls.push("files");
            }),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events }) =>
            Effect.sync(() => {
              assert.ok(
                events.some(
                  (event) => event.type === "run.updated" && event.payload.status === "rolled_back",
                ),
              );
              calls.push("projection");
              return [];
            }),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getThreadProviderContext: () => Effect.succeed({ providerSessions: [] } as never),
          getCheckpointContext: () =>
            Effect.succeed({
              checkpointScopes: [{ cwd: process.cwd() }],
              runs: [],
              checkpoints: [],
            } as never),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads:
                shared === "worktree" || shared === "historical"
                  ? [
                      {
                        id: ThreadId.make("other-thread"),
                        deletedAt: null,
                        worktreePath: shared === "worktree" ? process.cwd() : null,
                      } as never,
                    ]
                  : [],
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              rollbackThread: (input: ProviderAdapterV2RollbackThreadInput) =>
                Effect.gen(function* () {
                  const count = yield* resolveCodexRollbackTurnCount(input);
                  assert.equal(count, 2 - targetOrdinal);
                  calls.push("provider");
                  return { providerThread };
                }),
            } as never),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
          requireWorkspaceFolderAccess: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    if (restoreFiles && shared !== "none") {
      const error = yield* Effect.flip(
        service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles }),
      );
      assert.equal(error.reason, "file-restore-refused");
      assert.equal(error.message, SHARED_WORKSPACE_RESTORE_MESSAGE);
      assert.deepEqual(calls, []);
      return;
    }
    yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles });
    // The conversation is committed before any file is touched.
    assert.deepEqual(
      calls,
      restoreFiles ? ["provider", "projection", "files"] : ["provider", "projection"],
    );
  }).pipe(Effect.provide(testLayer));
});

it.effect.skipIf(!symlinksSupported)(
  "rejects an archived thread sharing a worktree through a symlink",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-restore-isolation-" });
      const path = yield* Path.Path;
      const alias = path.join(cwd, "alias");
      yield* fileSystem.symlink(cwd, alias);
      const threadId = ThreadId.make("restore-alias-current");
      const otherId = ThreadId.make("restore-alias-archived");
      const projections = ProjectionStore.ProjectionStoreV2.of({
        getShellSnapshot: () =>
          Effect.succeed({
            schemaVersion: 1,
            snapshotSequence: 0,
            threads: [],
            archivedThreads: [{ id: otherId, deletedAt: null, worktreePath: alias } as never],
          }),
        getThreadProviderContext: () => Effect.succeed({ providerSessions: [] } as never),
        getCheckpointContext: () =>
          Effect.succeed({ runs: [], checkpointScopes: [], checkpoints: [] }),
      } as never);
      const refusal = yield* restoreIsolationRefusal(
        { id: threadId, worktreePath: cwd },
        [{ cwd, folders: [] }],
        {
          fileSystem,
          path,
          projections,
          projects: ProjectStore.ProjectStoreV2.of({
            get: () => Effect.succeed(unrelatedProject),
          } as never),
        },
      );
      assert.deepEqual(refusal, { reason: "shared", folders: [] });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

/**
 * A thread at run 3 rewinding to run 1. The event sink applies run and
 * checkpoint updates, so a retry sees what the first attempt committed. The
 * provider rewinds by a turn count, like Codex.
 */
const makeRewindHarness = (options: {
  readonly name: string;
  readonly targetStatus: "ready" | "error";
  readonly checkpoints: Partial<CheckpointService.CheckpointServiceV2["Service"]>;
}) => {
  const threadId = ThreadId.make(`${options.name}-thread`);
  const providerThreadId = ProviderThreadId.make(`${options.name}-provider`);
  const instanceId = ProviderInstanceId.make(`${options.name}-instance`);
  const scopeId = CheckpointScopeId.make(`${options.name}-scope`);
  const providerThread = {
    id: providerThreadId,
    providerSessionId: ProviderSessionId.make(`${options.name}-session`),
    providerInstanceId: instanceId,
  };
  const checkpoint = (ordinal: number, status: "ready" | "error" | "missing") => ({
    id: CheckpointId.make(`${options.name}-checkpoint-${ordinal}`),
    scopeId,
    runId: `run-${ordinal}`,
    nodeId: `node-${ordinal}`,
    appRunOrdinal: ordinal,
    status,
  });
  const state = {
    nativeTurns: 3,
    providerRollbacks: 0,
    writes: [] as Array<ReadonlyArray<OrchestrationV2DomainEvent>>,
    projection: {
      thread: {
        id: threadId,
        worktreePath: process.cwd(),
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId, model: "test" },
      },
      providerThreads: [providerThread],
      providerSessions: [],
      providerTurns: [1, 2, 3].map((ordinal) => ({
        id: `turn-${ordinal}`,
        providerThreadId,
        runAttemptId: `attempt-${ordinal}`,
        ordinal,
        status: "completed",
      })),
      nodes: [],
      attempts: [1, 2, 3].map((ordinal) => ({ id: `attempt-${ordinal}`, runId: `run-${ordinal}` })),
      checkpoints: [
        checkpoint(1, options.targetStatus),
        checkpoint(2, "ready"),
        // A turn whose capture failed still goes stale.
        checkpoint(3, "error"),
      ],
      checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
      runs: [1, 2, 3].map((ordinal) => ({
        id: `run-${ordinal}`,
        ordinal,
        status: "completed",
        rootNodeId: null,
        activeAttemptId: `attempt-${ordinal}`,
      })),
    } as unknown as OrchestrationV2ThreadProjection,
  };
  const replace = <T extends { readonly id: string }>(items: ReadonlyArray<T>, item: T) =>
    items.map((candidate) => (candidate.id === item.id ? item : candidate));
  const layer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointService.CheckpointServiceV2)(options.checkpoints),
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events }) =>
            Effect.sync(() => {
              state.writes.push(events);
              for (const event of events) {
                if (event.type === "run.updated") {
                  state.projection = {
                    ...state.projection,
                    runs: replace(state.projection.runs, event.payload),
                  };
                } else if (event.type === "checkpoint.captured") {
                  state.projection = {
                    ...state.projection,
                    checkpoints: replace(state.projection.checkpoints, event.payload),
                  };
                }
              }
              return [];
            }),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.sync(() => state.projection as never),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              rollbackThread: (input: ProviderAdapterV2RollbackThreadInput) =>
                Effect.gen(function* () {
                  state.nativeTurns -= yield* resolveCodexRollbackTurnCount(input);
                  state.providerRollbacks++;
                  return { providerThread };
                }),
            } as never),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
          requireWorkspaceFolderAccess: () => Effect.void,
        }),
      ),
    ),
  );
  const execute = (restoreFiles: boolean) =>
    CheckpointRollbackService.CheckpointRollbackServiceV2.pipe(
      Effect.flatMap((service) =>
        service.execute({
          threadId,
          providerThreadId,
          checkpointId: checkpoint(1, "ready").id,
          scopeId,
          restoreFiles,
        }),
      ),
    );
  const statuses = () => ({
    runs: state.projection.runs.map((run) => run.status),
    checkpoints: state.projection.checkpoints.map((candidate) => candidate.status),
  });
  return { state, layer, execute, statuses };
};

it.effect("rewinds the conversation to an error-barrier checkpoint without its files", () => {
  const restore = vi.fn(() => Effect.die("file restore must not run"));
  const preflightRestore = vi.fn(() => Effect.die("file restore checks must not run"));
  const deleted: Array<string> = [];
  const harness = makeRewindHarness({
    name: "rewind-error-barrier",
    targetStatus: "error",
    checkpoints: {
      preflightRestore,
      restore,
      deleteStaleRefs: ({ checkpoints }) =>
        Effect.sync(() => {
          deleted.push(...checkpoints.map((candidate) => candidate.id));
        }),
    },
  });
  return Effect.gen(function* () {
    yield* harness.execute(false);
    assert.equal(harness.state.nativeTurns, 1);
    assert.deepEqual(harness.statuses(), {
      runs: ["completed", "rolled_back", "rolled_back"],
      checkpoints: ["error", "stale", "stale"],
    });
    assert.deepEqual(deleted, [
      "rewind-error-barrier-checkpoint-2",
      "rewind-error-barrier-checkpoint-3",
    ]);
    assert.equal(restore.mock.calls.length, 0);
    assert.equal(preflightRestore.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses a file restore before the provider rewinds, naming the folders", () => {
  const restore = vi.fn(() => Effect.die("file restore must not run"));
  const harness = makeRewindHarness({
    name: "rewind-refused",
    targetStatus: "error",
    checkpoints: {
      preflightRestore: () => Effect.succeed({ reason: "not-ready", folders: ["lib"] }),
      restore,
    },
  });
  return Effect.gen(function* () {
    const error = yield* Effect.flip(harness.execute(true));
    assert.equal(error.reason, "file-restore-refused");
    assert.equal(
      error.message,
      "Files in lib weren't checkpointed at that point. Rewind the conversation without restoring files instead.",
    );
    assert.equal(
      CheckpointRollbackService.rollbackFailureMessage(Cause.fail(error)),
      error.message,
    );
    assert.equal(harness.state.providerRollbacks, 0);
    assert.deepEqual(harness.state.writes, []);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("retries a failed file restore without rewinding the provider again", () => {
  let restoreAttempts = 0;
  let checkoutGone = false;
  const harness = makeRewindHarness({
    name: "rewind-retry",
    targetStatus: "ready",
    checkpoints: {
      preflightRestore: () =>
        Effect.sync(() =>
          checkoutGone ? { reason: "missing-checkout" as const, folders: ["lib"] } : undefined,
        ),
      restore: ({ scope, checkpoint }) =>
        ++restoreAttempts === 1
          ? Effect.fail(
              new CheckpointService.CheckpointRestoreError({
                scopeId: scope.id,
                checkpointId: checkpoint.id,
                restoredFolders: ["app"],
                unrestoredFolders: ["lib"],
                cause: "index.lock exists",
              }),
            )
          : Effect.void,
      // Refs left behind once everything is back don't fail the rewind.
      deleteStaleRefs: ({ scope, checkpoints }) =>
        Effect.fail(
          new CheckpointService.CheckpointDeleteStaleRefsError({
            scopeId: scope.id,
            checkpointIds: checkpoints.map((candidate) => candidate.id),
            cause: "not a git repository",
          }),
        ),
    },
  });
  return Effect.gen(function* () {
    const error = yield* Effect.flip(harness.execute(true));
    assert.equal(error.reason, "files-not-restored");
    assert.equal(
      CheckpointRollbackService.rollbackFailureMessage(Cause.fail(error)),
      "The conversation was rewound, but files in lib couldn't be restored. Files in app were restored.",
    );
    // The conversation was committed before the files; the turns stay until they are back.
    assert.equal(harness.state.nativeTurns, 1);
    assert.deepEqual(harness.statuses(), {
      runs: ["completed", "rolled_back", "rolled_back"],
      checkpoints: ["ready", "ready", "error"],
    });

    // A retry refused for its files says the conversation is already rewound.
    checkoutGone = true;
    const refused = yield* Effect.flip(harness.execute(true));
    assert.equal(refused.reason, "files-not-restored");
    assert.equal(
      refused.message,
      "The conversation was rewound, but its files weren't restored. The checkout for lib no longer exists.",
    );
    checkoutGone = false;

    yield* harness.execute(true);
    assert.equal(harness.state.providerRollbacks, 1);
    assert.equal(harness.state.nativeTurns, 1);
    assert.equal(restoreAttempts, 2);
    assert.deepEqual(harness.statuses(), {
      runs: ["completed", "rolled_back", "rolled_back"],
      checkpoints: ["ready", "stale", "stale"],
    });
  }).pipe(Effect.provide(harness.layer));
});

it("keeps a fixed message for failures that aren't about files", () => {
  assert.equal(
    CheckpointRollbackService.rollbackFailureMessage(Cause.fail(new Error("socket closed"))),
    CheckpointRollbackService.ROLLBACK_FAILED_MESSAGE,
  );
});
