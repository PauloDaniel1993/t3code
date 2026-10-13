import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadProjection,
  OrchestratorMcpThreadReadResult,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as WorktreeSet from "../orchestration-v2/WorktreeSetService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorkspaceFolderResolver from "../project/WorkspaceFolderResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspaceFolderFiles from "../workspace/WorkspaceFolderFiles.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";

const decodeReadResult = Schema.decodeEffect(OrchestratorMcpThreadReadResult);
const encodeReadResult = Schema.encodeEffect(OrchestratorMcpThreadReadResult);

const projectId = ProjectId.make("project:mcp-workspace-binding");
const threadId = ThreadId.make("thread:mcp-workspace-binding");
const instanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-10-11T00:00:00.000Z");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-workspace-binding"),
  requestNamespace: "session:mcp-workspace-binding",
  thread: {
    threadId,
    providerSessionId: "session:mcp-workspace-binding",
    providerInstanceId: instanceId,
  },
  client: undefined,

  capabilities: new Set(["orchestration", "worktree"]),
  issuedAt: 1,
};

const makeHarness = (handoffOnProjectRead = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-binding-" });
    const location = (name: string) => path.join(root, name);
    const primary = location("primary");
    const secondary = location("secondary");
    const primaryWorktree = location("worktrees/primary");
    const secondaryWorktree = location("worktrees/secondary");
    const shared = location("shared");
    for (const directory of [primary, secondary, primaryWorktree, secondaryWorktree, shared]) {
      yield* fs.makeDirectory(directory, { recursive: true });
    }
    const project: {
      -readonly [Key in keyof ProjectStore.ProjectRow]: ProjectStore.ProjectRow[Key];
    } = {
      projectId,
      title: "Binding",
      workspaceRoot: primary,
      workspaceFile: location("team.code-workspace"),
      folders: [
        { path: primary, name: "Primary" },
        { path: secondary, name: "Secondary" },
      ],
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      faviconPath: null,
      projectIcon: null,
      scripts: [],
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T00:00:00.000Z",
      deletedAt: null,
    };
    const thread: {
      -readonly [Key in keyof OrchestrationV2AppThread]: OrchestrationV2AppThread[Key];
    } = {
      id: threadId,
      projectId,
      title: "Binding",
      createdBy: "user",
      creationSource: "mcp",
      modelSelection: { instanceId, model: "gpt-6.1-sol" },
      providerInstanceId: instanceId,
      activeProviderThreadId: null,
      forkedFrom: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/set",
      worktreePath: primaryWorktree,
      workspaceFolders: [
        {
          path: primary,
          name: "Primary",
          label: "primary",
          checkoutRoot: primary,
          checkoutPrefix: "",
        },
        {
          path: secondary,
          name: "Secondary",
          label: "secondary",
          checkoutRoot: secondary,
          checkoutPrefix: "",
        },
        { path: shared, name: "Shared", label: "shared", checkoutRoot: null },
        { uri: "vscode-remote://host/folder", name: "Remote", label: "remote" },
      ],
      worktrees: [
        { repositoryRoot: primary, path: primaryWorktree, branch: "feature/set" },
        { repositoryRoot: secondary, path: secondaryWorktree, branch: "feature/set-secondary" },
      ],
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      archivedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const projection = {
      thread,
      runs: [],
      runtimeRequests: [],
      contextTransfers: [],
      subagents: [],
    } as unknown as OrchestrationV2ThreadProjection;
    const readProject = Effect.sync(() => {
      if (handoffOnProjectRead) {
        thread.worktreePath = primaryWorktree;
        thread.branch = "feature/raced";
        thread.worktrees = [
          { repositoryRoot: primary, path: primaryWorktree, branch: "feature/raced" },
        ];
      }
      return Option.some(project);
    });
    const stores = Layer.mergeAll(
      Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => readProject }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThread: () => Effect.succeed(thread) }),
    );
    const threadReads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed({ ...projection, thread: { ...thread } }),
      getProjectThreadRecords: () => Effect.succeed({ ...projection, thread: { ...thread } }),
      getThreadShell: () => Effect.succeed({ ...thread, activeRunId: null } as never),
      getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
    });
    const projectReads = Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        readProject.pipe(Effect.map(Option.map((row) => ({ ...row, id: row.projectId }) as never))),
    });
    const folders = WorkspaceFolderFiles.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          stores,
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
          Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
          Layer.mock(WorkspacePaths.WorkspacePaths)({}),
          NodeServices.layer,
        ),
      ),
    );
    const layer = OrchestratorMcpService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          stores,
          folders,
          threadReads,
          projectReads,
          ServerSettings.layerTest(),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          NodeServices.layer,
        ),
      ),
    );
    const read = Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const result = yield* service.readThread(scope, { threadId });
      // Exercise the wire encoder too: additive binding fields must survive serialization.
      return (yield* encodeReadResult(result).pipe(Effect.flatMap(decodeReadResult))).thread;
    }).pipe(Effect.provide(layer));
    const listRefs = vi.fn((_: { readonly cwd: string }) =>
      Effect.succeed({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      }),
    );
    const worktreeLayer = WorktreeMcpService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          folders,
          threadReads,
          projectReads,
          Layer.mock(GitWorkflowService.GitWorkflowService)({ listRefs }),
          Layer.mock(WorkspaceFolderResolver.WorkspaceFolderResolver)({
            probe: (cwd) =>
              Effect.succeed({
                path: cwd,
                availability: "available",
                vcs: { checkoutRoot: cwd, checkoutPrefix: "", commonDir: cwd + "/.git" },
              }),
          }),
          Layer.mock(WorktreeSet.WorktreeSetService)({}),
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
          Layer.mock(ServerSettings.ServerSettingsService)({}),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
          NodeServices.layer,
        ),
      ),
    );
    const list = (folderPath?: string) =>
      Effect.gen(function* () {
        const service = yield* WorktreeMcpService.WorktreeMcpService;
        return yield* service.list(scope, folderPath === undefined ? {} : { folderPath });
      }).pipe(Effect.provide(worktreeLayer));
    return {
      fs,
      project,
      thread,
      read,
      list,
      listRefs,
      primary,
      secondary,
      primaryWorktree,
      secondaryWorktree,
      shared,
    };
  });

