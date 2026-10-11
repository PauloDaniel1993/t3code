import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { fileRestoreRefusalMessage, restoreIsolationRefusal } from "./CheckpointRestoreSafety.ts";
import {
  CheckpointRollbackServiceV2,
  layer as rollbackLayer,
} from "./CheckpointRollbackService.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

it.effect.each([
  "nested",
  "ancestor",
  "archived-nested",
  ...(symlinksSupported ? (["aliased-nested"] as const) : []),
  "project",
  "provider",
  "scope",
  "sibling",
  "stopped-provider",
  "errored-provider",
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
    const alias = path.join(parent, "alias");
    if (owner === "aliased-nested") yield* fs.symlink(nested, alias);
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
        owner === "project"
          ? null
          : owner === "ancestor" || owner === "conversation"
            ? parent
            : owner === "nested" || owner === "archived-nested"
              ? nested
              : owner === "aliased-nested"
                ? alias
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
      providerThreads: [providerThread],
      providerSessions: [],
      providerTurns: [],
      nodes: [],
      attempts: [],
      checkpoints: [{ id: checkpointId, scopeId, status: "ready", appRunOrdinal: null }],
      checkpointScopes: [{ id: scopeId, cwd }],
      runs: [{ id: "later-run", ordinal: 1, status: "completed", rootNodeId: null }],
    } as unknown as OrchestrationV2ThreadProjection;
    const testLayer = rollbackLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          idAllocatorLayer,
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeed(Option.some({ workspaceRoot: parent } as never)),
          }),
          Layer.mock(ProjectionStoreV2)({
            getThreadRecords: () => Effect.succeed(projection),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: owner === "archived-nested" ? [] : ([otherThread] as never),
                archivedThreads: owner === "archived-nested" ? ([otherThread] as never) : [],
              }),
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [],
                checkpoints: [],
                checkpointScopes: owner === "scope" ? ([{ cwd: nested }] as never) : [],
              }),
            getThreadProviderContext: () =>
              Effect.succeed({
                thread: otherThread as never,
                providerThreads: [],
                providerSessions: [
                  "provider",
                  "stopped-provider",
                  "errored-provider",
                  "shared-provider",
                ].includes(owner)
                  ? ([
                      {
                        // One session shared by every thread keeps the cwd of
                        // the thread that opened it, here this thread's.
                        cwd: owner === "shared-provider" ? cwd : nested,
                        status:
                          owner === "provider" || owner === "shared-provider"
                            ? "running"
                            : owner === "errored-provider"
                              ? "error"
                              : "stopped",
                        capabilities: {
                          sessions: {
                            supportsMultipleProviderThreadsPerSession: owner === "shared-provider",
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
    const service = yield* CheckpointRollbackServiceV2.pipe(Effect.provide(testLayer));
    const restoreFiles = owner !== "conversation";
    const rejected = !["sibling", "stopped-provider", "shared-provider", "conversation"].includes(
      owner,
    );
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
  // lib is restored in place, outside the thread's own worktrees.
  { owner: "foreign-part", nested: false, shared: ["lib"] },
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
            threads: owner === "none" || owner === "foreign-part" ? [] : [otherThread as never],
            archivedThreads: [],
          }),
        getCheckpointContext: () =>
          Effect.succeed({ runs: [], checkpointScopes: [], checkpoints: [] }),
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
          worktrees: owner === "foreign-part" ? [member(app)] : [member(app), member(lib)],
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
