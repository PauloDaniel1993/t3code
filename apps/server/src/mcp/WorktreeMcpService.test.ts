import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  GitCommandError,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadWorkspaceFolder,
  type OrchestrationV2ThreadWorktree,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeMcpHandoffInput,
  WorkspaceScopeError,
} from "@t3tools/contracts";
import { isSamePath, resolveThreadWorkspace } from "@t3tools/shared/workspaceFolders";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as WorktreeSet from "../orchestration-v2/WorktreeSetService.ts";
import * as ServerConfig from "../config.ts";
import * as WorkspaceFolderResolver from "../project/WorkspaceFolderResolver.ts";
import * as WorkspaceFolderFiles from "../workspace/WorkspaceFolderFiles.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment-worktree-test");
const threadId = ThreadId.make("thread-worktree-test");
const projectId = ProjectId.make("project-worktree-test");
const workspaceRoot = "/repo/project";

const makeScope = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-worktree-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-worktree-test",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  capabilities,
  issuedAt: 1,
});

interface ThreadFixture {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
  readonly workspaceFolders?: ReadonlyArray<OrchestrationV2ThreadWorkspaceFolder>;
  readonly worktrees?: ReadonlyArray<OrchestrationV2ThreadWorktree>;
}

const makeProjection = (overrides: ThreadFixture = {}) => {
  const { archivedAt, deletedAt, ...binding } = overrides;
  const providerInstanceId = ProviderInstanceId.make("claudeAgent");
  return idleThreadProjection({
    ...liveThreadShell(threadId, { activeRunId: null }),
    projectId,
    title: "Worktree test thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "claude-test" },
    ...binding,
    archivedAt: archivedAt == null ? null : DateTime.makeUnsafe(archivedAt),
    deletedAt: deletedAt == null ? null : DateTime.makeUnsafe(deletedAt),
  });
};

