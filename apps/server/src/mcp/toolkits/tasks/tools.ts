import {
  TaskCancelToolInput,
  TaskCreateToolInput,
  TaskListToolInput,
  TaskListToolOutput,
  ThreadTaskToolError,
  ThreadTaskToolSummary,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
  Crypto.Crypto,
];

export const TaskCreateTool = Tool.make("task_create", {
  description:
    "Delegate work to a task: a full thread owned by this one, running its own provider session. Returns immediately — the task's result is delivered back into this thread automatically when it finishes, waking this thread if it has gone idle. Choose context: 'full-thread' passes this conversation, 'selected-messages' passes only the message ids you list, 'none' passes just the prompt. Write the prompt as a complete, self-contained brief.",
  parameters: TaskCreateToolInput,
  success: ThreadTaskToolSummary,
  failure: ThreadTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const TaskListTool = Tool.make("task_list", {
  description:
    "List the tasks this thread owns, with their status and — once finished — the result that was returned. Use this to check whether delegated work is still running before deciding to wait or proceed.",
  parameters: TaskListToolInput,
  success: TaskListToolOutput,
  failure: ThreadTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "List tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const TaskCancelTool = Tool.make("task_cancel", {
  description:
    "Cancel a task this thread owns, interrupting its turn. Cancelling an already-finished task succeeds and changes nothing.",
  parameters: TaskCancelToolInput,
  success: ThreadTaskToolSummary,
  failure: ThreadTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Cancel task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const TasksToolkit = Toolkit.make(TaskCreateTool, TaskListTool, TaskCancelTool);
