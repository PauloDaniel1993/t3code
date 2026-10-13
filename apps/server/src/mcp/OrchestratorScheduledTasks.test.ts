import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  WorkspaceFileUnavailableError,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Option from "effect/Option";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as WorkspaceFolderFiles from "../workspace/WorkspaceFolderFiles.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcp from "./OrchestratorMcpService.ts";
import * as ThreadHandlers from "./toolkits/thread/handlers.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";

const projectId = ProjectId.make("project:schedule-mcp");
const threadId = ThreadId.make("thread:schedule-mcp");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:schedule-mcp"),
  requestNamespace: "session:schedule-mcp",
  thread: {
    threadId,
    providerSessionId: "session:schedule-mcp",
    providerInstanceId: modelSelection.instanceId,
  },
  client: undefined,

  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const now = DateTime.makeUnsafe("2026-10-11T12:00:00.000Z");
const projection: OrchestrationV2ThreadProjection = {
  thread: {
    id: threadId,
    projectId,
    title: "Schedule caller",
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
};
const caller = {
  id: threadId,
  projectId,
  providerInstanceId: modelSelection.instanceId,
  runtimeMode: "full-access",
  interactionMode: "default",
  activeRunId: "run:schedule-mcp",
  archivedAt: null,
  deletedAt: null,
} as OrchestrationV2ThreadShell;
const external = Layer.mergeAll(
  NodeServices.layer,
  Scheduler.layer,
  Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadRecords: () => Effect.succeed(projection),
    getThreadShell: () => Effect.succeed(caller),
  }),
  Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Effect.fail(
        new ThreadLaunch.ThreadLaunchError({
          operation: "validate-workspace",
          commandId: input.commandId,
          projectId,
          cause: new WorkspaceFileUnavailableError({
            projectId,
            diagnostic: { code: "file-not-found", message: "Workspace file not found." },
          }),
        }),
      ),
  }),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ProjectService.ProjectService)({
    getById: (id) =>
      Effect.succeed(Option.some({ id, defaultModelSelection: modelSelection } as never)),
  }),
  Layer.mock(SecretRequests.SecretRequests)({}),
  ServerSettings.layerTest(),
  Layer.mock(WorkspaceFolderFiles.WorkspaceFolderFiles)({}),
);
const scheduler = ScheduledTasks.layer.pipe(Layer.provide(external));
const dependencies = Layer.mergeAll(external, scheduler);
const layer = OrchestratorMcp.layer.pipe(
  Layer.provideMerge(dependencies),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const scheduleInput = {
  prompt: "Review the project.",
  schedule: { type: "interval", everyMs: 60_000 },
} as const;
const defaultWorktree = { type: "worktree", baseRef: "main", startFromOrigin: true } as const;

it.effect("keeps schedule defaults, inherited settings, idempotency and project scoping", () =>
  Effect.gen(function* () {
    const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
    const tasks = yield* ScheduledTasks.ScheduledTaskService;
    const bound = yield* mcp.scheduleTask(scope, { ...scheduleInput, clientRequestId: "bound" });
    expect(bound.boundThreadId).toBe(threadId);
    expect(bound.workspaceStrategy).toEqual({ type: "root" });
    expect(bound.lastRunError).toBeNull();
    const retry = yield* mcp.scheduleTask(scope, { ...scheduleInput, clientRequestId: "bound" });
    expect(retry.scheduledTaskId).toBe(bound.scheduledTaskId);
    const unbound = yield* mcp.scheduleTask(scope, {
      ...scheduleInput,
      bindToCurrentThread: false,
    });
    expect(unbound.boundThreadId).toBeNull();
    expect(unbound.workspaceStrategy).toEqual(defaultWorktree);
    const { tasks: stored } = yield* tasks.list();
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      projectId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    yield* tasks.upsert({
      ...stored[0]!,
      id: ScheduledTaskId.make("schedule:other"),
      projectId: ProjectId.make("project:other"),
    });
    expect((yield* mcp.listScheduledTasks(scope, {})).tasks).toHaveLength(2);
  }).pipe(Effect.provide(layer)),
);

it.effect("persists unbound strategies, preserves ordinary edits and resets binding defaults", () =>
  Effect.gen(function* () {
    const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
    const strategy = { type: "worktree", baseRef: "dev", startFromOrigin: false } as const;
    const created = yield* mcp.scheduleTask(scope, {
      ...scheduleInput,
      bindToCurrentThread: false,
      workspaceStrategy: strategy,
    });
    const input = { scheduledTaskId: created.scheduledTaskId };
    expect(created.workspaceStrategy).toEqual(strategy);
    expect(
      (yield* mcp.updateScheduledTask(scope, { ...input, title: "Edited" })).workspaceStrategy,
    ).toEqual(strategy);
    expect(
      (yield* mcp.updateScheduledTask(scope, {
        ...input,
        title: "Echoed binding",
        bindToCurrentThread: false,
      })).workspaceStrategy,
    ).toEqual(strategy);
    const root = yield* mcp.updateScheduledTask(scope, {
      ...input,
      workspaceStrategy: { type: "root" },
    });
    expect(root.workspaceStrategy).toEqual({ type: "root" });
    const reused = {
      type: "existing_worktree",
      worktreePath: "/sets/existing",
      branch: "feature/existing",
    } as const;
    expect(
      (yield* mcp.updateScheduledTask(scope, { ...input, workspaceStrategy: reused }))
        .workspaceStrategy,
    ).toEqual(reused);
    expect((yield* mcp.listScheduledTasks(scope, {})).tasks[0]?.workspaceStrategy).toEqual(reused);
    expect(
      (yield* mcp.updateScheduledTask(scope, { ...input, bindToCurrentThread: true }))
        .boundThreadId,
    ).toBe(threadId);
    expect(
      (yield* mcp.updateScheduledTask(scope, { ...input, bindToCurrentThread: false }))
        .workspaceStrategy,
    ).toEqual(defaultWorktree);
    yield* mcp.updateScheduledTask(scope, { ...input, bindToCurrentThread: true });
    expect(
      (yield* mcp.updateScheduledTask(scope, {
        ...input,
        bindToCurrentThread: false,
        workspaceStrategy: strategy,
      })).workspaceStrategy,
    ).toEqual(strategy);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "rejects explicit strategies when the resulting schedule is bound without saving edits",
  () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
      const rejected = yield* mcp
        .scheduleTask(scope, { ...scheduleInput, workspaceStrategy: { type: "root" } })
        .pipe(Effect.flip);
      expect(rejected.code).toBe("invalid_request");
      expect((yield* mcp.listScheduledTasks(scope, {})).tasks).toEqual([]);
      const bound = yield* mcp.scheduleTask(scope, scheduleInput);
      const error = yield* mcp
        .updateScheduledTask(scope, {
          scheduledTaskId: bound.scheduledTaskId,
          title: "Must not save",
          workspaceStrategy: defaultWorktree,
        })
        .pipe(Effect.flip);
      expect(error.code).toBe("invalid_request");
      expect((yield* mcp.listScheduledTasks(scope, {})).tasks[0]).toEqual(bound);
      const unbound = yield* mcp.scheduleTask(scope, {
        ...scheduleInput,
        bindToCurrentThread: false,
      });
      const rebindError = yield* mcp
        .updateScheduledTask(scope, {
          scheduledTaskId: unbound.scheduledTaskId,
          bindToCurrentThread: true,
          workspaceStrategy: { type: "root" },
        })
        .pipe(Effect.flip);
      expect(rebindError.code).toBe("invalid_request");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "returns the stored strategy and dispatch error through manual-run and summary tools",
  () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
      const created = yield* mcp.scheduleTask(scope, {
        ...scheduleInput,
        bindToCurrentThread: false,
        workspaceStrategy: { type: "root" },
      });
      const toolkit = yield* ThreadToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer)),
      );
      const results = yield* toolkit
        .handle("run_scheduled_task_now", { taskId: created.scheduledTaskId })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(results.at(-1)?.result).toMatchObject({
        threadId: null,
        workspaceStrategy: { type: "root" },
        lastRunStatus: "failed",
        lastRunError: "Workspace file not found.",
        runCount: 1,
      });
      const listed = (yield* mcp.listScheduledTasks(scope, {})).tasks[0];
      expect(listed).toMatchObject({
        workspaceStrategy: { type: "root" },
        lastRunError: "Workspace file not found.",
      });
      const edited = yield* mcp.updateScheduledTask(scope, {
        scheduledTaskId: created.scheduledTaskId,
        enabled: false,
      });
      expect(edited.lastRunError).toBe("Workspace file not found.");
    }).pipe(Effect.provide(layer)),
);