const project: Project = {
  id: projectId,
  title: "Worktree test project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

interface HarnessOptions {
  readonly git?: Partial<GitWorkflowService.GitWorkflowService["Service"]>;
  readonly thread?: ThreadFixture | null;
  readonly threadReadError?: "projection" | "dispatch";
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly currentBranch?: string | null;
  readonly notARepo?: boolean;
  readonly newWorktreesStartFromOrigin?: boolean;
  readonly setupScript?: "started" | "no-script" | "fails" | "dies";
  readonly dispatchFails?: boolean;
  readonly providerDisabledAtBind?: boolean;
  readonly dispatchDies?: boolean;
  readonly dispatchInterrupts?: boolean;
  readonly dispatchGate?: Effect.Effect<void>;
  readonly threadAttachedOnRecheck?: boolean;
  readonly threadArchivedOnRecheck?: boolean;
  readonly threadReadFailsOnRecheck?: boolean;
  readonly continuation?: "queued" | "fails" | "dies";
  readonly projectMissing?: boolean;
  readonly projectLinked?: boolean;
  readonly projectReadFails?: boolean;
  readonly existingBranchWorktreePath?: string | null;
  readonly createWorktreeFails?: boolean;
  readonly fetchWorktreeBaseFails?: boolean;
  readonly worktreeBaseMissing?: boolean;
  readonly removeWorktreeFails?: boolean;
  readonly deleteLocalBranchFails?: boolean;
  readonly createWorktreeGate?: Effect.Effect<void>;
  readonly unavailableFolders?: ReadonlyArray<string>;
  readonly folderCheckouts?: Readonly<Record<string, string>>;
  readonly folderReadFails?: boolean;
  readonly handoffOnFolderRead?: boolean;
  readonly listRefsError?: "spawn" | "timeout";
}

const makeHarness = (options: HarnessOptions = {}) => {
  const thread = options.thread === undefined ? {} : options.thread;
  let boundThread = thread;
  const scope = makeScope(
    options.capabilities ?? new Set(["preview", "worktree", "orchestration"]),
  );
  const dispatch = vi.fn(
    (
      command: Parameters<
        ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
      >[0],
    ) =>
      (options.dispatchGate ?? Effect.void).pipe(
        Effect.andThen(
          options.dispatchInterrupts
            ? (Effect.failCause(Cause.interrupt()) as never)
            : options.dispatchDies
              ? Effect.die(new Error("dispatch defect"))
              : options.providerDisabledAtBind
                ? Effect.fail(
                    new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                      projectId,
                      instanceId: ProviderInstanceId.make("claudeAgent"),
                    }),
                  )
                : options.dispatchFails
                  ? (Effect.fail("simulated dispatch failure") as never)
                  : Effect.succeed({ sequence: 1, storedEvents: [] }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            if (command.type === "thread.metadata.update" && boundThread !== null) {
              boundThread = {
                ...boundThread,
                ...(command.branch === undefined ? {} : { branch: command.branch }),
                ...(command.worktreePath === undefined
                  ? {}
                  : { worktreePath: command.worktreePath }),
                ...(command.workspaceFolders === undefined
                  ? {}
                  : { workspaceFolders: command.workspaceFolders }),
                ...(command.worktrees == null ? {} : { worktrees: command.worktrees }),
              };
            }
          }),
        ),
      ),
  );
  const listLocalBranchNames = vi.fn((_: string) =>
    Effect.succeed(
      options.existingBranchWorktreePath === undefined
        ? ["dev"]
        : ["dev", "feature/taken", "feature/taken-idle"],
    ),
  );
  const getThreadRecords = vi.fn(
    (
      id: ThreadId,
    ): Effect.Effect<
      OrchestrationV2ThreadProjection,
      OrchestratorDispatchError | OrchestratorProjectionError
    > => {
      if (options.threadReadError === "dispatch") {
        return Effect.fail(
          new OrchestratorDispatchError({
            commandId: CommandId.make("command:test:read"),
            commandType: "thread.metadata.update",
          }),
        );
      }
      if (options.threadReadFailsOnRecheck === true && getThreadRecords.mock.calls.length > 1) {
        return Effect.fail(
          new OrchestratorDispatchError({
            commandId: CommandId.make("command:test:recheck"),
            commandType: "thread.metadata.update",
          }),
        );
      }
      if (
        options.threadAttachedOnRecheck === true &&
        getThreadRecords.mock.calls.length > 1 &&
        thread !== null
      ) {
        return Effect.succeed(
          makeProjection({ ...thread, worktreePath: "/worktrees/project/raced" }),
        );
      }
      if (
        options.threadArchivedOnRecheck === true &&
        getThreadRecords.mock.calls.length > 1 &&
        thread !== null
      ) {
        return Effect.succeed(
          makeProjection({ ...thread, archivedAt: "2026-01-02T00:00:00.000Z" }),
        );
      }
      return id === threadId && thread !== null
        ? Effect.succeed(makeProjection(boundThread ?? thread))
        : Effect.fail(new OrchestratorProjectionError({ threadId: id }));
    },
  );
  const sendToThread = vi.fn((_: unknown) => {
    switch (options.continuation ?? "queued") {
      case "fails":
        return Effect.fail(
          new ThreadManagementService.ThreadManagementThreadArchivedError({
            threadId,
          }),
        );
      case "dies":
        return Effect.die(new Error("send defect"));
      default:
        return Effect.succeed({
          delivery: "queued",
        } as ThreadManagementService.ThreadManagementSendResult);
    }
  });
  const getById = vi.fn((id: ProjectId) =>
    options.projectReadFails
      ? (Effect.fail("simulated project read failure") as never)
      : Effect.succeed(
          id === projectId && options.projectMissing !== true
            ? Option.some(
                options.projectLinked === true
                  ? { ...project, workspaceFile: "/workspace/project.code-workspace" }
                  : project,
              )
            : Option.none(),
        ),
  );
  const removeWorktree = vi.fn((_: unknown) =>
    options.removeWorktreeFails
      ? (Effect.fail("simulated worktree removal failure") as never)
      : Effect.void,
  );
  const deleteLocalBranch = vi.fn((_: unknown) =>
    options.deleteLocalBranchFails
      ? (Effect.fail("simulated local branch deletion failure") as never)
      : Effect.void,
  );
  const fetchWorktreeBaseCommit = vi.fn((_: unknown) =>
    options.fetchWorktreeBaseFails
      ? (Effect.fail("simulated fetch failure") as never)
      : options.worktreeBaseMissing
        ? Effect.succeed(null)
        : Effect.succeed({ commitSha: "abc123", remoteRefName: "origin/dev" }),
  );
  const createWorktree = vi.fn(
    (input: { readonly newRefName?: string | undefined; readonly path: string | null }) =>
      options.createWorktreeFails
        ? (Effect.fail("simulated worktree creation failure") as never)
        : (options.createWorktreeGate ?? Effect.void).pipe(
            Effect.andThen(
              Effect.succeed({
                worktree: {
                  path: input.path ?? `/worktrees/project/${input.newRefName}`,
                  refName: input.newRefName ?? "detached",
                },
              }),
            ),
          ),
  );
  const listRefs = vi.fn((input: { readonly query?: string | undefined }) =>
    options.listRefsError
      ? Effect.fail(
          new GitCommandError({
            operation: "listRefs",
            command: "git",
            cwd: workspaceRoot,
            detail: `Git ${options.listRefsError} failure`,
          }),
        )
      : Effect.succeed({
          refs:
            options.existingBranchWorktreePath === undefined
              ? []
              : [
                  {
                    name: input.query ?? "",
                    current: false,
                    isDefault: false,
                    worktreePath: options.existingBranchWorktreePath,
                  },
                ],
          isRepo: options.notARepo !== true,
          hasPrimaryRemote: options.notARepo !== true,
          nextCursor: null,
          totalCount: options.existingBranchWorktreePath === undefined ? 0 : 1,
        }),
  );
  const localStatus = vi.fn((_: unknown) =>
    Effect.succeed({
      isRepo: options.notARepo !== true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: options.currentBranch === undefined ? "dev" : options.currentBranch,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    }),
  );
  const refreshStatus = vi.fn((_: string) => Effect.die("refreshStatus stub"));
  const runForThread = vi.fn((input: { readonly worktreePath: string }) => {
    switch (options.setupScript ?? "started") {
      case "no-script":
        return Effect.succeed({ status: "no-script" } as const);
      case "dies":
        return Effect.die(new Error("setup runner defect"));
      case "fails":
        return Effect.fail(
          new ProjectSetupScriptRunner.ProjectSetupScriptProjectNotFoundError({
            threadId,
            worktreePath: input.worktreePath,
          }),
        );
      default:
        return Effect.succeed({
          status: "started",
          async: false,
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "vp install",
          terminalId: "setup-terminal",
          cwd: input.worktreePath,
        } as const);
    }
  });

  const services = Layer.mergeAll(
    Layer.mock(WorkspaceFolderFiles.WorkspaceFolderFiles)({
      resolveScope: (scope, capturedFolders) => {
        if (options.folderReadFails)
          return Effect.fail(new WorkspaceScopeError({ ...scope, failure: "read-failed" }));
        if (options.handoffOnFolderRead) {
          boundThread = {
            ...boundThread,
            worktreePath: "/worktrees/raced",
            branch: "feature/raced",
          };
        }
        const folders = (
          capturedFolders ??
          resolveThreadWorkspace({
            thread: makeProjection(boundThread ?? {}).thread,
            project,
          }).folders
        ).map((folder) =>
          options.unavailableFolders?.includes(folder.folder.path ?? folder.folder.uri ?? "")
            ? { ...folder, effectivePath: null }
            : folder,
        );
        const selected =
          scope.folderPath === undefined
            ? folders
            : folders.filter((folder) =>
                folder.folder.path === undefined
                  ? folder.folder.uri === scope.folderPath
                  : isSamePath(folder.folder.path, scope.folderPath!),
              );
        return selected.length === 0
          ? Effect.fail(
              new WorkspaceScopeError({
                ...scope,
                failure: "folder-not-found",
                folder: scope.folderPath,
              }),
            )
          : Effect.succeed({ folders, selected });
      },
    }),
    Layer.mock(WorkspaceFolderResolver.WorkspaceFolderResolver)({
      probe: (folderPath) =>
        Effect.succeed({
          path: folderPath,
          availability: "available",
          vcs: options.notARepo
            ? null
            : {
                checkoutRoot: options.folderCheckouts?.[folderPath] ?? folderPath,
                checkoutPrefix: "",
                commonDir: folderPath + "/.git",
              },
        }),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch,
      getThreadRecords,
      getThreadShell: (id) =>
        id !== threadId || thread === null
          ? Effect.succeed(null)
          : getThreadRecords(id).pipe(Effect.map(ProjectionStore.threadShellFromProjection)),
      getProjectThreadRecords: ({ projectId, threadId }) =>
        getThreadRecords(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new ThreadManagementService.ThreadManagementProjectionLoadError({
                projectId,
                threadId,
                cause,
              }),
          ),
        ),
      sendToThread,
    } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
    Layer.mock(ProjectService.ProjectService)({
      getById,
    } satisfies Partial<ProjectService.ProjectService["Service"]>),
    ServerSettings.layerTest({
      newWorktreesStartFromOrigin: options.newWorktreesStartFromOrigin ?? false,
    }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      listRefs,
      listLocalBranchNames,
      localStatus,
      remoteExists: () => Effect.succeed(true),
      remoteBranchExists: () => Effect.succeed(true),
      resolveWorktreeBaseRemote: () => Effect.succeed({ remoteName: "origin", branchName: "dev" }),
      fetchWorktreeBaseCommit,
      createWorktree,
      removeWorktree,
      deleteLocalBranch,
      ...options.git,
    } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread,
    } satisfies Partial<ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]>),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      refreshStatus,
    } satisfies Partial<VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]>),
    NodeServices.layer,
  );
  // The real coordinator over the same git and thread mocks; every folder is
  // its own checkout's root.
  const worktreeSets = WorktreeSet.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        services,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        Layer.mock(WorkspaceFolderResolver.WorkspaceFolderResolver)({
          probe: (folderPath) =>
            Effect.succeed({
              path: folderPath,
              availability: "available",
              vcs: {
                checkoutRoot: folderPath,
                checkoutPrefix: "",
                commonDir: folderPath + "/.git",
              },
            }),
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-mcp-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
  const layer = WorktreeMcpService.layer.pipe(Layer.provide(Layer.merge(services, worktreeSets)));

  return {
    layer,
    scope,
    dispatch,
    sendToThread,
    fetchWorktreeBaseCommit,
    createWorktree,
    removeWorktree,
    deleteLocalBranch,
    localStatus,
    listRefs,
    runForThread,
  };
};

const expectTypedFailure = (exit: Exit.Exit<unknown, unknown>, expected: object): void => {
  if (!Exit.isFailure(exit)) {
    expect.fail(`Expected a failure exit, got: ${JSON.stringify(exit)}`);
  }
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== "Fail") {
    expect.fail(`Expected a typed Fail cause, got: ${reason?._tag ?? "no reason"}`);
  }
  expect(reason.error).toMatchObject(expected);
};

