import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreV2, layer as projectionLayer } from "./ProjectionStore.ts";
import { withTaskThreadLifecycle } from "./TaskThreadLifecycle.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2LayerLive,
  ProjectServiceLayerLive,
} from "./runtimeLayer.ts";
import { worktreeRepairDependenciesTestLayer } from "./ProviderTurnStartService.testkit.ts";

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry)({ resolveLink: () => Effect.die("unused title link") }),
);

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-delegated-completion-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const VcsDriverRegistryTestLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(PlatformTestLayer),
);

const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistryTestLayer),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  // No supportedRuntimeModes: every runtime mode runs as stored.
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestProviderInstanceRegistry = Layer.succeed(ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
  listInstances: Effect.succeed([providerInstance]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});

const TestLayer = Layer.mergeAll(OrchestrationV2LayerLive, OrchestrationV2EventSinkLayerLive).pipe(
  Layer.provideMerge(ProjectServiceLayerLive),
  Layer.provide(
    Layer.mock(WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(worktreeRepairDependenciesTestLayer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(PlatformTestLayer),
);

it.effect(
  "no-task archive, unarchive and delete read only the parent's keyed records and preserve the upstream plan",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statements: string[] = [];
      const countedSql = new Proxy(sql, {
        apply(target, thisArg, args) {
          const statement: Statement.Statement<unknown> = Reflect.apply(target, thisArg, args);
          statements.push(statement.compile()[0]);
          return statement;
        },
      });
      const program = Effect.gen(function* () {
        const store = yield* ProjectionStoreV2;
        const allocator = yield* IdAllocatorV2;
        const id = ThreadId.make("ordinary");
        const now = yield* DateTime.now;
        yield* store.apply({
          id: EventId.make("ordinary:create"),
          type: "thread.created",
          threadId: id,
          occurredAt: now,
          payload: {
            id,
            projectId: ProjectId.make("project"),
            title: "Ordinary",
            createdBy: "user",
            creationSource: "web",
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, rootThreadId: id, relationshipToParent: null },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        const reads: unknown[] = [];
        const countedStore = {
          ...store,
          getShellSnapshot: () => Effect.die("lifecycle must never read a shell list"),
          getThread: () => Effect.die("no task IDs means no child reads"),
          getThreadRecords: ((...args: Parameters<typeof store.getThreadRecords>) => {
            reads.push(args);
            return store.getThreadRecords(...args);
          }) satisfies typeof store.getThreadRecords,
        };
        for (const type of ["thread.archive", "thread.unarchive", "thread.delete"] as const) {
          statements.length = 0;
          const parentPlan = { events: [], effects: [] };
          const result = yield* withTaskThreadLifecycle(
            { type, threadId: id, commandId: CommandId.make(type) },
            countedStore,
            allocator,
            () => Effect.die("no children means no additional plans"),
          )(parentPlan);
          assert.strictEqual(result, parentPlan);
          assert.isTrue(
            statements.every(
              (query) =>
                !query.trimStart().startsWith("SELECT") ||
                (query.includes("thread_id =") && !query.includes("projection_runs")),
            ),
          );
        }
        assert.deepEqual(
          reads,
          Array.from({ length: 3 }, () => [id, ["subagents"]]),
        );
      });
      yield* program.pipe(
        Effect.provide(
          Layer.merge(projectionLayer, idAllocatorLayer).pipe(
            Layer.provide(Layer.succeed(SqlClient.SqlClient, countedSql)),
          ),
        ),
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "archive cancels and archives every task; undo restores cancelled rows; delete removes children first in one receipt",
  () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService;
      const orchestrator = yield* OrchestratorV2;
      const sink = yield* EventSinkV2;
      const store = {
        getThreadProjection: orchestrator.getThreadProjection,
        getThreadShell: orchestrator.getThreadShell,
      };
      const projectId = ProjectId.make("project:task-lifecycle");
      const parentId = ThreadId.make("parent:task-lifecycle");
      const nativeId = ThreadId.make("native:task-lifecycle");
      const ids = [
        ThreadId.make("running:task-lifecycle"),
        ThreadId.make("queued:task-lifecycle"),
        ThreadId.make("finished:task-lifecycle"),
      ];
      yield* projects.create({
        commandId: CommandId.make("project:create"),
        projectId,
        title: "Task lifecycle",
        workspaceRoot: "/workspace/tasks",
      });
      for (const id of [parentId, ...ids, nativeId]) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${id}`),
          threadId: id,
          projectId,
          createdBy: "user",
          creationSource: "web",
          title: id,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
      }
      const now = yield* DateTime.now;
      for (const [index, id] of [...ids, nativeId].entries()) {
        const projection = yield* store.getThreadProjection(id);
        const runId = RunId.make(`run:${id}`);
        const status = index === 0 ? "running" : index === 1 ? "queued" : "completed";
        yield* sink.write({
          commandId: CommandId.make(`seed:${id}`),
          events: [
            {
              id: EventId.make(`lineage:${id}`),
              type: "thread.metadata-updated",
              threadId: id,
              occurredAt: now,
              payload: {
                ...projection.thread,
                creationSource: id === nativeId ? "provider" : "mcp",
                createdBy: "agent",
                lineage: {
                  parentThreadId: parentId,
                  rootThreadId: parentId,
                  relationshipToParent: "subagent",
                },
              },
            },
            {
              id: EventId.make(`task:${id}`),
              type: "subagent.updated",
              threadId: parentId,
              occurredAt: now,
              payload: {
                id: NodeId.make(`task:${id}`),
                threadId: parentId,
                runId: null,
                parentNodeId: NodeId.make("parent-root"),
                origin: id === nativeId ? "provider_native" : "app_owned",
                createdBy: "agent",
                driver,
                providerInstanceId: modelSelection.instanceId,
                providerThreadId: null,
                childThreadId: id,
                nativeTaskRef: null,
                prompt: "Work",
                title: id,
                model: null,
                status: status === "queued" ? "pending" : status,
                result: status === "completed" ? "Done" : null,
                startedAt: now,
                completedAt: status === "completed" ? now : null,
                updatedAt: now,
              },
            },
            {
              id: EventId.make(`run:${id}`),
              type: "run.updated",
              threadId: id,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId: id,
                ordinal: 1,
                providerInstanceId: modelSelection.instanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: MessageId.make(`message:${id}`),
                rootNodeId: null,
                activeAttemptId: null,
                status,
                requestedAt: now,
                startedAt: status === "queued" ? null : now,
                completedAt: status === "completed" ? now : null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });
      }
      yield* sink.write({
        commandId: CommandId.make("seed:blocked-task"),
        events: [
          {
            id: EventId.make("session:task"),
            type: "provider-session.attached",
            threadId: ids[0]!,
            occurredAt: now,
            payload: {
              id: ProviderSessionId.make("session:task"),
              driver,
              providerInstanceId: modelSelection.instanceId,
              status: "running",
              cwd: "/workspace/tasks",
              model: null,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          },
          {
            id: EventId.make("request:task"),
            type: "runtime-request.updated",
            threadId: ids[0]!,
            occurredAt: now,
            payload: {
              id: RuntimeRequestId.make("request:task"),
              nodeId: NodeId.make("node:task"),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
      });
      const command = {
        type: "thread.archive" as const,
        commandId: CommandId.make("archive:parent"),
        threadId: parentId,
      };
      const archived = yield* orchestrator.dispatch(command);
      assert.strictEqual(
        archived.storedEvents.filter((stored) => stored.event.type === "thread.archived").length,
        4,
      );
      for (const id of ids)
        assert.isNotNull((yield* store.getThreadProjection(id)).thread.archivedAt);
      assert.isNull((yield* store.getThreadProjection(nativeId)).thread.archivedAt);
      assert.strictEqual((yield* store.getThreadProjection(ids[0]!)).runs[0]?.status, "cancelled");
      assert.strictEqual((yield* store.getThreadProjection(ids[1]!)).runs[0]?.status, "cancelled");
      assert.strictEqual((yield* store.getThreadProjection(ids[2]!)).runs[0]?.status, "completed");
      const parentTasks = (yield* store.getThreadProjection(parentId)).subagents;
      assert.deepEqual(
        parentTasks
          .filter((task) => task.origin === "app_owned")
          .map((task) => task.status)
          .sort(),
        ["cancelled", "cancelled", "completed"],
      );
      const stopped = yield* store.getThreadProjection(ids[0]!);
      assert.strictEqual(stopped.runtimeRequests[0]?.status, "cancelled");
      assert.strictEqual(stopped.runtimeRequests[0]?.responseCapability.type, "not_resumable");
      assert.lengthOf(stopped.providerSessions, 0);
      const archiveOrder = archived.storedEvents
        .filter((stored) => stored.event.type === "thread.archived")
        .map((stored) => stored.event.threadId);
      assert.strictEqual(archiveOrder.at(-1), parentId);
      const replay = yield* orchestrator.dispatch(command);
      assert.strictEqual(replay.sequence, archived.sequence);
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("unarchive:parent"),
        threadId: parentId,
      });
      for (const id of ids) assert.isNull((yield* store.getThreadProjection(id)).thread.archivedAt);
      assert.strictEqual((yield* store.getThreadProjection(ids[0]!)).runs[0]?.status, "cancelled");
      const deleted = yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete:parent"),
        threadId: parentId,
      });
      const deletionOrder = deleted.storedEvents
        .filter((stored) => stored.event.type === "thread.deleted")
        .map((stored) => stored.event.threadId);
      assert.deepEqual(new Set(deletionOrder.slice(0, -1)), new Set(ids));
      assert.strictEqual(deletionOrder.at(-1), parentId);
      for (const id of ids) assert.isNull(yield* store.getThreadShell(id));
      assert.isNotNull(yield* store.getThreadShell(nativeId));
    }).pipe(Effect.provide(TestLayer)),
);
