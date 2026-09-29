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
  ForkTaskModelsResult,
  ForkTaskSummary,
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
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { layer as serviceLayer, OrchestratorMcpService } from "./OrchestratorMcpService.ts";
import { ThreadMetadataMcpService } from "./ThreadMetadataMcpService.ts";
import { OrchestratorToolkitHandlersLive } from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import {
  TASK_LIST_RESPONSE_MAX_BYTES,
  TASK_LIST_SUMMARY_MAX_CHARS,
  taskListResponseBytes,
} from "./OrchestratorTaskList.ts";

const decodeCapabilities = Schema.decodeUnknownEffect(OrchestratorMcpCapabilitiesResult);
const decodeCreatedTask = Schema.decodeUnknownEffect(ForkTaskSummary);
const decodeModels = Schema.decodeUnknownEffect(ForkTaskModelsResult);
const encodeMcpResponse = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
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
    providers?: readonly ServerProvider[];
    unreadable?: ThreadId;
  } = {},
) {
  return serviceLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService)({
          getThreadRecords: (id) =>
            id === options.unreadable
              ? Effect.fail(
                  new OrchestratorProjectionError({
                    cause: new Error("Child projection unreadable"),
                    threadId: id,
                  }),
                )
              : Effect.sync(() => {
                  options.reads?.push(id);
                  const record = records.get(id);
                  if (record === undefined) throw new Error(`Unexpected thread read ${id}`);
                  return record;
                }),
          dispatch:
            options.dispatch ?? (() => Effect.die("Listing must not acknowledge or dispatch.")),
        }),
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed(options.providers ?? [provider]),
        }),
        Layer.mock(ProviderAdapterRegistryV2)({
          list: () =>
            Effect.succeed(
              (options.providers ?? [provider]).map((provider) => provider.instanceId),
            ),
        }),
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
          result: null,
          workState: "working",
        });
        expect(result.tasks[1]).toMatchObject({
          title: finished.title,
          status: "finished",
          result: { summaryTruncated: true, summaryChars: finished.result!.length },
          latestTerminalResult: null,
        });
        expect(result.nextCursor).toBeNull();
        expect(result.tasks[1]!.result!.summary).toHaveLength(TASK_LIST_SUMMARY_MAX_CHARS);
        expect(result.tasks[1]!.result!.summary).toContain("[truncated; call task_status");
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
        result: null,
      });
      expect(result.tasks.find((item) => item.taskId === finished.id)).toMatchObject({
        result: { summary: finished.result },
        latestTerminalResult: { summary: "Follow-up result", summaryTruncated: false },
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
      expect(first.tasks).toHaveLength(20);
      expect(first.nextCursor).not.toBeNull();
      expect(reads).not.toContain(tasks[20]!.childThreadId);
      const second = yield* service.listTasks(scope, { cursor: first.nextCursor! });
      expect(second.tasks).toHaveLength(20);
      const third = yield* service.listTasks(scope, { cursor: second.nextCursor! });
      expect(third.tasks).toHaveLength(15);
      expect(third.nextCursor).toBeNull();
      expect([...first.tasks, ...second.tasks, ...third.tasks].map((item) => item.taskId)).toEqual(
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
            status:
              expected.status === "completed"
                ? "finished"
                : expected.status === "interrupted"
                  ? "cancelled"
                  : expected.status,
            result: { summary: expected.result },
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
        .listTasks(scope, { cursor: '{"createdAt":1790683200000,"seen":["task:other-parent"]}' })
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

function makeMcpLayer(
  records: Map<ThreadId, OrchestrationV2ThreadProjection>,
  options: Parameters<typeof makeLayer>[1] = {},
) {
  return McpServer.toolkit(OrchestratorToolkit).pipe(
    Layer.provide(OrchestratorToolkitHandlersLive),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(makeLayer(records, options)),
    Layer.provide(Layer.mock(ThreadMetadataMcpService)({})),
  );
}

it.effect(
  "bounds all MCP pages for 60 long completed results and retrieves full text separately",
  () => {
    const tasks = Array.from({ length: 60 }, (_, index) =>
      task(String(index).padStart(3, "0"), {
        result:
          `Report ${index}: ` +
          (index % 2 === 0 ? "\u0000".repeat(36_000) : '漢字😀"\\\n'.repeat(6_000)),
        completionDelivery: { state: "disposed", observedByRunId: null },
      }),
    );
    const reads: ThreadId[] = [];
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const response = yield* server
          .callTool({
            name: "task_list",
            arguments: { status: "finished", ...(cursor === undefined ? {} : { cursor }) },
          })
          .pipe(
            Effect.provideService(McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        const result = yield* decodeListedTasks(response.structuredContent);
        expect(taskListResponseBytes(result)).toBeLessThanOrEqual(TASK_LIST_RESPONSE_MAX_BYTES);
        const encoded = yield* encodeMcpResponse(response);
        expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(
          TASK_LIST_RESPONSE_MAX_BYTES,
        );
        expect(result.tasks.length).toBeGreaterThan(0);
        expect(result.tasks.length).toBeLessThanOrEqual(20);
        for (const entry of result.tasks) {
          expect(entry.result?.summary.length).toBeLessThanOrEqual(TASK_LIST_SUMMARY_MAX_CHARS);
          expect(entry.result).toMatchObject({
            summaryTruncated: true,
            summaryChars: tasks.find((task) => task.id === entry.taskId)!.result!.length,
          });
          expect(entry.result?.summary).toContain("[truncated; call task_status");
          expect(entry.latestTerminalResult).toBeNull();
          seen.push(entry.taskId);
        }
        cursor = result.nextCursor ?? undefined;
        expect(seen.length).toBeLessThanOrEqual(60);
      } while (cursor !== undefined);
      expect(seen).toEqual(tasks.map((task) => task.id));
      const full = yield* server
        .callTool({ name: "task_status", arguments: { taskId: tasks[0]!.id } })
        .pipe(
          Effect.provideService(McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(full.structuredContent).toMatchObject({ summary: tasks[0]!.result });
      expect(reads.filter((id) => id === parentId).length).toBeGreaterThan(1);
    }).pipe(Effect.provide(makeMcpLayer(recordsFor(tasks), { reads })));
  },
);

it.effect("returns readable siblings when one child cannot be loaded", () => {
  const tasks = [task("a"), task("b"), task("c")];
  return Effect.gen(function* () {
    const service = yield* OrchestratorMcpService;
    const result = yield* service.listTasks(scope, {});
    expect(result.tasks.map((entry) => entry.taskId)).toEqual(tasks.map((task) => task.id));
    expect(result.tasks[1]).toMatchObject({
      taskId: tasks[1]!.id,
      status: null,
      result: null,
      error: expect.stringContaining("Could not read this child"),
    });
    expect(result.tasks[0]?.result?.summary).toBe(tasks[0]!.result);
    expect(result.tasks[2]?.result?.summary).toBe(tasks[2]!.result);
  }).pipe(Effect.provide(makeLayer(recordsFor(tasks), { unreadable: tasks[1]!.childThreadId! })));
});

it.effect(
  "keeps creation order through updates and includes tasks inserted between pages, even timestamp ties",
  () => {
    const firstTask = task("z-old", { startedAt: DateTime.makeUnsafe("2026-09-29T11:00:00Z") });
    const secondTask = task("m-second");
    const lastTask = task("z-last", { startedAt: DateTime.makeUnsafe("2026-09-29T13:00:00Z") });
    const records = recordsFor([lastTask, secondTask, firstTask]);
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService;
      const first = yield* service.listTasks(scope, { limit: 2 });
      expect(first.tasks.map((entry) => entry.taskId)).toEqual([firstTask.id, secondTask.id]);
      const tied = task("a-new-tied");
      const newer = task("a-newer", { startedAt: DateTime.makeUnsafe("2026-09-29T14:00:00Z") });
      for (const [id, record] of recordsFor([tied, newer]))
        if (id !== parentId && id !== otherId) records.set(id, record);
      records.set(parentId, {
        ...records.get(parentId)!,
        subagents: [
          newer,
          tied,
          lastTask,
          { ...secondTask, updatedAt: DateTime.makeUnsafe("2026-09-30T00:00:00Z") },
          firstTask,
        ],
      });
      const second = yield* service.listTasks(scope, { cursor: first.nextCursor! });
      expect(second.tasks.map((entry) => entry.taskId)).toEqual([tied.id, lastTask.id, newer.id]);
      expect(second.nextCursor).toBeNull();
    }).pipe(Effect.provide(makeLayer(records)));
  },
);

it.effect("maps every fork status filter and advances empty filtered pages", () => {
  const tasks = [
    task("a-running", { status: "running", result: null }),
    task("b-queued", { status: "pending", result: null }),
    task("c-completed"),
    task("d-failed", { status: "failed" }),
    task("e-cancelled", { status: "cancelled" }),
    task("f-interrupted", { status: "interrupted" }),
  ];
  return Effect.gen(function* () {
    const service = yield* OrchestratorMcpService;
    for (const [status, count] of [
      ["queued", 1],
      ["running", 1],
      ["finished", 1],
      ["failed", 1],
      ["cancelled", 2],
    ] as const) {
      const page = yield* service.listTasks(scope, { status });
      expect(page.tasks).toHaveLength(count);
      expect(page.tasks.every((entry) => entry.status === status)).toBe(true);
    }
    const empty = yield* service.listTasks(scope, { status: "finished", limit: 2 });
    expect(empty.tasks).toEqual([]);
    expect(empty.nextCursor).not.toBeNull();
    const next = yield* service.listTasks(scope, { status: "finished", cursor: empty.nextCursor! });
    expect(next.tasks.map((entry) => entry.taskId)).toEqual([tasks[2]!.id]);
  }).pipe(Effect.provide(makeLayer(recordsFor(tasks))));
});

for (const driver of ["codex", "claudeCode"] as const) {
  it.effect(
    `preserves ${driver} parent options for reasoning changes and uses another model's defaults`,
    () => {
      const reasoningId = driver === "codex" ? "reasoningEffort" : "effort";
      const extraId = driver === "codex" ? "serviceTier" : "contextWindow";
      const extraDefault = driver === "codex" ? "standard" : "200k";
      const extraParent = driver === "codex" ? "fast" : "1m";
      const descriptors = [
        {
          id: reasoningId,
          label: "Reasoning",
          type: "select" as const,
          options: [
            { id: "low", label: "Low", isDefault: true },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra high" },
          ],
        },
        {
          id: extraId,
          label: extraId,
          type: "select" as const,
          options: [
            { id: extraDefault, label: extraDefault, isDefault: true },
            { id: extraParent, label: extraParent },
          ],
        },
        { id: "thinking", label: "Thinking", type: "boolean" as const, currentValue: false },
      ];
      const activeProvider: ServerProvider = {
        ...provider,
        driver: ProviderDriverKind.make(driver),
        models: [
          {
            slug: "custom-model",
            name: "Current",
            isCustom: false,
            isDefault: true,
            capabilities: { optionDescriptors: descriptors },
          },
          {
            slug: "other-model",
            name: "Other",
            isCustom: false,
            capabilities: { optionDescriptors: descriptors },
          },
          {
            slug: "no-reasoning",
            name: "No reasoning",
            isCustom: false,
            capabilities: { optionDescriptors: [] },
          },
        ],
      };
      const disabled = {
        ...activeProvider,
        instanceId: ProviderInstanceId.make(`${driver}-disabled`),
        enabled: false,
        status: "disabled" as const,
      };
      const child = task("created", { status: "running", result: null });
      const remote: ServerProvider = {
        ...activeProvider,
        instanceId: ProviderInstanceId.make(`${driver}-remote`),
        driver: ProviderDriverKind.make("acpRegistry"),
        models: [
          {
            slug: "remote-model",
            name: "Remote",
            isCustom: true,
            capabilities: {
              optionDescriptors: [{ ...descriptors[0]!, id: "session/reasoning_effort" }],
            },
          },
        ],
      };
      const records = recordsFor([child]);
      records.set(parentId, {
        ...records.get(parentId)!,
        thread: {
          ...records.get(parentId)!.thread,
          modelSelection: {
            instanceId,
            model: "custom-model",
            options: [
              { id: reasoningId, value: "high" },
              { id: extraId, value: extraParent },
              { id: "thinking", value: true },
            ],
          },
        },
        runs: [run(parentId, "running")],
      });
      const commands: Parameters<ThreadManagementService["Service"]["dispatch"]>[0][] = [];
      const layer = makeMcpLayer(records, {
        providers: [activeProvider, disabled, remote],
        dispatch: (command) => {
          commands.push(command);
          return Effect.succeed({
            sequence: 1,
            storedEvents: [
              {
                sequence: 1,
                commandId: command.commandId,
                event: {
                  id: EventId.make("event:options"),
                  threadId: parentId,
                  type: "subagent.updated",
                  occurredAt: now,
                  payload: child,
                },
              },
            ],
          });
        },
      });
      return Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const call = (name: string, args: Record<string, unknown>) =>
          server
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext, scope),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
        const catalog = yield* decodeModels((yield* call("task_models", {})).structuredContent);
        expect(catalog.current).toEqual({ instanceId, model: "custom-model", reasoning: "high" });
        expect(catalog.instances.map((instance) => instance.ready)).toEqual([true, false, true]);
        expect(catalog.instances[0]?.models[0]).toMatchObject({
          isDefault: true,
          reasoningLevels: [
            { id: "low", isDefault: true },
            { id: "high", isDefault: false },
            { id: "xhigh", isDefault: false },
          ],
        });
        expect(
          (yield* decodeModels(
            (yield* call("task_models", { instanceId: disabled.instanceId })).structuredContent,
          )).instances.map((instance) => instance.instanceId),
        ).toEqual([disabled.instanceId]);
        const input = {
          title: "Review",
          prompt: "Review the module.",
          context: "none",
          reasoning: "xhigh",
        };
        yield* call("task_create", input);
        yield* call("task_create", { ...input, model: { instanceId, model: "custom-model" } });
        yield* call("task_create", {
          ...input,
          model: { instanceId, model: "other-model" },
          reasoning: "Extra High",
        });
        for (const command of commands.slice(0, 2))
          expect(command).toMatchObject({
            modelSelection: {
              instanceId,
              model: "custom-model",
              options: [
                { id: extraId, value: extraParent },
                { id: "thinking", value: true },
                { id: reasoningId, value: "xhigh" },
              ],
            },
          });
        expect(commands[2]).toMatchObject({
          modelSelection: {
            instanceId,
            model: "other-model",
            options: [
              { id: extraId, value: extraDefault },
              { id: "thinking", value: false },
              { id: reasoningId, value: "xhigh" },
            ],
          },
        });
        expect(
          (yield* call("task_create", { ...input, model: { instanceId, model: "no-reasoning" } }))
            .structuredContent,
        ).toMatchObject({
          code: "invalid_request",
          message: expect.stringContaining("has no reasoning levels"),
        });
        expect(
          (yield* call("task_create", {
            ...input,
            model: { instanceId: disabled.instanceId, model: "custom-model" },
          })).structuredContent,
        ).toMatchObject({ code: "provider_unavailable" });
        yield* call("task_create", {
          ...input,
          model: { instanceId: remote.instanceId, model: "remote-model" },
        });
        expect(commands[3]).toMatchObject({
          modelSelection: {
            instanceId: remote.instanceId,
            model: "remote-model",
            options: [{ id: "session/reasoning_effort", value: "xhigh" }],
          },
        });
        expect(commands).toHaveLength(4);
      }).pipe(Effect.provide(layer));
    },
  );
}

