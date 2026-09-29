import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpTaskListResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { layer as serviceLayer, OrchestratorMcpService } from "./OrchestratorMcpService.ts";
import { ThreadMetadataMcpService } from "./ThreadMetadataMcpService.ts";
import { OrchestratorToolkitHandlersLive } from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";

const decodeCapabilities = Schema.decodeUnknownEffect(OrchestratorMcpCapabilitiesResult);
const decodeCreatedTask = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeListedTasks = Schema.decodeUnknownEffect(OrchestratorMcpTaskListResult);

const parentId = ThreadId.make("thread:task-restorations:parent");
const otherId = ThreadId.make("thread:task-restorations:other");
const instanceId = ProviderInstanceId.make("codex-custom-instance");
const now = DateTime.makeUnsafe("2026-09-29T12:00:00.000Z");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:task-restorations"),
  threadId: parentId,
  providerSessionId: "session:task-restorations",
  providerInstanceId: instanceId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

function projection(id: ThreadId): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id,
      projectId: ProjectId.make("project:task-restorations"),
      title: id,
      createdBy: "agent",
      creationSource: "mcp",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "custom-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
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
}

function run(
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
  ordinal = 1,
): OrchestrationV2Run {
  return {
    id: RunId.make(`run:${threadId}:${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "custom-model" },
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${threadId}:${ordinal}`),
    rootNodeId: NodeId.make(`root:${threadId}:${ordinal}`),
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt: status === "running" || status === "queued" ? null : now,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function task(
  suffix: string,
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(`task:${suffix}`),
    threadId: parentId,
    runId: RunId.make("parent-run:original"),
    parentNodeId: NodeId.make("parent-node:original"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: instanceId,
    providerThreadId: null,
    childThreadId: ThreadId.make(`child:${suffix}`),
    nativeTaskRef: null,
    prompt: `Investigate ${suffix}.`,
    title: `Task ${suffix}`,
    model: "custom-model",
    status: "completed",
    result: `Result ${suffix}`,
    completionDelivery: { state: "pending", observedByRunId: null },
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  displayName: "Custom Codex",
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-29T12:00:00.000Z",
  models: [
    {
      slug: "custom-model",
      name: "Custom model",
      isCustom: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "xhigh", label: "Extra high" }],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};

function makeLayer(
  records: Map<ThreadId, OrchestrationV2ThreadProjection>,
  options: {
    reads?: ThreadId[];
    dispatch?: ThreadManagementService["Service"]["dispatch"];
  } = {},
) {
  return serviceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService)({
          getThreadRecords: (id) =>
            Effect.sync(() => {
              options.reads?.push(id);
              const record = records.get(id);
              if (record === undefined) throw new Error(`Unexpected thread read ${id}`);
              return record;
            }),
          dispatch:
            options.dispatch ?? (() => Effect.die("Listing must not acknowledge or dispatch.")),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
        Layer.mock(ProviderAdapterRegistryV2)({ list: () => Effect.succeed([instanceId]) }),
        Layer.mock(ScheduledTaskService)({}),
      ),
    ),
  );
}

function recordsFor(tasks: readonly OrchestrationV2Subagent[]) {
  const records = new Map<ThreadId, OrchestrationV2ThreadProjection>([
    [parentId, { ...projection(parentId), subagents: tasks }],
    [otherId, projection(otherId)],
  ]);
  for (const child of tasks) {
    if (child.childThreadId !== null) {
      const base = projection(child.childThreadId);
      records.set(child.childThreadId, {
        ...base,
        thread: {
          ...base.thread,
          lineage: {
            parentThreadId: child.threadId,
            relationshipToParent: "subagent",
            rootThreadId: child.threadId,
          },
        },
        runs: [
          run(
            child.childThreadId,
            child.status === "idle" || child.status === "pending" ? "queued" : child.status,
          ),
        ],
      });
    }
  }
  return records;
}

describe("task restorations on orchestration v2", () => {
  it.effect(
    "recovers direct tasks across turns and finished results without acknowledging delivery",
    () => {
      const finished = task("finished", { result: "Full task result. ".repeat(2_000) });
      const active = task("active", {
        result: null,
        status: "running",
        runId: RunId.make("parent-run:later"),
      });
      const native = task("native", { origin: "provider_native" });
      const foreign = task("foreign", { threadId: otherId });
      const unbacked = task("unbacked", { childThreadId: null });
      const reads: ThreadId[] = [];
      return Effect.gen(function* () {
        const service = yield* OrchestratorMcpService;
        const result = yield* service.listTasks(scope, {});
        expect(result.tasks.map((item) => item.taskId)).toEqual([active.id, finished.id]);
        expect(result.tasks[0]).toMatchObject({
          status: "running",
          summary: null,
          workState: "working",
        });
        expect(result.tasks[1]).toMatchObject({
          title: finished.title,
          status: "completed",
          summary: finished.result,
        });
        expect(result.nextCursor).toBeNull();
        expect(reads.filter((id) => id === parentId)).toHaveLength(1);
        expect(reads).not.toContain(native.childThreadId);
        expect(reads).not.toContain(foreign.childThreadId);
        expect((yield* service.listTasks({ ...scope, threadId: otherId }, {})).tasks).toEqual([]);
      }).pipe(
        Effect.provide(
          makeLayer(recordsFor([finished, active, native, foreign, unbacked]), { reads }),
        ),
      );
    },
  );

  it.effect("keeps settled turns with nested work running and exposes later child results", () => {
    const waiting = task("waiting", { result: null, status: "running" });
    const finished = task("finished");
    const records = recordsFor([waiting, finished]);
    const waitingId = waiting.childThreadId!;
    records.set(waitingId, {
      ...records.get(waitingId)!,
      runs: [run(waitingId, "completed")],
      subagents: [task("nested", { status: "running", result: null })],
    });
    const finishedId = finished.childThreadId!;
    const later = run(finishedId, "completed", 2);
    records.set(finishedId, {
      ...records.get(finishedId)!,
      runs: [run(finishedId, "completed"), later],
      messages: [
        {
          id: MessageId.make("message:later-result"),
          threadId: finishedId,
          runId: later.id,
          nodeId: null,
          createdBy: "agent",
          creationSource: "provider",
          role: "assistant",
          text: "Follow-up result",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService;
      const result = yield* service.listTasks(scope, {});
      expect(result.tasks.find((item) => item.taskId === waiting.id)).toMatchObject({
        status: "running",
        workState: "waiting_for_children",
        summary: null,
      });
      expect(result.tasks.find((item) => item.taskId === finished.id)).toMatchObject({
        summary: finished.result,
        latestTerminalSummary: "Follow-up result",
        latestTerminalRunId: later.id,
      });
    }).pipe(Effect.provide(makeLayer(records)));
  });

  it.effect("paginates dozens of tasks without fetching children outside the page", () => {
    const tasks = Array.from({ length: 55 }, (_, index) => task(String(index).padStart(3, "0")));
    const reads: ThreadId[] = [];
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService;
      const first = yield* service.listTasks(scope, {});
      expect(first.tasks).toHaveLength(50);
      expect(first.nextCursor).toBe(tasks[49]!.id);
      expect(reads).not.toContain(tasks[50]!.childThreadId);
      const second = yield* service.listTasks(scope, { cursor: first.nextCursor! });
      expect(second.tasks).toHaveLength(5);
      expect(second.nextCursor).toBeNull();
      expect([...first.tasks, ...second.tasks].map((item) => item.taskId)).toEqual(
        tasks.map((item) => item.id),
      );
    }).pipe(Effect.provide(makeLayer(recordsFor(tasks), { reads })));
  });

  it.effect(
    "returns failed, cancelled, and interrupted task outcomes alongside completed tasks",
    () => {
      const tasks = (["completed", "failed", "cancelled", "interrupted"] as const).map((status) =>
        task(status, { status, result: `Task ended: ${status}` }),
      );
      return Effect.gen(function* () {
        const service = yield* OrchestratorMcpService;
        const result = yield* service.listTasks(scope, {});
        for (const expected of tasks) {
          expect(result.tasks.find((item) => item.taskId === expected.id)).toMatchObject({
            status: expected.status,
            summary: expected.result,
            workState: "result_available",
          });
        }
      }).pipe(Effect.provide(makeLayer(recordsFor(tasks))));
    },
  );

  it.effect("rejects missing capability before reading state and rejects a foreign cursor", () => {
    const reads: ThreadId[] = [];
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService;
      const denied = yield* service
        .listTasks({ ...scope, capabilities: new Set() }, {})
        .pipe(Effect.flip);
      expect(denied.code).toBe("capability_denied");
      expect(reads).toEqual([]);
      const invalid = yield* service
        .listTasks(scope, { cursor: NodeId.make("task:other-parent") })
        .pipe(Effect.flip);
      expect(invalid.code).toBe("invalid_request");
    }).pipe(Effect.provide(makeLayer(recordsFor([]), { reads })));
  });
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "task-restorations", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "task-restorations", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect(
  "exposes aliases with V2 model options, shared request IDs, and delegation guards through MCP",
  () => {
    const child = task("created", { result: null, status: "running" });
    const records = recordsFor([child]);
    records.set(parentId, { ...records.get(parentId)!, runs: [run(parentId, "running")] });
    const commands: Parameters<ThreadManagementService["Service"]["dispatch"]>[0][] = [];
    const layer = McpServer.toolkit(OrchestratorToolkit).pipe(
      Layer.provide(OrchestratorToolkitHandlersLive),
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(
        makeLayer(records, {
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({
              sequence: 1,
              storedEvents: [
                {
                  sequence: 1,
                  commandId: command.commandId,
                  event: {
                    id: EventId.make("event:created-task"),
                    threadId: parentId,
                    type: "subagent.updated",
                    occurredAt: now,
                    payload: child,
                  },
                },
              ],
            });
          },
        }),
      ),
      Layer.provide(Layer.mock(ThreadMetadataMcpService)({})),
    );
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (name: string, args: Record<string, unknown>, caller = scope) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext, caller),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      const models = yield* call("task_models", {});
      const canonicalModels = yield* call("orchestrator_capabilities", {});
      expect(models.structuredContent).toEqual(canonicalModels.structuredContent);
      const catalog = yield* decodeCapabilities(models.structuredContent);
      expect(catalog.providers[0]?.models[0]?.options?.[0]?.id).toBe("reasoningEffort");
      const input = {
        task: "Implement the feature.",
        target: {
          providerInstanceId: instanceId,
          model: "custom-model",
          options: { reasoningEffort: "xhigh" },
        },
        clientRequestId: "same-request",
      };
      const created = yield* call("task_create", input);
      const canonicalCreated = yield* call("delegate_task", input);
      expect(created.structuredContent).toEqual(canonicalCreated.structuredContent);
      expect(commands[0]?.commandId).toEqual(commands[1]?.commandId);
      expect(commands[0]).toMatchObject({
        type: "delegated_task.request",
        parentThreadId: parentId,
        modelSelection: {
          instanceId,
          model: "custom-model",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
        completionWake: "always",
      });
      const createdTask = yield* decodeCreatedTask(created.structuredContent);
      const listed = yield* call("task_list", {});
      expect((yield* decodeListedTasks(listed.structuredContent)).tasks[0]?.taskId).toBe(
        createdTask.taskId,
      );
      for (const name of ["task_create", "task_models", "task_list"]) {
        const denied = yield* call(name, name === "task_create" ? input : {}, {
          ...scope,
          capabilities: new Set(),
        });
        expect(denied.structuredContent).toMatchObject({ code: "capability_denied" });
      }
      const invalid = yield* call("task_create", {
        ...input,
        target: { ...input.target, options: { reasoningEffort: "unsupported" } },
      });
      expect(invalid.structuredContent).toMatchObject({ code: "invalid_request" });
      const unavailable = yield* call("task_create", {
        ...input,
        target: { ...input.target, model: "unadvertised-model" },
      });
      expect(unavailable.structuredContent).toMatchObject({ code: "model_unavailable" });
      const wrongSession = yield* call("task_create", input, {
        ...scope,
        providerInstanceId: ProviderInstanceId.make("other-instance"),
      });
      expect(wrongSession.structuredContent).toMatchObject({ code: "parent_not_active" });
      const idle = yield* call("task_create", input, { ...scope, threadId: otherId });
      expect(idle.structuredContent).toMatchObject({ code: "parent_not_active" });
      records.set(parentId, {
        ...records.get(parentId)!,
        thread: { ...records.get(parentId)!.thread, runtimeMode: "approval-required" },
      });
      const escalated = yield* call("task_create", { ...input, runtimeMode: "full-access" });
      expect(escalated.structuredContent).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect(commands).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  },
);
