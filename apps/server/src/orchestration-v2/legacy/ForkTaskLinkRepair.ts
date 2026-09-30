import { CommandId, EventId, ThreadId, type OrchestrationV2AppThread } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlError } from "effect/unstable/sql/SqlError";

import { EventSinkV2 } from "../EventSink.ts";
import { ProjectionStoreV2, type ProjectionStoreV2Error } from "../ProjectionStore.ts";
import {
  clearForkImportWarning,
  recordForkImportWarning,
} from "../../persistence/ForkImportDiagnostics.ts";
import { forkLegacyTaskEvents } from "./ForkLegacyTasks.ts";

const REPAIR_PREFIX = "migration:fork:task-links:v2:";
/** Its durable receipts are one of the writes the import check looks for. */
export const REPAIR_COMMAND = "fork.legacy-task-links.repair-v2";

export class ForkTaskLinkRepairError extends Schema.TaggedError<ForkTaskLinkRepairError>()(
  "ForkTaskLinkRepairError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const isRepairError = Schema.is(ForkTaskLinkRepairError);

/**
 * A missing or undecodable shell stays missing on every start, so it becomes a
 * warning. A database error may pass, so it fails the phase for the next start.
 */
const readShell = (read: Effect.Effect<OrchestrationV2AppThread, ProjectionStoreV2Error>) =>
  read.pipe(
    Effect.catch((error) =>
      error._tag === "ProjectionStoreReadError" && isSqlError(error.cause)
        ? Effect.fail(error)
        : Effect.succeed(undefined),
    ),
  );

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
      readonly task_json: string | null;
      readonly provider_name: string | null;
    }>`
    SELECT thread.thread_id, thread.parent_thread_id, thread.task_json, session.provider_name
    FROM projection_threads AS thread
    LEFT JOIN projection_thread_sessions AS session ON session.thread_id = thread.thread_id
    ORDER BY thread.thread_id
  `;
    const parents = new Map(rows.map((row) => [row.thread_id, row.parent_thread_id]));
    const skipped = new Map<string, string>();
    for (const row of rows) {
      if (row.parent_thread_id !== null && !parents.has(row.parent_thread_id)) {
        parents.set(row.thread_id, null);
        skipped.set(
          row.thread_id,
          `missing parent ${row.parent_thread_id}; kept as a top-level thread.`,
        );
      }
    }
    const visited = new Set<string>();
    for (const row of rows) {
      const path: string[] = [];
      const offsets = new Map<string, number>();
      let cursor: string | null = row.thread_id;
      while (cursor !== null && !visited.has(cursor)) {
        const offset = offsets.get(cursor);
        if (offset !== undefined) {
          const cycle = path.slice(offset).sort();
          const cut = cycle[0]!;
          parents.set(cut, null);
          skipped.set(
            cut,
            `parent cycle (${cycle.join(", ")}); deterministically removed the smallest thread id's edge and kept it top-level.`,
          );
          break;
        }
        offsets.set(cursor, path.length);
        path.push(cursor);
        cursor = parents.get(cursor) ?? null;
      }
      for (const id of path) visited.add(id);
    }
    const roots = new Map<string, string>();
    // Compute roots after dropping only invalid edges. Archived/deleted parents
    // remain valid owners; descendants of a cut edge inherit its new root.
    for (const row of rows) {
      const path = new Set<string>();
      let cursor = row.thread_id;
      while (!roots.has(cursor)) {
        path.add(cursor);
        const parent = parents.get(cursor);
        if (parent === null || parent === undefined) {
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
      const skip = (reason: string) =>
        recordForkImportWarning(row.thread_id, "parent_thread_id", reason, row.parent_thread_id);
      const invalid = skipped.get(row.thread_id);
      if (invalid !== undefined) {
        yield* skip(invalid);
        continue;
      }
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
        yield* skip(`Legacy task ${threadId} has no import marker; no V2 record was changed.`);
        continue;
      }
      const current = yield* readShell(projections.getThread(threadId));
      const parent = yield* readShell(projections.getThread(ThreadId.make(row.parent_thread_id)));
      if (current === undefined || parent === undefined) {
        yield* skip("Missing or unreadable imported shell; kept available threads top-level.");
        continue;
      }
      const rootThreadId = ThreadId.make(roots.get(row.thread_id)!);
      if (current.historyOrigin !== "v1_import" || parent.historyOrigin !== "v1_import") {
        yield* skip(
          `Legacy task ${threadId} collides with a native V2 thread; no V2 record was changed.`,
        );
        continue;
      }
      if (
        current.lineage.parentThreadId !== null &&
        (current.lineage.parentThreadId !== parent.id ||
          current.lineage.rootThreadId !== rootThreadId ||
          current.lineage.relationshipToParent !== "subagent")
      ) {
        yield* skip(
          `Legacy task ${threadId} has conflicting V2 lineage; no V2 record was changed.`,
        );
        continue;
      }
      const now = yield* DateTime.now;
      const taskEvents = yield* forkLegacyTaskEvents(
        current,
        parent,
        row.task_json,
        row.provider_name,
      );
      // A warning from an earlier start (such as a shell imported only later)
      // would otherwise outlive this repair and mislead the compaction gate.
      const commit = sink.commitCommand({
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
          ...taskEvents,
        ],
        effects: [],
      });
      const result = yield* sql.withTransaction(
        clearForkImportWarning(threadId, "parent_thread_id").pipe(Effect.andThen(commit)),
      );
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
    ) AND NOT EXISTS (
      SELECT 1 FROM fork_v1_import_warnings AS warning
      WHERE warning.entity_id = legacy.thread_id AND warning.field = 'parent_thread_id'
    ) LIMIT 1
  `;
  if (pending.length > 0) {
    return yield* new ForkTaskLinkRepairError({
      message: "Fork task-link repair must finish before event compaction.",
    });
  }
});