it.effect(
  "accepts exact fork calls through MCP while retaining native delegation and cancellation",
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
      const catalog = yield* decodeCapabilities(canonicalModels.structuredContent);
      expect(catalog.providers[0]?.models[0]?.options?.[0]?.id).toBe("reasoningEffort");
      const forkCatalog = yield* decodeModels(models.structuredContent);
      expect(forkCatalog.current).toEqual({ instanceId, model: "custom-model", reasoning: null });
      expect(forkCatalog.instances[0]).toMatchObject({
        instanceId,
        ready: true,
        models: [
          {
            model: "custom-model",
            reasoningLevels: [
              { id: "xhigh", label: "Extra high", isDefault: false, promptInjected: false },
            ],
          },
        ],
      });
      expect((yield* call("task_models", { instanceId })).structuredContent).toEqual(
        models.structuredContent,
      );
      const input = {
        title: "Implement feature",
        prompt: "Implement the feature.",
        context: "none",
        model: { instanceId, model: "custom-model" },
        reasoning: "xhigh",
        clientRequestId: "same-request",
      };
      const created = yield* call("task_create", input);
      const canonicalCreated = yield* call("delegate_task", {
        task: input.prompt,
        title: input.title,
        target: {
          providerInstanceId: instanceId,
          model: "custom-model",
          options: { reasoningEffort: "xhigh" },
        },
        clientRequestId: input.clientRequestId,
      });
      expect(canonicalCreated.structuredContent).toMatchObject({
        taskId: child.id,
        childThreadId: child.childThreadId,
        status: "running",
      });
      expect(commands[0]?.commandId).toEqual(commands[1]?.commandId);
      expect(commands[0]).toMatchObject({
        type: "delegated_task.request",
        parentThreadId: parentId,
        task: input.prompt,
        title: input.title,
        modelSelection: {
          instanceId,
          model: "custom-model",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
        completionWake: "always",
      });
      const createdTask = yield* decodeCreatedTask(created.structuredContent);
      expect(createdTask).toMatchObject({
        threadId: child.childThreadId,
        title: child.title,
        status: "running",
        context: { kind: "none" },
      });
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
        reasoning: "unsupported",
      });
      expect(invalid.structuredContent).toMatchObject({ code: "invalid_request" });
      const unavailable = yield* call("task_create", {
        ...input,
        model: { instanceId, model: "unadvertised-model" },
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
      const escalated = yield* call("delegate_task", {
        task: input.prompt,
        runtimeMode: "full-access",
      });
      expect(escalated.structuredContent).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect(commands).toHaveLength(2);
      for (const context of ["full-thread", "selected-messages"]) {
        const rejected = yield* call("task_create", {
          ...input,
          context,
          messageIds: ["message:first"],
        });
        expect(rejected.structuredContent).toMatchObject({
          code: "invalid_request",
          message: expect.stringContaining("supported context value is 'none'"),
        });
      }
      const filtered = yield* call("task_list", { status: "finished" });
      expect((yield* decodeListedTasks(filtered.structuredContent)).tasks).toEqual([]);
      const cancelled = yield* call("task_cancel", { threadId: createdTask.threadId });
      expect(cancelled.structuredContent).toMatchObject({
        threadId: child.childThreadId,
        title: child.title,
        status: "running",
      });
      const nativeCancelled = yield* call("task_cancel", { taskId: child.id });
      expect(nativeCancelled.structuredContent).toEqual({
        taskId: child.id,
        status: "cancel_requested",
      });
      const foreignCancelled = yield* call("task_cancel", { threadId: otherId });
      expect(foreignCancelled.structuredContent).toMatchObject({ code: "task_not_found" });
      const interrupted = commands.filter((command) => command.type === "run.interrupt");
      expect(interrupted).toHaveLength(2);
      expect(interrupted[0]).toMatchObject({ threadId: child.childThreadId });
      const ended = {
        ...child,
        status: "interrupted" as const,
        result: "Task interrupted.",
        completionDelivery: { state: "disposed" as const, observedByRunId: null },
      };
      records.set(parentId, { ...records.get(parentId)!, subagents: [ended] });
      const terminalCancelled = yield* call("task_cancel", { threadId: createdTask.threadId });
      expect(terminalCancelled.structuredContent).toMatchObject({
        threadId: child.childThreadId,
        status: "cancelled",
        result: { outcome: "cancelled", summary: ended.result },
      });
      expect((yield* call("task_cancel", { taskId: child.id })).structuredContent).toEqual({
        taskId: child.id,
        status: "interrupted",
      });
    }).pipe(Effect.provide(layer));
  },
);
