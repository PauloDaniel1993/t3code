import {
  EventId,
  NodeId,
  ProviderDriverKind,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { recordForkImportWarning } from "../../persistence/ForkImportDiagnostics.ts";
import { forkLegacyMessageRoles } from "./ForkLegacyMessages.ts";

const LegacyTask = Schema.Struct({
  title: Schema.String,
  prompt: Schema.String,
  createdBy: Schema.Literals(["user", "agent"]),
  status: Schema.Literals(["queued", "running", "finished", "failed", "cancelled"]),
  requestedAt: Schema.DateTimeUtcFromString,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  finishedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  result: Schema.NullOr(
    Schema.Struct({ summary: Schema.String, completedAt: Schema.DateTimeUtcFromString }),
  ),
  delivery: Schema.NullOr(
    Schema.Struct({
      state: Schema.Literals(["pending", "delivered", "skipped"]),
      // When the result reached the parent. Kept loose so a bad value loses only this time.
      updatedAt: Schema.optional(Schema.String),
    }),
  ),
});
const decodeTask = Schema.decodeUnknownOption(Schema.fromJsonString(LegacyTask));

/**
 * Native subagent/node/timeline records, with no invented run or pending delivery.
 * task_summary_json is a parent aggregate; derive each task from task_json instead
 * of assigning the parent's latest delivery time to every child. A delivered
 * task's own delivery time becomes `deliveredAt`, the watermark V2 stamps when a
 * provider accepts a result; the sidebar compares it with the parent's visits.
 */
export const forkLegacyTaskEvents = Effect.fn("forkLegacyTaskEvents")(function* (
  child: OrchestrationV2AppThread,
  parent: OrchestrationV2AppThread,
  raw: string | null,
  driver: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const decoded = decodeTask(raw);
  if (Option.isNone(decoded)) {
    yield* recordForkImportWarning(
      child.id,
      "task_json",
      "Missing or invalid task metadata; imported as cancelled with available thread metadata.",
      raw,
    );
  }
  const legacy = Option.getOrUndefined(decoded);
  const id = NodeId.make(`migration:fork:task:${child.id}`);
  const parentNodeId = NodeId.make(`migration:fork:task-root:${parent.id}`);
  const status =
    legacy?.status === "finished"
      ? "completed"
      : legacy?.status === "failed"
        ? "failed"
        : "cancelled";
  const updatedAt = legacy?.finishedAt ?? legacy?.result?.completedAt ?? child.updatedAt;
  const delivered = legacy?.delivery?.state === "delivered";
  const deliveredAt = delivered
    ? DateTime.make(legacy?.delivery?.updatedAt ?? "").pipe(Option.map(DateTime.formatIso))
    : Option.none();
  const task: OrchestrationV2Subagent = {
    id,
    threadId: parent.id,
    runId: null,
    parentNodeId,
    origin: "app_owned",
    createdBy: legacy?.createdBy ?? "system",
    driver: ProviderDriverKind.make(driver ?? child.providerInstanceId),
    providerInstanceId: child.providerInstanceId,
    providerThreadId: null,
    childThreadId: child.id,
    nativeTaskRef: null,
    prompt: legacy?.prompt ?? "",
    title: legacy?.title ?? child.title,
    model: child.modelSelection.model,
    status,
    result: legacy?.result?.summary ?? null,
    startedAt: legacy?.startedAt ?? legacy?.requestedAt ?? child.createdAt,
    completedAt: updatedAt,
    updatedAt,
    completionDelivery: {
      state: delivered ? "delivered" : "disposed",
      observedByRunId: null,
      ...(Option.isSome(deliveredAt) ? { deliveredAt: deliveredAt.value } : {}),
    },
  };
  const events: OrchestrationV2DomainEvent[] = [];
  const root =
    yield* sql`SELECT 1 FROM orchestration_v2_projection_nodes WHERE node_id = ${parentNodeId}`;
  const nodeBase = {
    threadId: parent.id,
    runId: null,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
  };
  if (root.length === 0)
    events.push({
      id: EventId.make(parentNodeId),
      type: "node.updated",
      threadId: parent.id,
      occurredAt: updatedAt,
      payload: {
        ...nodeBase,
        id: parentNodeId,
        rootNodeId: parentNodeId,
        parentNodeId: null,
        kind: "system",
        status: "completed",
      },
    });
  events.push(
    {
      id: EventId.make(`${id}:node`),
      type: "node.updated",
      threadId: parent.id,
      occurredAt: updatedAt,
      payload: {
        ...nodeBase,
        id,
        parentNodeId,
        rootNodeId: parentNodeId,
        kind: "subagent",
        status,
      },
    },
    {
      id: EventId.make(`${id}:record`),
      type: "subagent.updated",
      threadId: parent.id,
      nodeId: id,
      occurredAt: updatedAt,
      payload: task,
    },
  );
  // Shell previews reserve only a few positions. Place task items after the FULL
  // legacy transcript so later background hydration can fill its original slots.
  const positions = yield* sql<{ ordinal: number }>`SELECT MAX(
    (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = ${parent.id} AND ${sql.in("role", forkLegacyMessageRoles)}),
    COALESCE((SELECT MAX(ordinal) FROM orchestration_v2_turn_item_positions WHERE thread_id = ${parent.id} AND ordinal < 1000000), 0)
  ) + 1 AS ordinal`;
  events.push({
    id: EventId.make(`${id}:item`),
    type: "turn-item.updated",
    threadId: parent.id,
    nodeId: id,
    occurredAt: updatedAt,
    payload: {
      id: TurnItemId.make(`${id}:item`),
      threadId: parent.id,
      runId: null,
      nodeId: id,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: positions[0]!.ordinal,
      status,
      title: task.title,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      updatedAt,
      type: "subagent",
      subagentId: id,
      origin: "app_owned",
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      childThreadId: child.id,
      prompt: task.prompt,
      result: task.result,
    },
  });
  return events;
});
