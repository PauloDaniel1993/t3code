import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadId,
  type ThreadTaskDelivery,
  type ThreadTaskDeliverySkipReason,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadTaskReactor, type ThreadTaskReactorShape } from "../Services/ThreadTaskReactor.ts";
import {
  boundTaskResultSummary,
  buildTaskWakeMessageText,
  taskIsArmed,
  taskOutcomeForTurnState,
  taskThreadIsSettled,
} from "../threadTasks.ts";

/**
 * Events that can move a task thread into or out of settlement, or that leave a
 * delivery outstanding. Anything else is ignored so the reactor does not
 * re-read the projection on every provider delta.
 */
const TRIGGER_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.session-set",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  "thread.activity-upserted",
  "thread.task-created",
  "thread.task-updated",
  "thread.task-finished",
  "thread.archived",
  "thread.deleted",
]);

/**
 * Mirrors the decider's open-request scan: a turn that ended while an approval
 * or user-input request is still open is not finished work, so the task must
 * not report back yet.
 */
function hasOpenBlockingRequest(thread: OrchestrationThread): boolean {
  const openRequestIds = new Set<string>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size > 0;
}

/** The task's final assistant output, which becomes the delivered summary. */
function latestAssistantMessage(thread: OrchestrationThread) {
  let latest: OrchestrationThread["messages"][number] | null = null;
  for (const message of thread.messages) {
    if (message.role !== "assistant" || message.streaming) continue;
    if (latest === null || message.createdAt >= latest.createdAt) {
      latest = message;
    }
  }
  return latest;
}

/** The provider failure detail to report when a task's turn ended in error. */
function latestFailureDetail(thread: OrchestrationThread): string {
  for (const activity of [...thread.activities].reverse()) {
    if (activity.tone !== "error") continue;
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail = typeof payload?.detail === "string" ? payload.detail : null;
    return detail ?? activity.summary;
  }
  return "The task ended with an error and produced no output.";
}

/**
 * One evaluation pass for a task thread.
 *
 * Split out from the reactor's event plumbing so the settlement and delivery
 * rules can be driven directly, without racing an event stream to observe them.
 */
