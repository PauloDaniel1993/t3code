import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";
import TaskDeliveryIndex from "../persistence/ForkMigrations/011_TaskDeliveryIndex.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { layer, ProjectionStoreV2, threadShellFromProjection } from "./ProjectionStore.ts";
import { taskDeliveryFromSubagents, withTaskDeliveryWatermarks } from "./TaskDeliveryShell.ts";

const TestLayer = layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const now = DateTime.makeUnsafe("2026-09-29T00:00:00Z");
const providerInstanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("parent");
const created: OrchestrationV2DomainEvent = {
  id: EventId.make("created"),
  type: "thread.created",
  threadId,
  occurredAt: now,
  payload: {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Parent",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, rootThreadId: threadId, relationshipToParent: null },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
};
const task: OrchestrationV2Subagent = {
  id: NodeId.make("task"),
  threadId,
  runId: null,
  parentNodeId: NodeId.make("root"),
  origin: "app_owned",
  createdBy: "agent",
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId,
  providerThreadId: null,
  childThreadId: ThreadId.make("child"),
  nativeTaskRef: null,
  prompt: "Work",
  title: "Work",
  model: null,
  status: "completed",
  result: "Done",
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  completionDelivery: {
    state: "delivered",
    observedByRunId: null,
    deliveredAt: "2026-09-29T00:08:00.000Z",
  },
};

it.effect(
  "cold shell list and individual reads see deliveries, including acknowledged records outside detail windows",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      yield* store.apply(created);
      assert.isUndefined((yield* store.getThreadShell(threadId))?.latestTaskDeliveredAt);
      for (const state of ["delivered", "acknowledged", "disposed"] as const) {
        yield* store.apply({
          id: EventId.make(state),
          type: "subagent.updated",
          threadId,
          occurredAt: now,
          payload: { ...task, completionDelivery: { ...task.completionDelivery!, state } },
        });
        assert.strictEqual(
          (yield* store.getThreadShell(threadId))?.latestTaskDeliveredAt,
          task.completionDelivery!.deliveredAt,
        );
        assert.strictEqual(
          (yield* store.getShellSnapshot()).threads[0]?.latestTaskDeliveredAt,
          task.completionDelivery!.deliveredAt,
        );
      }
      const full = yield* store.getThreadProjection(threadId);
      assert.strictEqual(
        threadShellFromProjection(full).latestTaskDeliveredAt,
        task.completionDelivery!.deliveredAt,
      );
      assert.deepEqual(taskDeliveryFromSubagents([{ ...task, origin: "provider_native" }]), {});
      assert.deepEqual(
        taskDeliveryFromSubagents([
          { ...task, completionDelivery: { state: "delivered", observedByRunId: null } },
        ]),
        {},
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("2000 shell watermarks use one batch query, with no task field on ordinary rows", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    yield* store.apply(created);
    yield* store.apply({
      id: EventId.make("delivery"),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: task,
    });
    let queries = 0;
    let statement: Statement.Statement<unknown> | undefined;
    const countedSql = new Proxy(sql, {
      apply(target, thisArg, args) {
        queries++;
        statement = Reflect.apply(target, thisArg, args);
        return statement;
      },
    });
    const rows = Array.from({ length: 2000 }, (_, index) => ({
      thread_id: index === 0 ? threadId : `ordinary-${index}`,
    }));
    const result = yield* withTaskDeliveryWatermarks(countedSql)(rows);
    assert.strictEqual(queries, 1);
    assert.strictEqual(result.length, 2000);
    const expected = {
      thread_id: threadId,
      latestTaskDeliveredAt: task.completionDelivery!.deliveredAt,
    };
    assert.deepEqual(result[0], expected);
    assert.deepEqual(result[1999], rows[1999]);
    const [query, bindings] = statement!.compile();
    const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, bindings);
    assert.isTrue(plan.some((row) => row.detail.includes("fork_v2_task_delivery_idx")));
    const instructions = yield* sql.unsafe<{ opcode: string; p4: string | null }>(
      `EXPLAIN ${query}`,
      bindings,
    );
    assert.isFalse(
      instructions.some((row) => row.opcode === "Function" && row.p4?.includes("json_extract")),
    );
    const single = yield* withTaskDeliveryWatermarks(countedSql)([rows[0]!]);
    assert.deepEqual(single[0], expected);
    const [liveQuery, liveBindings] = statement!.compile();
    const livePlan = yield* sql.unsafe<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${liveQuery}`,
      liveBindings,
    );
    assert.isTrue(
      livePlan.some((row) =>
        row.detail.includes("SEARCH task USING INDEX fork_v2_task_delivery_idx (thread_id=?)"),
      ),
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "fork migration 011 backfills once and maintains timestamps on update, acknowledgement and deletion",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP INDEX fork_v2_task_delivery_idx`;
      yield* store.apply(created);
      yield* store.apply({
        id: EventId.make("legacy"),
        type: "subagent.updated",
        threadId,
        occurredAt: now,
        payload: task,
      });
      yield* TaskDeliveryIndex;
      yield* TaskDeliveryIndex;
      const latest = "2026-09-29T00:09:00.000Z";
      for (const state of ["delivered", "acknowledged"] as const) {
        yield* store.apply({
          id: EventId.make(`update:${state}`),
          type: "subagent.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...task,
            prompt: "p".repeat(8192),
            result: "r".repeat(24576),
            completionDelivery: { state, observedByRunId: null, deliveredAt: latest },
          },
        });
        assert.strictEqual((yield* store.getThreadShell(threadId))?.latestTaskDeliveredAt, latest);
      }
      yield* sql`DELETE FROM orchestration_v2_projection_subagents WHERE subagent_id = ${task.id}`;
      assert.isUndefined((yield* store.getThreadShell(threadId))?.latestTaskDeliveredAt);
      const upstream =
        yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE name = 'TaskDeliveryIndex'`;
      assert.lengthOf(upstream, 0);
    }).pipe(Effect.provide(TestLayer)),
);
