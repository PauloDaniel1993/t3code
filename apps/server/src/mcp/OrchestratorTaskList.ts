import {
  OrchestratorMcpFailure,
  type NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpTaskListInput,
  type OrchestratorMcpTaskListResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export type TaskParentProjection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "subagents" | "contextTransfers"
>;

/** Lists direct app-owned children using the same result reader as task_status, without acknowledging delivery. */
export const listOwnedTasks = Effect.fn("OrchestratorTaskList.listOwnedTasks")(function* (
  threadId: ThreadId,
  input: OrchestratorMcpTaskListInput,
  parent: TaskParentProjection,
  readTask: (
    taskId: NodeId,
    parent: TaskParentProjection,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>,
) {
  const owned = parent.subagents
    .filter(
      (task) =>
        task.origin === "app_owned" && task.threadId === threadId && task.childThreadId !== null,
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const cursorIndex =
    input.cursor === undefined ? -1 : owned.findIndex((task) => task.id === input.cursor);
  if (input.cursor !== undefined && cursorIndex === -1) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "Task-list cursor does not identify a task owned by this thread. Restart task_list without a cursor.",
    });
  }
  const offset = cursorIndex + 1;
  const page = owned.slice(offset, offset + (input.limit ?? 50));
  const tasks = yield* Effect.forEach(page, (task) =>
    readTask(task.id, parent).pipe(Effect.map((status) => ({ ...status, title: task.title }))),
  );
  return {
    parentThreadId: threadId,
    tasks,
    nextCursor: offset + page.length < owned.length ? (page.at(-1)?.id ?? null) : null,
  } satisfies OrchestratorMcpTaskListResult;
});
