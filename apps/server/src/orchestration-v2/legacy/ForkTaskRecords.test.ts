import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../ProviderAdapterRegistry.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { ProjectionMaintenanceV2 } from "../ProjectionMaintenance.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { LegacyV1ThreadImporter } from "./LegacyV1ThreadImporter.ts";
import { repairForkTaskLinks } from "./ForkTaskLinkRepair.ts";
import { TestLayer, seedThreads, stamp } from "./ForkDataCarryOver.testkit.ts";

const end = "2026-01-01T00:08:00.000Z";
const statuses = ["finished", "failed", "cancelled", "queued", "running"] as const;
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "fork-task-records" },
  Layer.mock(ProviderAdapterRegistryV2)({}),
  { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
);

it.effect(
  "imports native task records, preserves real rename/archive commands and replays without duplication",
  () =>
    Effect.gen(function* () {
      yield* seedThreads([["root", null], ...statuses.map((status) => [status, "root"] as const)]);
      const sql = yield* SqlClient.SqlClient;
      for (const status of statuses) {
        const task = {
          title: status,
          prompt: `Do ${status}`,
          createdBy: "agent",
          status,
          requestedAt: stamp,
          startedAt: stamp,
          finishedAt: status === "queued" || status === "running" ? null : end,
          result: status === "finished" ? { summary: "Result", completedAt: end } : null,
          delivery: status === "finished" ? { state: "delivered" } : null,
        };
        yield* sql`UPDATE projection_threads SET task_json = ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(task)}, updated_at = ${end} WHERE thread_id = ${status}`;
      }
      const importer = yield* LegacyV1ThreadImporter;
      yield* importer.reconcileShells;
      yield* repairForkTaskLinks();
      yield* importer.importPendingTranscripts;
      const projections = yield* ProjectionStoreV2;
      const parent = yield* projections.getThreadProjection(ThreadId.make("root"));
      assert.lengthOf(parent.subagents, 5);
      for (const status of statuses) {
        const task = parent.subagents.find((entry) => entry.childThreadId === status)!;
        assert.equal(
          task.status,
          status === "finished" ? "completed" : status === "failed" ? "failed" : "cancelled",
        );
        assert.equal(task.origin, "app_owned");
        assert.equal(task.prompt, `Do ${status}`);
        assert.equal(DateTime.formatIso(task.completedAt!), end);
        assert.equal(
          task.completionDelivery?.state,
          status === "finished" ? "delivered" : "disposed",
        );
        assert.isNull(task.runId);
        assert.isTrue(parent.nodes.some((node) => node.id === task.parentNodeId));
        assert.isTrue(
          parent.turnItems.some((item) => item.type === "subagent" && item.subagentId === task.id),
        );
      }
      const orchestrator = yield* OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename-import"),
        threadId: ThreadId.make("finished"),
        title: "Renamed in V2",
      });
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-import"),
        threadId: ThreadId.make("finished"),
      });
      yield* repairForkTaskLinks();
      const maintenance = yield* ProjectionMaintenanceV2;
      yield* maintenance.compactEventStore;
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* projections.getThreadProjection(ThreadId.make("root"))).subagents,
        parent.subagents,
      );
      const child = yield* projections.getThread(ThreadId.make("finished"));
      assert.equal(child.title, "Renamed in V2");
      assert.isNotNull(child.archivedAt);
      assert.equal(child.lineage.parentThreadId, "root");
      assert.deepEqual(yield* repairForkTaskLinks(), { repairedThreadCount: 0 });
    }).pipe(Effect.provide(Layer.mergeAll(TestLayer, runtime))),
);