it.effect(
  "list uses original folder identities and current availability through the real folder service",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const primary = yield* h.list();
        expect(primary).toMatchObject({
          folderPath: h.primary,
          cwd: h.primaryWorktree,
          repositoryRoot: h.primaryWorktree,
        });
        const secondary = yield* h.list(h.secondary);
        expect(secondary).toMatchObject({
          folderPath: h.secondary,
          cwd: h.secondaryWorktree,
          repositoryRoot: h.secondaryWorktree,
        });
        expect(h.listRefs).toHaveBeenLastCalledWith({ cwd: h.secondaryWorktree });
        expect(yield* Effect.flip(h.list(h.secondaryWorktree))).toMatchObject({
          code: "folder_not_found",
        });
        expect(yield* Effect.flip(h.list("vscode-remote://host/folder"))).toMatchObject({
          code: "folder_unavailable",
        });
        yield* h.fs.remove(h.secondaryWorktree, { recursive: true });
        expect(yield* Effect.flip(h.list(h.secondary))).toMatchObject({
          code: "folder_unavailable",
        });
        expect(h.listRefs).toHaveBeenCalledTimes(2);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "thread reads keep one captured binding when a handoff lands before folder inspection",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(true);
        h.thread.worktreePath = null;
        h.thread.branch = null;
        delete h.thread.worktrees;
        const before = yield* h.read;
        expect(before).toMatchObject({ cwd: h.primary, worktreePath: null, branch: null });
        expect(before.folders[0]?.effectivePath).toBe(h.primary);
        expect(before.worktrees).toBeUndefined();
        const after = yield* h.read;
        expect(after).toMatchObject({
          cwd: h.primaryWorktree,
          worktreePath: h.primaryWorktree,
          branch: "feature/raced",
        });
        expect(after.folders[0]?.effectivePath).toBe(after.cwd);
        expect(after.worktrees).toEqual(h.thread.worktrees);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("thread reads report the whole mapped binding after relinking and unlinking", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.project.workspaceRoot = h.shared;
      h.project.folders = [{ path: h.shared, name: "Changed primary" }];
      h.project.workspaceFile = h.shared + ".code-workspace";
      const result = yield* h.read;
      expect(result.cwd).toBe(h.primaryWorktree);
      expect(result.workspaceFile).toBe(h.project.workspaceFile);
      expect(result.branch).toBe("feature/set");
      expect(result.worktreePath).toBe(h.primaryWorktree);
      expect(result.worktrees).toEqual(h.thread.worktrees);
      expect(
        result.folders.map((folder) => [folder.label, folder.effectivePath, folder.availability]),
      ).toEqual([
        ["primary", h.primaryWorktree, "available"],
        ["secondary", h.secondaryWorktree, "available"],
        ["shared", h.shared, "available"],
        ["remote", null, "unavailable"],
      ]);
      expect(result.folders[0]).toMatchObject({
        path: h.primary,
        checkoutRoot: h.primary,
        checkoutPrefix: "",
      });
      h.project.workspaceFile = null;
      h.project.folders = null;
      const unlinked = yield* h.read;
      expect(unlinked.workspaceFile).toBeNull();
      expect(unlinked.folders).toEqual(result.folders);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("inspection checks mapped availability now and never promotes a secondary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.fs.remove(h.primaryWorktree, { recursive: true });
      yield* h.fs.remove(h.secondaryWorktree, { recursive: true });
      const missing = yield* h.read;
      expect(missing.cwd).toBe(h.primaryWorktree);
      expect(
        missing.folders.slice(0, 2).map((folder) => [folder.availability, folder.effectivePath]),
      ).toEqual([
        ["unavailable", null],
        ["unavailable", null],
      ]);
      yield* h.fs.makeDirectory(h.secondaryWorktree, { recursive: true });
      const recovered = yield* h.read;
      expect(recovered.cwd).toBe(h.primaryWorktree);
      expect(recovered.folders[0]?.effectivePath).toBeNull();
      expect(recovered.folders[1]?.effectivePath).toBe(h.secondaryWorktree);
      expect(recovered.worktrees).toEqual(missing.worktrees);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("root and legacy one-folder reads preserve their primary scalars", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.thread.worktreePath = null;
      delete h.thread.worktrees;
      const root = yield* h.read;
      expect(root.cwd).toBe(h.primary);
      expect(root.folders[1]?.effectivePath).toBe(h.secondary);
      expect(root.worktrees).toBeUndefined();
      delete h.thread.workspaceFolders;
      h.project.workspaceFile = null;
      h.project.folders = null;
      h.thread.worktreePath = h.primaryWorktree;
      const legacy = yield* h.read;
      expect(legacy.cwd).toBe(h.primaryWorktree);
      expect(legacy.workspaceFile).toBeNull();
      expect(legacy.folders).toHaveLength(1);
      expect(legacy.folders[0]?.effectivePath).toBe(h.primaryWorktree);
      expect(legacy.worktrees).toBeUndefined();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