// Resolve once so calls share the in-flight guard.
const resolveService = (harness: ReturnType<typeof makeHarness>) =>
  WorktreeMcpService.WorktreeMcpService.pipe(Effect.provide(harness.layer));

const runHandoff = (
  harness: ReturnType<typeof makeHarness>,
  input: Parameters<WorktreeMcpService.WorktreeMcpService["Service"]["handoff"]>[1],
) =>
  Effect.gen(function* () {
    const service = yield* WorktreeMcpService.WorktreeMcpService;
    return yield* service.handoff(harness.scope, input);
  }).pipe(Effect.provide(harness.layer));

const runStatus = (harness: ReturnType<typeof makeHarness>) =>
  Effect.gen(function* () {
    const service = yield* WorktreeMcpService.WorktreeMcpService;
    return yield* service.status(harness.scope);
  }).pipe(Effect.provide(harness.layer));

const runList = (
  harness: ReturnType<typeof makeHarness>,
  input: Parameters<WorktreeMcpService.WorktreeMcpService["Service"]["list"]>[1] = {},
) =>
  Effect.gen(function* () {
    const service = yield* WorktreeMcpService.WorktreeMcpService;
    return yield* service.list(harness.scope, input);
  }).pipe(Effect.provide(harness.layer));

describe("t3_worktree_list", () => {
  const folders = [
    {
      path: "/repo/primary/src",
      name: "Primary",
      label: "primary",
      checkoutRoot: "/repo/primary",
      checkoutPrefix: "src",
    },
    {
      path: "/repo/secondary",
      name: "Secondary",
      label: "secondary",
      checkoutRoot: "/repo/secondary",
    },
    {
      path: "/repo/primary/docs",
      name: "Docs",
      label: "docs",
      checkoutRoot: "/repo/primary",
      checkoutPrefix: "docs",
    },
    { uri: "vscode-remote://host/folder", name: "Remote", label: "remote" },
  ];
  const worktrees = [
    { repositoryRoot: "/repo/primary", path: "/worktrees/primary", branch: "feature/set" },
    { repositoryRoot: "/repo/secondary", path: "/worktrees/secondary", branch: "feature/set" },
  ];

  it.effect("defaults to the frozen primary and preserves ref pagination", () => {
    const harness = makeHarness({
      projectLinked: true,
      thread: { workspaceFolders: folders, worktrees, worktreePath: "/worktrees/primary/src" },
      folderCheckouts: { "/worktrees/primary/src": "/worktrees/primary" },
    });
    return Effect.gen(function* () {
      const input = {
        query: "feature",
        cursor: 3,
        limit: 2,
        refKind: "local" as const,
        includeMatchingRemoteRefs: false,
      };
      const result = yield* runList(harness, input);
      expect(result).toMatchObject({
        folderPath: "/repo/primary/src",
        cwd: "/worktrees/primary/src",
        repositoryRoot: "/worktrees/primary",
        isRepo: true,
        nextCursor: null,
      });
      expect(harness.listRefs).toHaveBeenCalledWith({ ...input, cwd: "/worktrees/primary/src" });
    });
  });

  it.effect("selects original secondary paths and folders in the same checkout share refs", () => {
    const harness = makeHarness({
      thread: { workspaceFolders: folders, worktrees, worktreePath: "/worktrees/primary/src" },
      folderCheckouts: {
        "/worktrees/primary/src": "/worktrees/primary",
        "/worktrees/primary/docs": "/worktrees/primary",
        "/worktrees/secondary": "/worktrees/secondary",
      },
    });
    return Effect.gen(function* () {
      const primary = yield* runList(harness);
      const docs = yield* runList(harness, { folderPath: "/repo/primary/docs" });
      const secondary = yield* runList(harness, { folderPath: "/repo/secondary" });
      expect(docs.repositoryRoot).toBe(primary.repositoryRoot);
      expect(docs.refs).toEqual(primary.refs);
      expect(secondary.cwd).toBe("/worktrees/secondary");
      expect(secondary.repositoryRoot).toBe("/worktrees/secondary");
      expect(harness.listRefs).toHaveBeenLastCalledWith({ cwd: "/worktrees/secondary" });
    });
  });

  it.effect("returns an empty ref inventory for an available non-git folder", () => {
    const harness = makeHarness({ notARepo: true });
    return Effect.gen(function* () {
      expect(yield* runList(harness)).toEqual({
        folderPath: workspaceRoot,
        cwd: workspaceRoot,
        repositoryRoot: null,
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
      expect(harness.listRefs).toHaveBeenCalledWith({ cwd: workspaceRoot });
    });
  });

  it.effect("reports Git spawn and timeout failures instead of a non-git inventory", () =>
    Effect.gen(function* () {
      for (const listRefsError of ["spawn", "timeout"] as const) {
        const harness = makeHarness({ notARepo: true, listRefsError });
        expectTypedFailure(yield* Effect.exit(runList(harness)), {
          _tag: "OrchestratorMcpFailure",
          code: "orchestration_error",
          message: `Unable to list refs: Git command failed in listRefs (${workspaceRoot}): Git ${listRefsError} failure`,
        });
      }
    }),
  );

  it.effect("rejects unknown, mapped, missing and remote selectors before listing refs", () => {
    const harness = makeHarness({
      thread: { workspaceFolders: folders, worktrees, worktreePath: "/worktrees/primary/src" },
      unavailableFolders: ["/repo/secondary"],
    });
    return Effect.gen(function* () {
      for (const [folderPath, code] of [
        ["/unknown", "folder_not_found"],
        ["/worktrees/secondary", "folder_not_found"],
        ["/repo/secondary", "folder_unavailable"],
        ["vscode-remote://host/folder", "folder_unavailable"],
      ]) {
        expectTypedFailure(yield* Effect.exit(runList(harness, { folderPath })), {
          _tag: "OrchestratorMcpFailure",
          code,
        });
      }
      expect(harness.listRefs).not.toHaveBeenCalled();
    });
  });

  it.effect("enforces the worktree capability and caller lifecycle", () =>
    Effect.gen(function* () {
      for (const [options, code] of [
        [
          { capabilities: new Set<McpInvocationContext.McpCapability>(["preview"]) },
          "capability_denied",
        ],
        [{ thread: null }, "thread_not_found"],
        [{ thread: { deletedAt: "2026-01-02T00:00:00.000Z" } }, "thread_not_found"],
      ] as const) {
        const harness = makeHarness(options);
        expectTypedFailure(yield* Effect.exit(runList(harness)), {
          _tag: "OrchestratorMcpFailure",
          code,
        });
        expect(harness.listRefs).not.toHaveBeenCalled();
      }
    }),
  );
});

const decodeHandoffInput = Schema.decodeUnknownEffect(WorktreeMcpHandoffInput);

describe("t3_worktree_handoff", () => {
  it.effect("reports the complete set after a multi-repository handoff", () => {
    const harness = makeHarness({
      projectLinked: true,
      thread: {
        workspaceFolders: [
          { path: workspaceRoot, name: "Primary", label: "primary", checkoutRoot: workspaceRoot },
          {
            path: "/repo/secondary",
            name: "Secondary",
            label: "secondary",
            checkoutRoot: "/repo/secondary",
          },
        ],
      },
    });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/multi" });
      expect(result.worktrees).toHaveLength(2);
      expect(result.cwd).toBe(result.worktreePath);
      expect(result.folders.map((folder) => folder.effectivePath)).toEqual(
        result.worktrees!.map((member) => member.path),
      );
      expect(result.folders.map((folder) => folder.path)).toEqual([
        workspaceRoot,
        "/repo/secondary",
      ]);
      expect(result.folders.every((folder) => folder.availability === "available")).toBe(true);
    });
  });

  it.effect("never rolls back a committed handoff when its binding inspection fails", () => {
    const harness = makeHarness({ folderReadFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/inspection" }));
      expectTypedFailure(exit, {
        code: "operation_failed",
        message: expect.stringContaining("Handoff recorded"),
      });
      expect(harness.dispatch).toHaveBeenCalled();
      expect(harness.removeWorktree).not.toHaveBeenCalled();
      expect(harness.deleteLocalBranch).not.toHaveBeenCalled();
    });
  });

  it.effect("creates a worktree from the current branch and re-points the thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/handoff" });

      expect(result.branch).toBe("feature/handoff");
      expect(result.baseRef).toBe("dev");
      expect(result.startedFromOrigin).toBe(false);
      expect(result.worktreePath).toBe("/worktrees/project/feature/handoff");
      expect(result.cwd).toBe(result.worktreePath);
      expect(result.workspaceFile).toBeNull();
      expect(result.folders).toMatchObject([
        { path: workspaceRoot, effectivePath: result.worktreePath, availability: "available" },
      ]);
      expect(result.worktrees).toBeUndefined();
      expect(result.setupScript).toMatchObject({
        status: "started",
        scriptName: "Setup",
      });

      expect(harness.fetchWorktreeBaseCommit).not.toHaveBeenCalled();
      expect(harness.createWorktree).toHaveBeenCalledWith(
        {
          cwd: workspaceRoot,
          refName: "dev",
          newRefName: "feature/handoff",
          baseRefName: "dev",
          path: null,
        },
        expect.anything(),
      );
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.metadata.update",
          threadId,
          branch: "feature/handoff",
          worktreePath: "/worktrees/project/feature/handoff",
          expectedWorktreePath: null,
        }),
      );
      expect(harness.runForThread).toHaveBeenCalledWith({
        threadId,
        projectId,
        projectCwd: workspaceRoot,
        worktreePath: "/worktrees/project/feature/handoff",
        project: { id: projectId, workspaceRoot, scripts: [] },
      });
    });
  });

  it.effect("skips the continuation when no continuationPrompt is given", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/no-continuation" });
      expect(result.continuation).toEqual({ status: "skipped" });
      expect(harness.sendToThread).not.toHaveBeenCalled();
    });
  });

  it.effect("queues the continuation prompt as the thread's next message", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, {
        branch: "feature/continue",
        continuationPrompt: "Keep fixing the login bug in the new worktree.",
      });

      expect(result.continuation).toEqual({ status: "scheduled", delivery: "queued" });
      expect(harness.sendToThread).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          threadId,
          text: "Keep fixing the login bug in the new worktree.",
          mode: "queue",
          createdBy: "agent",
          creationSource: "mcp",
        }),
      );
      // The continuation must be durably queued before anything slower runs.
      expect(harness.sendToThread.mock.invocationCallOrder[0]).toBeLessThan(
        harness.runForThread.mock.invocationCallOrder[0]!,
      );
    });
  });

  it.effect.each(["fails", "dies"] as const)(
    "reports a continuation that %s without failing the handoff",
    (continuation) => {
      const harness = makeHarness({ continuation });
      return Effect.gen(function* () {
        const result = yield* runHandoff(harness, {
          branch: "feature/continue-fails",
          continuationPrompt: "Keep going.",
        });
        expect(result.continuation).toMatchObject({ status: "failed" });
        expect(result.worktreePath).toBe("/worktrees/project/feature/continue-fails");
        expect(harness.dispatch).toHaveBeenCalled();
      });
    },
  );

  it.effect("fetches each set member's own remote base before creating any worktrees", () => {
    const harness = makeHarness({
      thread: {
        workspaceFolders: [
          { path: workspaceRoot, name: "Primary", label: "primary", checkoutRoot: workspaceRoot },
          {
            path: "/repo/secondary",
            name: "Secondary",
            label: "secondary",
            checkoutRoot: "/repo/secondary",
          },
        ],
      },
      git: {
        fetchWorktreeBaseCommit: ({ cwd }) =>
          Effect.succeed({
            commitSha: cwd === workspaceRoot ? "primary-sha" : "secondary-sha",
            remoteRefName: cwd === workspaceRoot ? "upstream/release" : "origin/dev",
          }),
      },
    });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, {
        branch: "feature/remote-set",
        startFromOrigin: true,
      });
      expect(result.startedFromOrigin).toBe(true);
      expect(harness.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: workspaceRoot,
          refName: "primary-sha",
          baseRefName: "refs/remotes/upstream/release",
        }),
        expect.anything(),
      );
      expect(harness.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/repo/secondary",
          refName: "secondary-sha",
          baseRefName: "refs/remotes/origin/dev",
        }),
        expect.anything(),
      );
    });
  });

  it.effect("creates no set members when an origin fetch fails", () => {
    const harness = makeHarness({ fetchWorktreeBaseFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runHandoff(harness, { branch: "feature/fetch-fails", startFromOrigin: true }),
      );
      expectTypedFailure(exit, { code: "operation_failed" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("rolls back every set member when binding fails", () => {
    const harness = makeHarness({
      dispatchFails: true,
      thread: {
        workspaceFolders: [
          { path: workspaceRoot, name: "Primary", label: "primary", checkoutRoot: workspaceRoot },
          {
            path: "/repo/secondary",
            name: "Secondary",
            label: "secondary",
            checkoutRoot: "/repo/secondary",
          },
        ],
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/rollback-set" }));
      expectTypedFailure(exit, { code: "operation_failed" });
      expect(harness.removeWorktree).toHaveBeenCalledTimes(2);
      for (const cwd of [workspaceRoot, "/repo/secondary"]) {
        expect(harness.removeWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ cwd, force: true }),
        );
        expect(harness.deleteLocalBranch).toHaveBeenCalledWith(
          expect.objectContaining({ cwd, force: true }),
        );
      }
    });
  });

  it.effect("does not queue a continuation when the thread update fails", () => {
    const harness = makeHarness({ dispatchFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runHandoff(harness, {
          branch: "feature/dispatch-fails-continue",
          continuationPrompt: "Keep going.",
        }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.sendToThread).not.toHaveBeenCalled();
    });
  });

  it.effect("uses the fetched commit and remote PR base for an explicit local alias", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-remote-base-" });
      const cwd = `${directory}/repo`;
      const remote = `${directory}/remote.git`;
      const worktreePath = `${directory}/worktree`;
      yield* fs.makeDirectory(cwd);
      const command = (at: string, args: string[]) =>
        git.execute({ operation: "handoff-test", cwd: at, args });
      yield* command(cwd, ["init", "-b", "stable"]);
      yield* command(cwd, ["config", "user.name", "Test"]);
      yield* command(cwd, ["config", "user.email", "test@example.test"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "remote base"]);
      const remoteHead = (yield* command(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      yield* command(cwd, ["init", "--bare", remote]);
      yield* command(cwd, ["remote", "add", "upstream", remote]);
      yield* command(cwd, ["push", "-u", "upstream", "stable:release"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "local only"]);
      const harness = makeHarness({
        git: {
          resolveWorktreeBaseRemote: (input) => git.resolveWorktreeBaseRemote({ ...input, cwd }),
          fetchWorktreeBaseCommit: (input) => git.fetchWorktreeBaseCommit({ ...input, cwd }),
          createWorktree: (input) => git.createWorktree({ ...input, cwd, path: worktreePath }),
        },
      });
      const result = yield* runHandoff(harness, {
        branch: "feature/from-remote",
        baseRef: "stable",
        startFromOrigin: true,
        runSetupScript: false,
      });

      expect(result.worktreePath).toBe(worktreePath);
      expect(result.startedFromOrigin).toBe(true);
      expect(result.setupScript).toEqual({ status: "skipped" });
      expect((yield* command(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(remoteHead);
      const preview = yield* git.getReviewDiffPreview({ cwd: worktreePath });
      const comparisonBase = preview.sources.find(
        (source) => source.kind === "branch-range",
      )!.baseRef;
      expect(
        (yield* command(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`])).stdout.trim(),
      ).toBe(remoteHead);
    }).pipe(
      Effect.provide(
        GitVcsDriver.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "handoff-remote-git-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("fails when the thread is already attached to a worktree", () => {
    const harness = makeHarness({
      thread: { branch: "feature/existing", worktreePath: "/worktrees/project/existing" },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/second" }));
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "already_in_worktree",
      });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("fails when the thread does not exist", () => {
    const harness = makeHarness({ thread: null });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/missing" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "thread_not_found" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("treats a soft-deleted thread as not found", () => {
    const harness = makeHarness({ thread: { deletedAt: "2026-01-02T00:00:00.000Z" } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/deleted" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "thread_not_found" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("maps a non-projection orchestrator error to operation_failed", () => {
    const harness = makeHarness({ threadReadError: "dispatch" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/read-error" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("fails when the project does not exist", () => {
    const harness = makeHarness({ projectMissing: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/no-project" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "project_not_found" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("hands a thread of a linked project off to a worktree set", () => {
    const harness = makeHarness({
      projectLinked: true,
      // The thread's own primary, which a later relink never moves.
      thread: {
        workspaceFolders: [
          {
            path: workspaceRoot,
            name: "project",
            label: "project",
            checkoutRoot: workspaceRoot,
            checkoutPrefix: "",
          },
        ],
      },
    });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/linked" });
      const member = {
        repositoryRoot: workspaceRoot,
        path: result.worktreePath,
        branch: "feature/linked",
      };
      expect(result.worktreePath).toMatch(/feature-linked$/);
      expect(result.cwd).toBe(result.worktreePath);
      expect(result.workspaceFile).toBe("/workspace/project.code-workspace");
      expect(result.worktrees).toEqual([member]);
      expect(result.folders).toMatchObject([
        {
          path: workspaceRoot,
          label: "project",
          effectivePath: result.worktreePath,
          availability: "available",
        },
      ]);
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.metadata.update",
          branch: "feature/linked",
          worktreePath: result.worktreePath,
          worktrees: [member],
          expectedWorktreePath: null,
        }),
      );
      expect(harness.runForThread).toHaveBeenCalledWith(
        expect.objectContaining({ projectCwd: workspaceRoot, worktreePath: result.worktreePath }),
      );
    });
  });

  it.effect("maps a project read error to operation_failed", () => {
    const harness = makeHarness({ projectReadFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/project-error" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("fails when the project workspace is not a git repository", () => {
    const harness = makeHarness({ notARepo: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/no-repo" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("rejects an existing branch with an actionable error naming its checkout", () => {
    const harness = makeHarness({ existingBranchWorktreePath: "/elsewhere/checkout" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/taken" }));
      if (!Exit.isFailure(exit)) {
        return expect.fail("expected a failure exit");
      }
      const reason = exit.cause.reasons[0];
      expect(reason?._tag).toBe("Fail");
      const error = (reason as { readonly error: { code: string; message: string } }).error;
      expect(error.code).toBe("invalid_request");
      expect(error.message).toContain("feature/taken");
      expect(error.message).toContain("already exists");
      expect(error.message).toContain("/elsewhere/checkout");
      expect(harness.createWorktree).not.toHaveBeenCalled();
      expect(harness.fetchWorktreeBaseCommit).not.toHaveBeenCalled();
    });
  });

  it.effect("does not trip the pre-flight on similarly named branches", () => {
    const harness = makeHarness({ existingBranchWorktreePath: null });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/take" });
      expect(result.branch).toBe("feature/take");
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("propagates an interrupted dispatch without rolling back the worktree", () => {
    const harness = makeHarness({ dispatchInterrupts: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/dispatch-int" }));
      if (!Exit.isFailure(exit)) {
        return expect.fail("expected a failure exit");
      }
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(harness.removeWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("falls back to the local base when no remote holds it", () => {
    const harness = makeHarness({ worktreeBaseMissing: true });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, {
        branch: "feature/local-fallback",
        baseRef: "dev",
        startFromOrigin: true,
      });
      expect(harness.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ refName: "dev", baseRefName: "dev" }),
        expect.anything(),
      );
      expect(result.startedFromOrigin).toBe(false);
    });
  });

  it.effect("removes the created worktree when the thread update dies with a defect", () => {
    const harness = makeHarness({ dispatchDies: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/dispatch-defect" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/dispatch-defect",
        force: true,
      });
    });
  });

  it.effect("re-checks attachment after creating the worktree and backs out on a race", () => {
    const harness = makeHarness({ threadAttachedOnRecheck: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/raced" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "already_in_worktree" });
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/raced",
        force: true,
      });
      expect(harness.deleteLocalBranch).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        refName: "feature/raced",
        force: true,
      });
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("removes the created worktree when the recheck read fails", () => {
    const harness = makeHarness({ threadReadFailsOnRecheck: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/recheck-fails" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/recheck-fails",
        force: true,
      });
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("backs out when the thread is archived during worktree creation", () => {
    const harness = makeHarness({ threadArchivedOnRecheck: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/archived-race" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
      expect(harness.dispatch).not.toHaveBeenCalled();
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/archived-race",
        force: true,
      });
    });
  });

  it.effect("queues the continuation even when interrupted during the binding dispatch", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const dispatching = yield* Deferred.make<void>();
      const harness = makeHarness({
        dispatchGate: Deferred.succeed(dispatching, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        ),
      });

      const fiber = yield* Effect.forkChild(
        runHandoff(harness, {
          branch: "feature/interrupted",
          continuationPrompt: "Keep going in the worktree.",
        }),
      );
      yield* Deferred.await(dispatching);
      const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.await(fiber);
      yield* Fiber.join(interruption);

      expect(harness.dispatch).toHaveBeenCalledTimes(1);
      expect(harness.sendToThread).toHaveBeenCalledTimes(1);
      expect(harness.runForThread).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("creates the worktree in the managed directory even when a call names a path", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const input = yield* decodeHandoffInput({
        branch: "feature/elsewhere",
        path: "/home/user/.ssh/checkout",
      });
      const result = yield* runHandoff(harness, input);
      expect(harness.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ path: null }),
        expect.anything(),
      );
      expect(result.worktreePath).toBe("/worktrees/project/feature/elsewhere");
    });
  });

  it.effect("releases the per-thread guard after a failed handoff", () => {
    const harness = makeHarness({
      thread: { worktreePath: "/worktrees/project/existing" },
    });
    return Effect.gen(function* () {
      const service = yield* resolveService(harness);

      const first = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/guard-1" }),
      );
      expectTypedFailure(first, { _tag: "WorktreeMcpFailure", code: "already_in_worktree" });
      const second = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/guard-2" }),
      );
      expectTypedFailure(second, { _tag: "WorktreeMcpFailure", code: "already_in_worktree" });
    });
  });

  it.effect("serializes concurrent handoffs for the same thread", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const harness = makeHarness({ createWorktreeGate: Deferred.await(gate) });

      const service = yield* resolveService(harness);

      const first = yield* Effect.forkChild(
        Effect.exit(service.handoff(harness.scope, { branch: "feature/race-1" })),
      );
      yield* Effect.yieldNow;

      const second = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/race-2" }),
      );
      expectTypedFailure(second, { _tag: "WorktreeMcpFailure", code: "handoff_in_progress" });

      yield* Deferred.succeed(gate, undefined);
      const firstExit = yield* Fiber.join(first);
      expect(Exit.isSuccess(firstExit)).toBe(true);
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("reports a setup script defect without failing the handoff", () => {
    const harness = makeHarness({ setupScript: "dies" });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/setup-dies" });
      expect(result.setupScript).toEqual({ status: "failed", detail: "setup runner defect" });
      expect(harness.dispatch).toHaveBeenCalled();
    });
  });
});

describe("t3_worktree_status", () => {
  it.effect("keeps one captured binding when a handoff lands during folder inspection", () => {
    const harness = makeHarness({ handoffOnFolderRead: true });
    return Effect.gen(function* () {
      const before = yield* runStatus(harness);
      expect(before).toMatchObject({
        attached: false,
        cwd: workspaceRoot,
        worktreePath: null,
        branch: null,
      });
      expect(before.folders[0]?.effectivePath).toBe(workspaceRoot);
      expect(before.worktrees).toBeUndefined();
      const after = yield* runStatus(harness);
      expect(after).toMatchObject({
        attached: true,
        cwd: "/worktrees/raced",
        worktreePath: "/worktrees/raced",
        branch: "feature/raced",
      });
      expect(after.folders[0]?.effectivePath).toBe(after.cwd);
    });
  });
  it.effect("reports mapped, shared and unavailable snapshot folders", () => {
    const harness = makeHarness({
      projectLinked: true,
      thread: {
        branch: "feature/set",
        worktreePath: "/worktrees/primary",
        workspaceFolders: [
          { path: workspaceRoot, name: "Primary", label: "primary", checkoutRoot: workspaceRoot },
          {
            path: "/repo/secondary",
            name: "Secondary",
            label: "secondary",
            checkoutRoot: "/repo/secondary",
          },
          { path: "/shared", name: "Shared", label: "shared", checkoutRoot: null },
          { path: "/missing", name: "Missing", label: "missing" },
        ],
        worktrees: [
          { repositoryRoot: workspaceRoot, path: "/worktrees/primary", branch: "feature/set" },
          {
            repositoryRoot: "/repo/secondary",
            path: "/worktrees/secondary",
            branch: "feature/set-secondary",
          },
        ],
      },
      unavailableFolders: ["/missing"],
    });
    return Effect.gen(function* () {
      const result = yield* runStatus(harness);
      expect(result.cwd).toBe("/worktrees/primary");
      expect(result.workspaceFile).toBe("/workspace/project.code-workspace");
      expect(
        result.folders.map((folder) => [folder.label, folder.effectivePath, folder.availability]),
      ).toEqual([
        ["primary", "/worktrees/primary", "available"],
        ["secondary", "/worktrees/secondary", "available"],
        ["shared", "/shared", "available"],
        ["missing", null, "unavailable"],
      ]);
      expect(result.worktrees).toHaveLength(2);
      expect(result.branch).toBe("feature/set");
    });
  });
  it.effect("reports an unattached thread", () => {
    const harness = makeHarness({ newWorktreesStartFromOrigin: true });
    return Effect.gen(function* () {
      const result = yield* runStatus(harness);
      expect(result).toEqual({
        cwd: workspaceRoot,
        workspaceFile: null,
        folders: [
          {
            path: workspaceRoot,
            name: "project",
            label: "project",
            availability: "available",
            effectivePath: workspaceRoot,
          },
        ],
        attached: false,
        worktreePath: null,
        branch: null,
        projectWorkspaceRoot: workspaceRoot,
        defaultStartFromOrigin: true,
      });
    });
  });

  it.effect("reports an attached thread's worktree and branch", () => {
    const harness = makeHarness({
      thread: {
        worktreePath: "/worktrees/project/existing",
        branch: "feature/existing",
      },
    });
    return Effect.gen(function* () {
      const result = yield* runStatus(harness);
      expect(result).toMatchObject({
        attached: true,
        worktreePath: "/worktrees/project/existing",
        branch: "feature/existing",
        defaultStartFromOrigin: false,
      });
    });
  });
});

it.effect("outside clients list an explicit thread's folders and must name a target", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const service = yield* WorktreeMcpService.WorktreeMcpService;
    const externalScope: McpInvocationContext.McpInvocationScope = {
      ...harness.scope,
      requestNamespace: "client:worktree-read",
      thread: undefined,
      client: { sessionId: "worktree-read", label: "External agent", access: "read-only" },
    };
    expect(yield* service.list(externalScope, { threadId })).toMatchObject({
      folderPath: workspaceRoot,
      cwd: workspaceRoot,
    });
    expect(yield* service.list(externalScope, {}).pipe(Effect.flip)).toMatchObject({
      code: "target_required",
    });
    expect(yield* service.status(externalScope).pipe(Effect.flip)).toMatchObject({
      code: "thread_credential_required",
    });
    expect(harness.dispatch).not.toHaveBeenCalled();
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rolls back a handoff when the provider is disabled before the binding commits", () => {
  const harness = makeHarness({ providerDisabledAtBind: true });
  return Effect.gen(function* () {
    const result = yield* runHandoff(harness, {
      branch: "feature/disabled",
      continuationPrompt: "Continue",
    }).pipe(Effect.flip);
    expect(result).toMatchObject({
      code: "invalid_request",
      message: `Provider instance "claudeAgent" is disabled for project ${projectId}.`,
    });
    expect(harness.removeWorktree).toHaveBeenCalledWith({
      cwd: workspaceRoot,
      path: "/worktrees/project/feature/disabled",
      force: true,
    });
    expect(harness.sendToThread).not.toHaveBeenCalled();
  });
});
