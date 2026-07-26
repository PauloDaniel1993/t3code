import {
  CommandId,
  ThreadId,
  ThreadTaskToolError,
  type OrchestrationThread,
  type ThreadTaskContextSpec,
  type ThreadTaskToolErrorReason,
  type ThreadTaskToolSummary,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  checkTaskCreateEligibility,
  countParentTasks,
  type ThreadTaskCreateRejection,
} from "../../../orchestration/threadTasks.ts";
import { TasksToolkit } from "./tools.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const fail = (reason: ThreadTaskToolErrorReason, message: string) =>
  Effect.fail(new ThreadTaskToolError({ reason, message }));

/** Domain rejection reasons map 1:1 onto tool error reasons the agent can act on. */
function toolReasonFor(rejection: ThreadTaskCreateRejection): ThreadTaskToolErrorReason {
  switch (rejection.reason) {
    case "parent-missing":
    case "parent-ineligible":
      return "parent-ineligible";
    case "nesting-depth":
      return "nesting-depth";
    case "concurrency-cap":
      return "concurrency-cap";
    case "lifetime-cap":
      return "lifetime-cap";
    case "invalid-context":
      return "invalid-context";
  }
}

function summarize(thread: OrchestrationThread): ThreadTaskToolSummary | null {
  const task = thread.task;
  if (task == null) return null;
  return {
    threadId: thread.id,
    title: task.title,
    status: task.status,
    createdBy: task.createdBy,
    context: task.context,
    createdAt: task.requestedAt,
    result:
      task.result === null
        ? null
        : {
            outcome: task.result.outcome,
            summary: task.result.summary,
            summaryTruncated: task.result.summaryTruncated,
            completedAt: task.result.completedAt,
          },
  };
}

/**
 * The calling thread, taken from the invocation scope. A tool argument never
 * names the parent, so an agent cannot reach another thread's tasks.
 */
const requireCallingThread = Effect.fn("TasksToolkit.requireCallingThread")(function* () {
  const scope = yield* McpInvocationContext.scopeWithCapability("tasks");
  if (scope === null) {
    return yield* fail(
      "capability-unavailable",
      "Thread tasks are not available for this provider session.",
    );
  }
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const thread = yield* projectionSnapshotQuery.getThreadDetailById(scope.threadId).pipe(
    Effect.map(Option.getOrNull),
    Effect.catch(() => fail("dispatch-failed", "Could not read the calling thread.")),
  );
  if (thread === null) {
    return yield* fail("parent-ineligible", `Thread '${scope.threadId}' could not be read.`);
  }
  return thread;
});

const listTasksOf = Effect.fn("TasksToolkit.listTasksOf")(function* (parentThreadId: ThreadId) {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const snapshot = yield* projectionSnapshotQuery
    .getShellSnapshot()
    .pipe(Effect.catch(() => fail("dispatch-failed", "Could not read this thread's tasks.")));
  return snapshot.threads.filter(
    (shell) => shell.parentThreadId === parentThreadId && shell.task != null,
  );
});

const readTaskSummary = Effect.fn("TasksToolkit.readTaskSummary")(function* (threadId: ThreadId) {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const thread = yield* projectionSnapshotQuery.getThreadDetailById(threadId).pipe(
    Effect.map(Option.getOrNull),
    Effect.catch(() => fail("dispatch-failed", "Could not read the task thread.")),
  );
  const summary = thread === null ? null : summarize(thread);
  if (summary === null) {
    return yield* fail("dispatch-failed", `Task '${threadId}' was created but could not be read.`);
  }
  return summary;
});

const handlers = {
  task_create: Effect.fn("TasksToolkit.task_create")(function* (input) {
    const parent = yield* requireCallingThread();

    if (input.context === "selected-messages" && (input.messageIds?.length ?? 0) === 0) {
      return yield* fail(
        "invalid-context",
        "context 'selected-messages' requires a non-empty messageIds list.",
      );
    }
    const context: ThreadTaskContextSpec =
      input.context === "selected-messages"
        ? { kind: "selected-messages", messageIds: input.messageIds ?? [] }
        : input.context === "full-thread"
          ? { kind: "full-thread" }
          : { kind: "none" };

    const tasks = yield* listTasksOf(parent.id);
    const rejection = checkTaskCreateEligibility({
      parent,
      parentThreadId: parent.id,
      counts: countParentTasks(
        tasks.map((shell) => ({
          id: shell.id,
          parentThreadId: shell.parentThreadId ?? null,
          task: shell.task ?? null,
          deletedAt: null,
        })),
        parent.id,
      ),
      context,
    });
    if (rejection !== null) {
      return yield* fail(toolReasonFor(rejection), rejection.detail);
    }

    const orchestrationEngine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const taskThreadId = ThreadId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const commandId = CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));

    yield* orchestrationEngine
      .dispatch({
        type: "thread.task.create",
        commandId,
        parentThreadId: parent.id,
        taskThreadId,
        title: input.title,
        prompt: input.prompt,
        context,
        ...(input.model === undefined ? {} : { modelSelection: input.model }),
        // Server-authored: only this path can claim agent authorship.
        createdBy: "agent",
        createdAt: yield* nowIso,
      })
      .pipe(
        Effect.catch((error) =>
          fail(
            "dispatch-failed",
            `Could not create the task: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      );

    return yield* readTaskSummary(taskThreadId);
  }),

  task_list: Effect.fn("TasksToolkit.task_list")(function* (input) {
    const parent = yield* requireCallingThread();
    const tasks = yield* listTasksOf(parent.id);
    return {
      tasks: tasks.flatMap((shell) => {
        const task = shell.task;
        if (task == null) return [];
        if (input.status !== undefined && task.status !== input.status) return [];
        return [
          {
            threadId: shell.id,
            title: task.title,
            status: task.status,
            createdBy: task.createdBy,
            context: task.context,
            createdAt: task.requestedAt,
            result:
              task.result === null
                ? null
                : {
                    outcome: task.result.outcome,
                    summary: task.result.summary,
                    summaryTruncated: task.result.summaryTruncated,
                    completedAt: task.result.completedAt,
                  },
          },
        ];
      }),
    };
  }),

  task_cancel: Effect.fn("TasksToolkit.task_cancel")(function* (input) {
    const parent = yield* requireCallingThread();
    const taskThreadId = ThreadId.make(input.threadId);
    const tasks = yield* listTasksOf(parent.id);
    const target = tasks.find((shell) => shell.id === taskThreadId);
    if (target === undefined) {
      return yield* fail("task-not-found", `Task '${taskThreadId}' is not owned by this thread.`);
    }

    const orchestrationEngine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    yield* orchestrationEngine
      .dispatch({
        type: "thread.task.cancel",
        commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
        parentThreadId: parent.id,
        taskThreadId,
        createdAt: yield* nowIso,
      })
      .pipe(Effect.catch(() => fail("dispatch-failed", "Could not cancel the task.")));

    return yield* readTaskSummary(taskThreadId);
  }),
} satisfies Parameters<typeof TasksToolkit.toLayer>[0];

export const TasksToolkitHandlersLive = TasksToolkit.toLayer(handlers);
