import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
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
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspaceFolderFiles from "../workspace/WorkspaceFolderFiles.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const decodeReadResult = Schema.decodeEffect(OrchestratorMcpThreadReadResult);
const encodeReadResult = Schema.encodeEffect(OrchestratorMcpThreadReadResult);

const projectId = ProjectId.make("project:mcp-workspace-binding");
const threadId = ThreadId.make("thread:mcp-workspace-binding");
const instanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-10-11T00:00:00.000Z");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-workspace-binding"),
  threadId,
  providerSessionId: "session:mcp-workspace-binding",
  providerInstanceId: instanceId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const makeHarness = Effect.gen(function* () {
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
  const stores = Layer.mergeAll(
    Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(Option.some(project)) }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThread: () => Effect.succeed(thread) }),
  );
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
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(projection),
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
        }),
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
  return {
    fs,
    project,
    thread,
    read,
    primary,
    secondary,
    primaryWorktree,
    secondaryWorktree,
    shared,
  };
});

it.effect("thread reads report the whole mapped binding after relinking and unlinking", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness;
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
      const h = yield* makeHarness;
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
      const h = yield* makeHarness;
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