export const makeThreadTaskEvaluator = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const newCommandId = Effect.map(crypto.randomUUIDv4, CommandId.make);
  const newMessageId = Effect.map(crypto.randomUUIDv4, MessageId.make);

  const readThread = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrNull));

  /**
   * Record a settled task's result. Runs before any delivery attempt so the
   * result is durable: a crash between here and the parent wake-up retries only
   * the delivery, and the decider rejects a second recording.
   */
  const recordTaskResult = Effect.fn("recordTaskResult")(function* (thread: OrchestrationThread) {
    const task = thread.task;
    if (task == null || thread.latestTurn === null) return;

    const outcome = taskOutcomeForTurnState(thread.latestTurn.state);
    const assistantMessage = latestAssistantMessage(thread);
    const rawSummary =
      outcome === "failed"
        ? latestFailureDetail(thread)
        : (assistantMessage?.text ?? "The task finished without producing any output.");
    const bounded = boundTaskResultSummary(rawSummary);

    yield* orchestrationEngine.dispatch({
      type: "thread.task.finish",
      commandId: yield* newCommandId,
      parentThreadId: task.parentThreadId,
      taskThreadId: thread.id,
      status: outcome === "failed" ? "failed" : outcome === "cancelled" ? "cancelled" : "finished",
      result: {
        outcome,
        summary: bounded.summary,
        summaryTruncated: bounded.summaryTruncated,
        assistantMessageId: assistantMessage?.id ?? null,
        completedAt: thread.latestTurn.completedAt ?? (yield* nowIso),
      },
      createdAt: yield* nowIso,
    });
  });

  const setDelivery = Effect.fn("setDelivery")(function* (input: {
    readonly parentThreadId: ThreadId;
    readonly taskThreadId: ThreadId;
    readonly delivery: ThreadTaskDelivery;
  }) {
    return yield* orchestrationEngine.dispatch({
      type: "thread.task.delivery.set",
      commandId: yield* newCommandId,
      parentThreadId: input.parentThreadId,
      taskThreadId: input.taskThreadId,
      delivery: input.delivery,
      createdAt: yield* nowIso,
    });
  });

  const skipDelivery = Effect.fn("skipDelivery")(function* (input: {
    readonly parentThreadId: ThreadId;
    readonly taskThreadId: ThreadId;
    readonly reason: ThreadTaskDeliverySkipReason;
  }) {
    return yield* setDelivery({
      parentThreadId: input.parentThreadId,
      taskThreadId: input.taskThreadId,
      delivery: { state: "skipped", reason: input.reason, updatedAt: yield* nowIso },
    });
  });

  /**
   * Wake the parent with the task's result.
   *
   * This is an ordinary turn start, which is the whole point: it starts a parent
   * session that was never started, resumes a stopped one from its persisted
   * cursor, or steers a running turn — all through the existing provider path.
   * It also clears the parent's settle/snooze overrides for free, because the
   * decider treats a user message as activity.
   */
  const deliverResult = Effect.fn("deliverResult")(function* (taskThread: OrchestrationThread) {
    const task = taskThread.task;
    if (task == null || task.result === null) return;

    const parent = yield* readThread(task.parentThreadId);
    if (parent === null) {
      return yield* skipDelivery({
        parentThreadId: task.parentThreadId,
        taskThreadId: taskThread.id,
        reason: "parent-missing",
      });
    }
    if (parent.deletedAt !== null) {
      return yield* skipDelivery({
        parentThreadId: task.parentThreadId,
        taskThreadId: taskThread.id,
        reason: "parent-deleted",
      });
    }
    if (parent.archivedAt !== null) {
      return yield* skipDelivery({
        parentThreadId: task.parentThreadId,
        taskThreadId: taskThread.id,
        reason: "parent-archived",
      });
    }
    if (taskThread.deletedAt !== null) {
      return yield* skipDelivery({
        parentThreadId: task.parentThreadId,
        taskThreadId: taskThread.id,
        reason: "task-deleted",
      });
    }
    if (taskThread.archivedAt !== null) {
      return yield* skipDelivery({
        parentThreadId: task.parentThreadId,
        taskThreadId: taskThread.id,
        reason: "task-archived",
      });
    }

    const messageId = yield* newMessageId;
    const createdAt = yield* nowIso;
    const dispatched = yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: yield* newCommandId,
        threadId: task.parentThreadId,
        message: {
          messageId,
          role: "user",
          text: buildTaskWakeMessageText({
            title: task.title,
            prompt: task.prompt,
            outcome: task.result.outcome,
            summary: task.result.summary,
            summaryTruncated: task.result.summaryTruncated,
            taskThreadId: taskThread.id,
          }),
          attachments: [],
          // Marks the message as a wake-up rather than something the user
          // typed, so the timeline renders it as a task lifecycle row.
          source: "task-result",
        },
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
        createdAt,
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("thread task reactor failed to wake parent thread", {
            taskThreadId: taskThread.id,
            parentThreadId: task.parentThreadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );

    if (!dispatched) {
      return yield* skipDelivery({
        parentThreadId: task.parentThreadId,
        taskThreadId: taskThread.id,
        reason: "dispatch-failed",
      });
    }

    yield* setDelivery({
      parentThreadId: task.parentThreadId,
      taskThreadId: taskThread.id,
      delivery: { state: "delivered", parentMessageId: messageId, updatedAt: createdAt },
    });
  });

  /**
   * One evaluation pass for a task thread: record a result if it just settled,
   * then deliver any outstanding result. Both steps are idempotent, so a
   * duplicate trigger is harmless.
   */
  const evaluateTaskThread = Effect.fn("evaluateTaskThread")(function* (threadId: ThreadId) {
    const thread = yield* readThread(threadId);
    if (thread === null || thread.task == null) return;

    if (
      taskIsArmed(thread.task) &&
      taskThreadIsSettled({
        latestTurn: thread.latestTurn,
        session: thread.session,
        hasOpenBlockingRequest: hasOpenBlockingRequest(thread),
      })
    ) {
      yield* recordTaskResult(thread);
      const recorded = yield* readThread(threadId);
      if (recorded !== null && recorded.task?.delivery?.state === "pending") {
        yield* deliverResult(recorded);
      }
      return;
    }

    // Outstanding delivery from a previous pass (or a restart, or an explicit
    // re-delivery request).
    if (thread.task.result !== null && thread.task.delivery?.state === "pending") {
      yield* deliverResult(thread);
    }
  });

  return { evaluateTaskThread };
});

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const { evaluateTaskThread } = yield* makeThreadTaskEvaluator;

  const evaluateSafely = (threadId: ThreadId) =>
    evaluateTaskThread(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread task reactor failed to evaluate task thread", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(evaluateSafely);

  /**
   * Retry deliveries left pending by a shutdown between recording and wake-up.
   */
  const resumePendingDeliveries = Effect.fn("resumePendingDeliveries")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    for (const shell of snapshot.threads) {
      if (shell.task?.result != null && shell.task.delivery?.state === "pending") {
        yield* worker.enqueue(shell.id);
      }
    }
  });

  const start: ThreadTaskReactorShape["start"] = Effect.fn("start")(function* () {
    yield* resumePendingDeliveries().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("thread task reactor failed to resume pending deliveries", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (!TRIGGER_EVENT_TYPES.has(event.type) || event.aggregateKind !== "thread") {
          return Effect.void;
        }
        return worker.enqueue(event.aggregateId as ThreadId);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadTaskReactorShape;
});

export const ThreadTaskReactorLive = Layer.effect(ThreadTaskReactor, make);
