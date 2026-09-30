import {
  CommandId,
  isProviderNativeSubagentThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { OrchestrationEffectRequestV2, PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import type { IdAllocatorV2 } from "./IdAllocator.ts";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { planThreadDeletion } from "./ThreadDeletion.ts";

type Plan = {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
  readonly cancelUnsettledEffects?: {
    readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
    readonly reason: string;
  };
};

/** Plan children before their parent; the existing command sink commits the whole cascade atomically. */
export function withTaskThreadLifecycle<E, R>(
  command: OrchestrationV2ServerCommand,
  projectionStore: ProjectionStoreV2["Service"],
  idAllocator: IdAllocatorV2["Service"],
  plan: (command: OrchestrationV2ServerCommand) => Effect.Effect<Plan, E, R>,
) {
  return Effect.fnUntraced(function* (parentPlan: Plan) {
    // Upstream has already validated the parent before any child effects are planned.
    if (
      command.type !== "thread.archive" &&
      command.type !== "thread.unarchive" &&
      command.type !== "thread.delete"
    )
      return parentPlan;
    const snapshot = yield* projectionStore.getShellSnapshot();
    const children = [...snapshot.threads, ...snapshot.archivedThreads].filter(
      (thread) =>
        thread.lineage.parentThreadId === command.threadId &&
        thread.lineage.relationshipToParent === "subagent" &&
        !isProviderNativeSubagentThread(thread) &&
        (command.type === "thread.delete" ||
          (command.type === "thread.archive"
            ? thread.archivedAt === null
            : thread.archivedAt !== null)),
    );
    if (children.length === 0) return parentPlan;
    const events: OrchestrationV2DomainEvent[] = [];
    const effects: PendingOrchestrationEffectV2[] = [];
    for (const child of children) {
      const childCommand = {
        ...command,
        threadId: child.id,
        commandId: CommandId.make(`${command.commandId}:task:${child.id}`),
      };
      if (command.type === "thread.archive") {
        const projection = yield* projectionStore.getThreadRecords(child.id, [
          "runs",
          "attempts",
          "nodes",
          "runtimeRequests",
          "subagents",
          "providerSessions",
        ]);
        // Reuse upstream's durable cancellation plan; retain attachments and the thread.
        const cancellation = yield* planThreadDeletion({
          command: { type: "thread.delete", commandId: childCommand.commandId, threadId: child.id },
          projection,
          attachmentIds: [],
          now: yield* DateTime.now,
          idAllocator,
        });
        events.push(
          ...cancellation.events.filter(
            (event) =>
              event.type === "run.updated" ||
              event.type === "run-attempt.updated" ||
              event.type === "node.updated",
          ),
        );
        for (const event of cancellation.events) {
          if (event.type === "runtime-request.updated")
            events.push({
              ...event,
              payload: {
                ...event.payload,
                responseCapability: {
                  type: "not_resumable",
                  reason: "The task was archived with its parent.",
                },
              },
            });
        }
      }
      const childPlan = yield* plan(childCommand);
      events.push(...childPlan.events);
      effects.push(...childPlan.effects);
    }
    events.push(...parentPlan.events);
    effects.push(...parentPlan.effects);
    if (command.type === "thread.archive") {
      const parent = yield* projectionStore.getThreadRecords(command.threadId, ["subagents"]);
      const childIds = new Set(children.map((child) => child.id));
      const now = yield* DateTime.now;
      for (const task of parent.subagents) {
        if (
          task.origin !== "app_owned" ||
          task.childThreadId === null ||
          !childIds.has(task.childThreadId) ||
          !["pending", "running", "waiting"].includes(task.status)
        )
          continue;
        events.push({
          id: yield* idAllocator.allocate.event({
            threadId: command.threadId,
            commandId: command.commandId,
          }),
          type: "subagent.updated",
          threadId: command.threadId,
          nodeId: task.id,
          ...(task.runId === null ? {} : { runId: task.runId }),
          driver: task.driver,
          providerInstanceId: task.providerInstanceId,
          occurredAt: now,
          payload: {
            ...task,
            status: "cancelled",
            completedAt: now,
            updatedAt: now,
            completionDelivery: {
              ...task.completionDelivery,
              state: "disposed",
              observedByRunId: null,
            },
          },
        });
      }
    }
    return { ...parentPlan, events, effects };
  });
}
