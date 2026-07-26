import {
  TaskCancelToolInput,
  TaskCreateToolInput,
  TaskListToolInput,
  TaskListToolOutput,
  TaskModelsToolInput,
  TaskModelsToolOutput,
  ThreadTaskToolError,
  ThreadTaskToolSummary,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
  // Reasoning levels are per-model and live in the provider snapshot, so
  // `task_create` validates one against the model it targets.
  ProviderRegistry,
  Crypto.Crypto,
];

export const TaskCreateTool = Tool.make("task_create", {
  description:
    "Delegate work to a task: a full thread owned by this one, running its own provider session. Returns immediately — the task's result is delivered back into this thread automatically when it finishes, waking this thread if it has gone idle. " +
    "Choose context: 'full-thread' passes this conversation, 'selected-messages' passes only the message ids you list, 'none' passes just the prompt. The task cannot ask you questions once it starts, so write the prompt as a complete, self-contained brief that states what to do and what to report back. " +
    "Pass 'model' to run the task on a different provider instance or model and 'reasoning' to set how hard it thinks; either can be set on its own, and both default to this thread's. Call task_models first for the instance ids, model slugs and reasoning levels this machine actually has — they differ per provider, and some models have no reasoning level at all. " +
    "A task cannot create tasks: only a top-level thread can, so delegation stays one level deep. If you are yourself a task this call is rejected — put the work you want delegated in your own result instead, naming the title, the complete self-contained prompt, the context it needs and the model or reasoning level if it should differ, so the thread that owns you can create it for you.",
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
    "List the tasks this thread owns, with their status and — once finished — the result that was returned. Use this to check whether delegated work is still running before deciding to wait or proceed. Pass a status to list only tasks in that state.",
  parameters: TaskListToolInput,
  success: TaskListToolOutput,
  failure: ThreadTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "List tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const TaskModelsTool = Tool.make("task_models", {
  description:
    "List the provider instances and models a task can run on, with the reasoning levels each model accepts. Call this before passing 'model' or 'reasoning' to task_create: instance ids and model slugs are per-machine, reasoning levels differ per provider and per model — 'effort' on Claude, 'reasoningEffort' on Codex — and some models expose none, so guessing gets the call rejected. " +
    "Also returns what this thread currently runs on, which is what a task inherits when you set neither. A level marked promptInjected is applied by prefixing the task's prompt rather than by configuring the session. Instances marked not ready are configured but currently unusable; a task started on one fails.",
  parameters: TaskModelsToolInput,
  success: TaskModelsToolOutput,
  failure: ThreadTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "List task models")
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

export const TasksToolkit = Toolkit.make(
  TaskCreateTool,
  TaskListTool,
  TaskModelsTool,
  TaskCancelTool,
);
