import { CommandId, EventId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EventSinkV2 } from "../EventSink.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";

const REPAIR_PREFIX = "migration:fork:task-links:v1:";
const REPAIR_COMMAND = "fork.legacy-task-links.repair-v1";

export class ForkTaskLinkRepairError extends Schema.TaggedError<ForkTaskLinkRepairError>()(
  "ForkTaskLinkRepairError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const isRepairError = Schema.is(ForkTaskLinkRepairError);

export class ForkTaskLinkRepair extends Context.Service<
  ForkTaskLinkRepair,
  {
    readonly repair: Effect.Effect<
      { readonly repairedThreadCount: number },
      ForkTaskLinkRepairError
    >;
  }
>()("t3/orchestration-v2/legacy/ForkTaskLinkRepair") {}

/**
 * Legacy projections are the source of parentage; never reconstruct V1 events or
 * create shells here. Run after all shells are imported, before runtime recovery
 * can observe lineage (which V2 treats as immutable).
 */
export const repairForkTaskLinks = Effect.fn("repairForkTaskLinks")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSinkV2;
    const projections = yield* ProjectionStoreV2;
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly parent_thread_id: string | null;
    }>`
    SELECT thread_id, parent_thread_id FROM projection_threads
  `;
    const parents = new Map(rows.map((row) => [row.thread_id, row.parent_thread_id]));
    const roots = new Map<string, string>();
    // Validate the complete graph before committing any repair. Deleted and
    // archived parents still own their descendants and must not be filtered out.
    for (const row of rows) {
      const path = new Set<string>();
      let cursor = row.thread_id;
      while (!roots.has(cursor)) {
        if (path.has(cursor)) {
          return yield* new ForkTaskLinkRepairError({
            message: `Legacy task ancestry contains a cycle at ${cursor}.`,
          });
        }
        path.add(cursor);
        const parent = parents.get(cursor);
        if (parent === undefined) {
          return yield* new ForkTaskLinkRepairError({
            message: `Legacy task parent ${cursor} is missing.`,
          });
        }
        if (parent === null) {
          roots.set(cursor, cursor);
          break;
        }
        cursor = parent;
      }
      const root = roots.get(cursor)!;
      for (const id of path) roots.set(id, root);
    }

    let repairedThreadCount = 0;
    for (const row of rows) {
      if (row.parent_thread_id === null) continue;
      const threadId = ThreadId.make(row.thread_id);
      const commandId = CommandId.make(`${REPAIR_PREFIX}${threadId}`);
      const completed = yield* sql`
      SELECT 1 FROM orchestration_command_receipts
      WHERE command_id = ${commandId} AND command_type = ${REPAIR_COMMAND}
        AND status = 'accepted' AND result_sequence > 0
    `;
      if (completed.length > 0) continue;
      const imports = yield* sql`
      SELECT 1 FROM orchestration_v2_legacy_imports WHERE thread_id = ${threadId}
    `;
      if (imports.length === 0) {
        return yield* new ForkTaskLinkRepairError({
          message: `Legacy task ${threadId} has not been imported.`,
        });
      }
      const current = yield* projections.getThread(threadId);
      const parent = yield* projections.getThread(ThreadId.make(row.parent_thread_id));
      const rootThreadId = ThreadId.make(roots.get(row.thread_id)!);
      if (current.historyOrigin !== "v1_import" || parent.historyOrigin !== "v1_import") {
        return yield* new ForkTaskLinkRepairError({
          message: `Legacy task ${threadId} collides with a native V2 thread.`,
        });
      }
      if (
        current.lineage.parentThreadId !== null &&
        (current.lineage.parentThreadId !== parent.id ||
          current.lineage.rootThreadId !== rootThreadId ||
          current.lineage.relationshipToParent !== "subagent")
      ) {
        return yield* new ForkTaskLinkRepairError({
          message: `Legacy task ${threadId} has conflicting V2 lineage.`,
        });
      }
      const now = yield* DateTime.now;
      const result = yield* sink.commitCommand({
        commandId,
        commandType: REPAIR_COMMAND,
        threadId,
        acceptedAt: now,
        events: [
          {
            id: EventId.make(`${REPAIR_PREFIX}${threadId}`),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: current.providerInstanceId,
            occurredAt: now,
            payload: {
              ...current,
              // App-owned children remain writable; provider-native children do not.
              creationSource: "mcp",
              lineage: {
                parentThreadId: parent.id,
                relationshipToParent: "subagent",
                rootThreadId,
              },
            },
          },
        ],
        effects: [],
      });
      if (result.committed) repairedThreadCount += 1;
    }
    return { repairedThreadCount };
  },
  Effect.mapError((cause) =>
    isRepairError(cause)
      ? cause
      : new ForkTaskLinkRepairError({ message: "Failed to repair legacy task links.", cause }),
  ),
);

export const layer = Layer.effect(
  ForkTaskLinkRepair,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSinkV2;
    const projections = yield* ProjectionStoreV2;
    return ForkTaskLinkRepair.of({
      repair: repairForkTaskLinks().pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(EventSinkV2, sink),
        Effect.provideService(ProjectionStoreV2, projections),
      ),
    });
  }),
);

/** Durable receipts survive replay and compaction; a partial repair cannot pass. */
export const assertForkTaskLinksRepaired = Effect.fn("assertForkTaskLinksRepaired")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pending = yield* sql`
    SELECT 1 FROM projection_threads AS legacy
    WHERE legacy.parent_thread_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM orchestration_command_receipts AS receipt
      WHERE receipt.command_id = ${REPAIR_PREFIX} || legacy.thread_id
        AND receipt.command_type = ${REPAIR_COMMAND}
        AND receipt.aggregate_id = legacy.thread_id
        AND receipt.status = 'accepted' AND receipt.result_sequence > 0
    ) LIMIT 1
  `;
  if (pending.length > 0) {
    return yield* new ForkTaskLinkRepairError({
      message: "Fork task-link repair must finish before event compaction.",
    });
  }
});
