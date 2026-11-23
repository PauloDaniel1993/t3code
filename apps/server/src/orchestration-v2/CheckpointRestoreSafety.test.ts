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
import * as Path from "effect/Path";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import {
  fileRestoreRefusal,
  fileRestoreRefusalMessage,
  restoreIsolationRefusal,
  isCheckpointRestoreIsolated,
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
import { layerNoTaskFolders } from "./ProviderTurnStartService.testkit.ts";

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
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: otherId },
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
        deletedAt: null,
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
          layerNoTaskFolders,
          Layer.mock(GitWorkflowService.GitWorkflowService)({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeedSome({ workspaceRoot: parent } as never),
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
            preflightRestore: () => Effect.undefined,
            discardRepositorySnapshots: () => Effect.void,
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
            get: () => Effect.succeedSome({ workspaceRoot: otherRoot } as never),
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
          `File restore requires isolated worktrees. ${shared.join(", ")} may contain changes from another thread or a side chat. Rewind the conversation without restoring files instead, or delete side chats you no longer need.`,
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
        preflightRestore: ({
          checkpoint,
        }: {
          checkpoint: Pick<OrchestrationV2Checkpoint, "parts">;
        }) => {
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

it.effect.each([false, true])(
  "checks a removed singular worktree's refs using its frozen binding: %s",
  (frozen) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-restore-frozen-" });
      const original = path.join(parent, "original");
      const relinked = path.join(parent, "relinked");
      const cwd = path.join(parent, "removed-worktree");
      const thread = { id: ThreadId.make("restore-frozen"), worktreePath: cwd };
      const scope = { cwd } as OrchestrationV2CheckpointScope;
      const checkpoint = {
        ref: CheckpointRef.make("refs/t3/checkpoint/frozen"),
      } as OrchestrationV2Checkpoint;
      const checked: string[][] = [];
      const refusal = yield* fileRestoreRefusal(thread, scope, checkpoint, {
        fileSystem,
        path,
        projects: { get: () => Effect.succeedSome({ workspaceRoot: relinked }) } as never,
        projections: {
          getThread: () =>
            Effect.succeed({
              projectId: ProjectId.make("restore-frozen-project"),
              ...(frozen ? { workspaceFolders: [{ path: original, label: "original" }] } : {}),
            }),
          getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
        } as never,
        checkpoints: {
          preflightRestore: ({ checkpoint }) => {
            const locations = checkpoint.parts?.map((part) => part.cwd) ?? [cwd];
            checked.push(locations);
            return Effect.succeed(
              locations[0] === (frozen ? original : relinked)
                ? undefined
                : { reason: "missing-checkout" as const, folders: [] },
            );
          },
        },
      });
      assert.isUndefined(refusal);
      assert.deepEqual(checked, [[cwd], [frozen ? original : relinked]]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("counts a task folder's repository worktrees as part of what a restore changes", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-v2-restore-task-folder-" }),
    );
    // The worktrees directory is reached through a symlink; the other thread holds the real path.
    const real = path.join(parent, "real", "task");
    const named = path.join(parent, "linked", "task");
    yield* fileSystem.makeDirectory(path.join(real, "shop"), { recursive: true });
    yield* fileSystem.makeDirectory(path.join(real, "web"));
    yield* fileSystem.symlink(path.join(parent, "real"), path.join(parent, "linked"));
    const worktreePath = path.join(named, "shop");
    const other = {
      id: ThreadId.make("restore-task-folder-other"),
      projectId: ProjectId.make("restore-project"),
      deletedAt: null,
      worktreePath: path.join(real, "web"),
      activeRunId: null,
      lineage: {},
    };
    const isolated = (repositories: ReadonlyArray<string>) =>
      isCheckpointRestoreIsolated(
        { id: ThreadId.make("restore-task-folder"), worktreePath },
        { cwd: path.join(real, "shop") },
        {
          repositories: repositories.map((folder) => ({
            repositoryPath: "/tracked/web",
            worktreePath: folder,
            name: "web",
          })),
        },
        {
          fileSystem,
          path,
          projections: {
            getShellSnapshot: () => Effect.succeed({ threads: [other], archivedThreads: [] }),
            getCheckpointContext: () => Effect.succeed({ checkpointScopes: [] }),
            getThreadProviderContext: () => Effect.succeed({ providerSessions: [] }),
          } as never,
          projects: {} as never,
        },
      );

    assert.isTrue(yield* isolated([]));
    assert.isFalse(yield* isolated([path.join(named, "web")]));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { sideChat: "answering questions", running: false, toolItems: 0, isolated: true },
  { sideChat: "running", running: true, toolItems: 0, isolated: false },
  { sideChat: "after running tools", running: false, toolItems: 1, isolated: false },
] as const)(
  "a side chat $sideChat shares the parent's worktree: $isolated",
  ({ running, toolItems, isolated }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktreePath = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-v2-restore-side-chat-",
      });
      const parentId = ThreadId.make("restore-side-chat-parent");
      const sideChat = {
        id: ThreadId.make("restore-side-chat"),
        projectId: ProjectId.make("restore-project"),
        deletedAt: null,
        worktreePath,
        activeRunId: running ? "side-chat-run" : null,
        lineage: {
          parentThreadId: parentId,
          relationshipToParent: "fork",
          rootThreadId: parentId,
          sideChat: true,
        },
      };
      const result = yield* restoreIsolationRefusal(
        { id: parentId, worktreePath },
        [{ cwd: worktreePath, folders: [] }],
        {
          fileSystem,
          path,
          projections: {
            getShellSnapshot: () => Effect.succeed({ threads: [sideChat], archivedThreads: [] }),
            getThreadRecords: () =>
              Effect.succeed({
                turnItems: Array.from({ length: toolItems }, () => ({ type: "command_execution" })),
              }),
            getCheckpointContext: () => Effect.succeed({ checkpointScopes: [] }),
            getThreadProviderContext: () => Effect.succeed({ providerSessions: [] }),
          } as never,
          projects: {} as never,
        },
      );
      assert.equal(result === undefined, isolated);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { name: "completed child", isolated: true },
  { name: "completed native child", isolated: true },
  { name: "native child with running tool", isolated: false },
  { name: "native child with provider background task", isolated: false },
  { name: "native child with parent background task", isolated: false },
  { name: "native child with another provider parent task", isolated: true },
  { name: "native child grandchild with root background task", isolated: false },
  { name: "missing task record", isolated: false },
  { name: "task belongs to another child", isolated: false },
  { name: "completed child with pending task", isolated: false },
  { name: "grandchild through fork", isolated: false },
  { name: "completed grandchild", isolated: true },
  { name: "unrelated child", isolated: false },
  { name: "running child", isolated: false },
  { name: "held queue", isolated: false },
  { name: "failed child", isolated: false },
  { name: "cyclic ancestry", isolated: false },
] as const)("parent file restore with $name: $isolated", ({ name, isolated }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const worktreePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-restore-child-" });
    const parentId = ThreadId.make("restore-parent");
    const childId = ThreadId.make("restore-child");
    const ancestorId = ThreadId.make("restore-ancestor");
    const child = {
      id: childId,
      projectId: ProjectId.make("restore-project"),
      deletedAt: null,
      worktreePath,
      activeRunId: name === "running child" ? "child-run" : null,
      activityRunStatus: null,
      latestRunId: name.includes("native child") ? null : "child-run",
      creationSource: name.includes("native child") ? "provider" : "user",
      forkedFrom: { type: "node", nodeId: "child-task" },
      status: name.includes("native child")
        ? "idle"
        : name === "running child"
          ? "running"
          : name === "failed child"
            ? "failed"
            : "completed",
      pendingRuntimeRequest: null,
      pendingBackgroundTasks: [],
      lineage: {
        parentThreadId:
          name === "completed grandchild" ||
          name === "native child grandchild with root background task" ||
          name === "grandchild through fork" ||
          name === "cyclic ancestry"
            ? ancestorId
            : name === "unrelated child"
              ? ThreadId.make("another-parent")
              : parentId,
        relationshipToParent: "subagent",
        rootThreadId: parentId,
      },
    };
    const ancestor = {
      ...child,
      id: ancestorId,
      forkedFrom: { type: "node", nodeId: "ancestor-task" },
      lineage: {
        ...child.lineage,
        relationshipToParent: name === "grandchild through fork" ? "fork" : "subagent",
        parentThreadId: name === "cyclic ancestry" ? childId : parentId,
      },
    };
    const children =
      name === "completed grandchild" ||
      name === "native child grandchild with root background task" ||
      name === "grandchild through fork" ||
      name === "cyclic ancestry"
        ? [child, ancestor]
        : [child];
    const projections = {
      getShellSnapshot: () =>
        Effect.succeed({
          threads: children,
          archivedThreads: [],
        }),
      getCheckpointContext: () =>
        Effect.succeed({
          checkpointScopes: [],
          runs: name === "held queue" ? [{ status: "queued" }] : [],
        }),
      getThreadProviderContext: () => Effect.succeed({ providerSessions: [] }),
      getThreadRecords: (
        _threadId: unknown,
        _fields: readonly string[],
        filter: { subagentIds?: string[]; turnItemStatuses?: string[] } = {},
      ) =>
        Effect.succeed({
          providerThreads:
            _threadId === parentId &&
            (name.includes("parent") ||
              name === "native child grandchild with root background task") &&
            name.includes("native child")
              ? [
                  {
                    providerInstanceId:
                      name === "native child with another provider parent task"
                        ? "other-provider"
                        : "claude",
                    status: "idle",
                    pendingBackgroundTasks: [{ taskId: "background", kind: "command" }],
                  },
                ]
              : name === "native child with provider background task"
                ? [{ status: "idle", pendingBackgroundTasks: [{ taskId: "background" }] }]
                : [],
          turnItems:
            filter.turnItemStatuses !== undefined && name === "native child with running tool"
              ? [{ type: "command_execution", status: "running" }]
              : [],
          subagents:
            name === "missing task record"
              ? []
              : [
                  {
                    id: filter.subagentIds?.[0],
                    providerInstanceId: "claude",
                    nativeTaskRef: { nativeId: "native-task" },
                    childThreadId:
                      name === "task belongs to another child"
                        ? "another-child"
                        : filter.subagentIds?.[0] === "ancestor-task"
                          ? ancestorId
                          : childId,
                    origin: name.includes("native child") ? "provider_native" : "app_owned",
                    status: name === "completed child with pending task" ? "running" : "completed",
                  },
                ],
        }),
    };
    const result = yield* isCheckpointRestoreIsolated(
      { id: parentId, worktreePath },
      { cwd: worktreePath },
      null,
      { fileSystem, path, projections: projections as never, projects: {} as never },
    );
    assert.equal(result, isolated);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
