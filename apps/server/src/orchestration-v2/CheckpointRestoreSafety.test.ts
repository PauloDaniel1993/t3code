import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import {
  fileRestoreRefusal,
  fileRestoreRefusalMessage,
  restoreIsolationRefusal,
} from "./CheckpointRestoreSafety.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2, type ProjectionCheckpointRollbackContext } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

it.effect.each([
  "nested",
  "ancestor",
  "provider",
  "sibling",
  "shared-provider",
  "conversation",
] as const)("preserves overlapping workspace files, owner=%s", (owner) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-restore-" });
    const cwd = path.join(parent, "worktree");
    const nested = path.join(cwd, "nested");
    const sibling = path.join(parent, "worktree2");
    yield* fs.makeDirectory(nested, { recursive: true });
    yield* fs.makeDirectory(sibling);
    const otherFile = path.join(nested, "other-thread.txt");
    yield* fs.writeFileString(otherFile, "other thread's uncommitted work");
    const threadId = ThreadId.make("restore-current");
    const otherId = ThreadId.make("restore-other");
    const projectId = ProjectId.make("restore-project");
    const providerThreadId = ProviderThreadId.make("restore-provider");
    const providerSessionId = ProviderSessionId.make("restore-session");
    const instanceId = ProviderInstanceId.make("restore-instance");
    const checkpointId = CheckpointId.make("restore-checkpoint");
    const scopeId = CheckpointScopeId.make("restore-scope");
    const calls: string[] = [];
    const providerThread = {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId: instanceId,
    };
    const otherThread = {
      id: otherId,
      projectId,
      deletedAt: null,
      worktreePath:
        owner === "ancestor" || owner === "conversation"
          ? parent
          : owner === "nested"
            ? nested
            : sibling,
    };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        worktreePath: cwd,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId, model: "test" },
      },
      providerThread,
      providerSession: undefined,
      providerTurns: [],
      rootNodes: [],
      targetAttempt: undefined,
      rolledBackAttemptIds: [],
      staleCheckpoints: [],
      checkpoint: { id: checkpointId, scopeId, status: "ready", appRunOrdinal: null },
      scope: { id: scopeId, cwd },
      runsToRollback: [{ id: "later-run", ordinal: 1, status: "completed", rootNodeId: null }],
    } as unknown as ProjectionCheckpointRollbackContext;
    const layerTest = CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ServerConfig.ServerConfig)({ worktreesDir: "/synthetic-worktrees" } as never),
          ServerSettings.layerTest(),
          ThreadCommandExecutor.layer,
          IdAllocator.layer,
          Layer.mock(GitWorkflowService.GitWorkflowService)({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeed(Option.some({ workspaceRoot: parent } as never)),
          }),
          Layer.mock(ProjectionStoreV2)({
            getThread: () => Effect.succeed(projection.thread),
            getCheckpointRollbackContext: () => Effect.succeed(projection),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [otherThread] as never,
                archivedThreads: [],
              }),
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [],
                checkpoints: [],
                checkpointScopes: [],
              }),
            getThreadProviderContext: () =>
              Effect.succeed({
                thread: otherThread as never,
                providerThreads: [],
                providerSessions:
                  owner === "provider" || owner === "shared-provider"
                    ? ([
                        {
                          cwd: owner === "shared-provider" ? cwd : nested,
                          status: "running",
                          capabilities: {
                            sessions: {
                              supportsMultipleProviderThreadsPerSession:
                                owner === "shared-provider",
                            },
                          },
                        },
                      ] as never)
                    : [],
              }),
          }),
          Layer.mock(CheckpointServiceV2)({
            preflightRestore: () => Effect.succeed(undefined),
            restore: () =>
              Effect.gen(function* () {
                calls.push("files");
                yield* fs.remove(otherFile).pipe(Effect.orDie);
              }),
          }),
          Layer.mock(EventSinkV2)({ write: () => Effect.succeed([]) }),
          Layer.mock(ProviderSessionManagerV2)({
            open: () =>
              Effect.succeed({
                rollbackThread: () =>
                  Effect.sync(() => {
                    calls.push("provider");
                    return { providerThread };
                  }),
              } as never),
          }),
          Layer.mock(RuntimePolicyV2)({
            resolve: () => Effect.succeed({} as never),
            requireWorkspaceFolderAccess: () => Effect.void,
          }),
        ),
      ),
    );
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2.pipe(
      Effect.provide(layerTest),
    );
    const restoreFiles = owner !== "conversation";
    const rejected = !["sibling", "shared-provider", "conversation"].includes(owner);
    if (rejected) {
      const error = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.flip);
      assert.equal(error.reason, "file-restore-refused");
      assert.match(error.message, /isolated worktree/);
      assert.deepEqual(calls, []);
      assert.equal(yield* fs.readFileString(otherFile), "other thread's uncommitted work");
    } else {
      yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles });
      assert.deepEqual(calls, restoreFiles ? ["provider", "files"] : ["provider"]);
      assert.equal(yield* fs.exists(otherFile), !restoreFiles);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  // A thread's own nested members never conflict with each other.
  { owner: "none", nested: true, shared: [] },
  { owner: "extra-directory", nested: false, shared: ["lib"] },
  { owner: "root-folder", nested: false, shared: ["lib"] },
  { owner: "member", nested: false, shared: ["app"] },
  // Where the other thread's latest run checkpoints; older places are history.
  { owner: "scope-part", nested: false, shared: ["lib"] },
  { owner: "history", nested: false, shared: [] },
  // lib is restored in place, outside the thread's own worktrees.
  { owner: "foreign-part", nested: false, shared: ["lib"] },
  // Windows paths name one place however they are cased.
  { owner: "case", nested: false, shared: [] },
] as const)(
  "restores only parts no other thread reaches, owner=$owner",
  ({ owner, nested, shared }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-restore-parts-" });
      const session = path.join(parent, "session");
      const app = path.join(session, "app");
      const lib = nested ? path.join(app, "lib") : path.join(session, "lib");
      const otherRoot = path.join(parent, "other-source");
      const otherWorktree = path.join(parent, "other-worktree");
      for (const directory of [app, lib, path.join(lib, "sub"), otherRoot, otherWorktree]) {
        yield* fs.makeDirectory(directory, { recursive: true });
      }
      const projectId = ProjectId.make("restore-parts-project");
      const otherId = ThreadId.make("restore-parts-other");
      const member = (worktree: string) => ({
        repositoryRoot: path.join(parent, "source", path.basename(worktree)),
        path: worktree,
        branch: "feature",
      });
      const otherThread = {
        id: otherId,
        projectId,
        deletedAt: null,
        worktreePath: owner === "root-folder" ? null : otherWorktree,
        ...(owner === "member" ? { worktrees: [member(app)] } : {}),
        ...(owner === "root-folder" ? { workspaceFolderCount: 2 } : {}),
      };
      const projections = ProjectionStoreV2.of({
        getShellSnapshot: () =>
          Effect.succeed({
            schemaVersion: 1,
            snapshotSequence: 0,
            threads: ["none", "foreign-part", "case"].includes(owner) ? [] : [otherThread as never],
            archivedThreads: [],
          }),
        getCheckpointContext: () =>
          Effect.succeed({
            runs: [],
            checkpointScopes: [
              { cwd: otherWorktree, ...(owner === "scope-part" ? { parts: [{ cwd: lib }] } : {}) },
            ],
            checkpoints: owner === "history" ? [{ parts: [{ cwd: lib }] }] : [],
          } as never),
        getThreadProviderContext: () =>
          Effect.succeed({
            providerSessions:
              owner === "extra-directory"
                ? [
                    {
                      cwd: otherWorktree,
                      additionalDirectories: [path.join(lib, "sub")],
                      status: "running",
                      capabilities: {
                        sessions: { supportsMultipleProviderThreadsPerSession: false },
                      },
                    },
                  ]
                : [],
          } as never),
        getThread: () =>
          Effect.succeed({
            worktreePath: null,
            workspaceFolders: [
              { path: otherRoot, name: "other", label: "other" },
              { path: path.join(lib, "sub"), name: "sub", label: "sub" },
            ],
          } as never),
      } as never);
      const refusal = yield* restoreIsolationRefusal(
        {
          id: ThreadId.make("restore-parts-current"),
          worktreePath: app,
          worktrees:
            owner === "foreign-part"
              ? [member(app)]
              : [
                  member(app),
                  member(owner === "case" && isWindowsAbsolutePath(lib) ? lib.toUpperCase() : lib),
                ],
        },
        [
          { cwd: app, folders: [{ folderPath: "/source/app", label: "app", relativePath: "" }] },
          { cwd: lib, folders: [{ folderPath: "/source/lib", label: "lib", relativePath: "" }] },
        ],
        {
          fileSystem: fs,
          path,
          projections,
          projects: ProjectStore.ProjectStoreV2.of({
            get: () => Effect.succeed(Option.some({ workspaceRoot: otherRoot } as never)),
          } as never),
        },
      );
      assert.deepStrictEqual(
        refusal,
        shared.length === 0 ? undefined : { reason: "shared", folders: shared },
      );
      if (refusal !== undefined) {
        assert.equal(
          fileRestoreRefusalMessage(refusal),
          `File restore requires isolated worktrees. ${shared.join(", ")} may contain changes from another thread. Rewind the conversation without restoring files instead.`,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([false, true])("lets rollback recreate removed worktrees, set=%s", (set) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-v2-restore-removed-" });
    const worktreePath = path.join(parent, "app");
    const libPath = path.join(parent, "lib");
    const refusal = yield* restoreIsolationRefusal(
      {
        id: ThreadId.make("restore-removed"),
        worktreePath,
        ...(set
          ? {
              worktrees: [
                {
                  repositoryRoot: path.join(parent, "source-app"),
                  path: worktreePath,
                  branch: "feature",
                },
                {
                  repositoryRoot: path.join(parent, "source-lib"),
                  path: libPath,
                  branch: "feature",
                },
              ],
            }
          : {}),
      },
      [{ cwd: worktreePath, folders: [] }, ...(set ? [{ cwd: libPath, folders: [] }] : [])],
      {
        fileSystem,
        path,
        projections: {
          getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
        } as never,
        projects: {} as never,
      },
    );
    assert.isUndefined(refusal);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("checks removed members' refs at their sources only during admission", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-restore-admission-" });
    const members = ["app", "lib"].map((name) => ({
      repositoryRoot: path.join(parent, `source-${name}`),
      path: path.join(parent, name),
      branch: "feature",
    }));
    const parts = members.map((member, index) => ({
      key: String(index),
      cwd: member.path,
      vcs: "git" as const,
      pathspecs: ["."],
      folders: [{ folderPath: member.repositoryRoot, relativePath: "", label: String(index) }],
      ref: CheckpointRef.make(`refs/t3/checkpoint/${index}`),
      status: "ready" as const,
    }));
    const checked: string[][] = [];
    const dependencies = {
      fileSystem,
      path,
      projections: {
        getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
      } as never,
      projects: {} as never,
      checkpoints: {
        preflightRestore: ({ checkpoint }: { checkpoint: OrchestrationV2Checkpoint }) => {
          const locations = checkpoint.parts!.map((part) => part.cwd);
          checked.push(locations);
          return Effect.succeed(
            locations.every((cwd) => members.some((member) => member.repositoryRoot === cwd))
              ? undefined
              : { reason: "missing-checkout" as const, folders: ["0", "1"] },
          );
        },
      },
    };
    const thread = {
      id: ThreadId.make("restore-admission"),
      worktreePath: members[0]!.path,
      worktrees: members,
    };
    const scope = { cwd: members[0]!.path } as OrchestrationV2CheckpointScope;
    const checkpoint = {
      id: CheckpointId.make("restore-admission-checkpoint"),
      threadId: thread.id,
      scopeId: CheckpointScopeId.make("restore-admission-scope"),
      runId: null,
      nodeId: NodeId.make("restore-admission-node"),
      parentCheckpointId: null,
      ordinalWithinScope: 0,
      appRunOrdinal: null,
      ref: parts[0]!.ref,
      status: "ready",
      files: [],
      parts,
      capturedAt: yield* DateTime.now,
    } satisfies OrchestrationV2Checkpoint;
    assert.isUndefined(yield* fileRestoreRefusal(thread, scope, checkpoint, dependencies));
    assert.deepEqual(checked, [
      members.map((member) => member.path),
      members.map((member) => member.repositoryRoot),
    ]);
    checked.length = 0;
    assert.equal(
      (yield* fileRestoreRefusal(thread, scope, checkpoint, {
        ...dependencies,
        allowMissingWorktrees: false,
      }))?.reason,
      "missing-checkout",
    );
    assert.deepEqual(checked, [members.map((member) => member.path)]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
