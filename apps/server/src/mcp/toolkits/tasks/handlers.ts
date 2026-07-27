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
import { ThreadTaskLimitsSource } from "../../../orchestration/threadTaskLimits.ts";
import {
  checkTaskCreateEligibility,
  countParentTasks,
  type ThreadTaskCreateRejection,
} from "../../../orchestration/threadTasks.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { buildTaskModelCatalog, resolveTaskModelSelection } from "./reasoning.ts";
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

/**
 * A task asking for a task of its own is the one rejection where the agent has
 * a real move left, so the message spells it out. Delegation stays one level
 * deep — the thread that owns the task is the only one that can widen the
 * fan-out, and it can only do that if the task hands it something it can act
 * on without a follow-up round trip.
 */
export const NESTED_TASK_MESSAGE =
  "This thread is itself a task, and a task cannot create tasks. Ask the thread that owns you to create it: end your turn with the request, giving the title, the complete self-contained prompt to run, the context it needs ('full-thread', specific message ids, or 'none'), and the model or reasoning level if it should differ from yours. Your result is delivered to that thread automatically, so a well-formed request there is all it takes.";

function rejectionMessage(rejection: ThreadTaskCreateRejection): string {
  return rejection.reason === "nesting-depth" ? NESTED_TASK_MESSAGE : rejection.detail;
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
    // The decider re-checks this. Doing it here first is what turns a cap into
    // a structured `concurrency-cap` the agent can wait out, rather than an
    // opaque dispatch failure.
    const limits = yield* yield* ThreadTaskLimitsSource;
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
      limits,
    });
    if (rejection !== null) {
      return yield* fail(toolReasonFor(rejection), rejectionMessage(rejection));
    }

    // A reasoning level only means something against the model that will run
    // the task, so resolve the two together — including the case where the
    // agent set a level but let the task inherit this thread's model.
    const providerRegistry = yield* ProviderRegistry;
    const providers = yield* providerRegistry.getProviders;
    const resolvedModel = resolveTaskModelSelection({
      providers,
      parentSelection: parent.modelSelection,
      override: input.model,
      reasoning: input.reasoning,
    });
    if (!resolvedModel.ok) {
      return yield* fail("invalid-model", resolvedModel.message);
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
        ...(resolvedModel.modelSelection === undefined
          ? {}
          : { modelSelection: resolvedModel.modelSelection }),
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

  task_models: Effect.fn("TasksToolkit.task_models")(function* (input) {
    // The calling thread's own selection is part of the answer: it is what a
    // task inherits, so an agent can see whether naming a model changes
    // anything before it names one.
    const caller = yield* requireCallingThread();
    const providerRegistry = yield* ProviderRegistry;
    const providers = yield* providerRegistry.getProviders;
    const catalog = buildTaskModelCatalog({
      providers,
      current: caller.modelSelection,
      instanceId: input.instanceId,
    });
    if (!catalog.ok) {
      return yield* fail("invalid-model", catalog.message);
    }
    return catalog.catalog;
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
