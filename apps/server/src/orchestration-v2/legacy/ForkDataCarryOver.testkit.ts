import * as Effect from "effect/Effect";
import { ThreadId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { layer as sinkLayer } from "../EventSink.ts";
import { layer as eventStoreLayer } from "../EventStore.ts";
import { layer as projectionLayer } from "../ProjectionStore.ts";
import { layer as projectLayer } from "../ProjectStore.ts";
import { layer as maintenanceLayer } from "../ProjectionMaintenance.ts";
import { LegacyV1ThreadImporter, layer as importerLayer } from "./LegacyV1ThreadImporter.ts";
import { layer as repairLayer } from "./ForkTaskLinkRepair.ts";

const stores = Layer.mergeAll(eventStoreLayer, projectionLayer, projectLayer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const sink = sinkLayer.pipe(Layer.provide(stores));
export const TestLayer = Layer.mergeAll(
  stores,
  sink,
  importerLayer.pipe(Layer.provide(Layer.mergeAll(stores, sink))),
  repairLayer.pipe(Layer.provide(Layer.mergeAll(stores, sink))),
  maintenanceLayer.pipe(Layer.provide(stores)),
);
export const stamp = "2026-01-01T00:00:00.000Z";
export const seedThreads = Effect.fnUntraced(function* (
  parents: ReadonlyArray<readonly [string, string | null]>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project', 'Project', '/fixture', '[]', ${stamp}, ${stamp})`;
  for (const [id, parent] of parents) {
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at, parent_thread_id)
      VALUES (${id}, 'project', ${id}, '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', ${stamp}, ${stamp}, ${parent})`;
  }
});

/** The reviewer's u1/r1/a1/u2/r2/a2 case, persisted with upstream's old ordinals. */
export const seedUnpatchedImport = Effect.fnUntraced(function* (
  complete: boolean,
  includeReasoning = true,
) {
  yield* seedThreads([["root", null]]);
  const sql = yield* SqlClient.SqlClient;
  for (const [id, role] of [
    ["1-u", "user"],
    ["2-r", "system"],
    ["3-a", "assistant"],
    ["4-u", "user"],
    ["5-r", "system"],
    ["6-a", "assistant"],
  ]) {
    yield* sql`INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${id}, 'root', ${role}, ${id}, 0, ${stamp}, ${stamp})`;
  }
  // Both importers exclude system. Restore reasoning only after reserving the
  // exact shell positions an unpatched importer writes (u2=3, a2=4).
  const importer = yield* LegacyV1ThreadImporter;
  yield* importer.reconcileShells;
  if (complete) yield* importer.ensureTranscript(ThreadId.make("root"));
  if (includeReasoning)
    yield* sql`UPDATE projection_thread_messages SET role = 'reasoning' WHERE role = 'system'`;
  // The partial case has no source tags: only incompatible ordinals expose it.
  // Without reasoning only lost provenance shows, which the check cannot tell from a payload rewrite.
  if (complete)
    yield* sql`UPDATE projection_thread_messages SET source = 'task-result' WHERE message_id = '4-u'`;
});
