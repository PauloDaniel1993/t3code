import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import {
  isProviderNativeSubagentThread,
  type CommandId,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpDelegateTaskInput,
  type ServerProvider,
} from "@t3tools/contracts";

export const TASK_PROMPT_MAX_LENGTH = 120_000;
export const TASK_TITLE_MAX_LENGTH = 512;

export interface NewThreadTaskDraft {
  readonly title: string;
  readonly prompt: string;
}

export function deriveTaskTitle(draft: NewThreadTaskDraft): string {
  return draft.title.trim() || draft.prompt.trim().split(/\r?\n/, 1)[0]!.slice(0, 80);
}

export function validateNewThreadTaskDraft(draft: NewThreadTaskDraft): string | null {
  if (!draft.prompt.trim()) return "Describe what the task should do.";
  if (draft.prompt.trim().length > TASK_PROMPT_MAX_LENGTH) {
    return "The task prompt must be at most 120,000 characters.";
  }
  if (draft.title.trim().length > TASK_TITLE_MAX_LENGTH) {
    return "The task title must be at most 512 characters.";
  }
  return null;
}

type ProviderAvailability = Pick<
  ServerProvider,
  "instanceId" | "enabled" | "status" | "availability"
>;

export function getNewThreadTaskUnavailableReason(input: {
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly status: EnvironmentThreadStatus;
  readonly connected: boolean;
  readonly providers: ReadonlyArray<ProviderAvailability>;
}): string | null {
  if (!input.connected) return "Connect to this thread's environment to request a task.";
  if (input.status !== "live" || input.projection === null) return "Wait for the thread to load.";
  const { thread, runtimeRequests } = input.projection;
  if (thread.deletedAt !== null || thread.archivedAt !== null) {
    return "Reopen this thread to request a task.";
  }
  if (isProviderNativeSubagentThread(thread)) {
    return "Provider-managed agents cannot receive task requests.";
  }
  if (runtimeRequests.some((request) => request.status === "pending")) {
    return "Resolve this thread's pending request before requesting a task.";
  }
  const provider = input.providers.find(
    (entry) => entry.instanceId === thread.modelSelection.instanceId,
  );
  if (
    !provider?.enabled ||
    provider.status !== "ready" ||
    provider.availability === "unavailable"
  ) {
    return "This thread's provider must be available to request a task.";
  }
  return null;
}

/** The child settings belong in the instruction; the parent keeps its own provider and permissions. */
export function buildDelegationTurnInput(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly draft: NewThreadTaskDraft;
  readonly childModelSelection: ModelSelection;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly createdAt: string;
}): StartThreadTurnInput {
  const problem = validateNewThreadTaskDraft(input.draft);
  if (problem !== null) throw new Error(problem);
  const request = {
    task: input.draft.prompt.trim(),
    title: deriveTaskTitle(input.draft),
    target: {
      providerInstanceId: input.childModelSelection.instanceId,
      model: input.childModelSelection.model,
      // An explicit empty list also clears inherited options after changing models.
      options: input.childModelSelection.options ?? [],
    },
    mode: "async",
    runtimeMode: "inherit",
    interactionMode: "inherit",
    clientRequestId: input.commandId,
  } satisfies OrchestratorMcpDelegateTaskInput;
  return {
    threadId: input.thread.id,
    commandId: input.commandId,
    createdAt: input.createdAt,
    creationSource: "web",
    message: {
      messageId: input.messageId,
      role: "user",
      text: [
        "Please delegate one T3 Code task using the delegate_task tool with the JSON arguments below.",
        "Check orchestrator_capabilities for the requested provider instance, model and options first. Do not silently substitute another instance, model or reasoning level; report any unavailable selection.",
        "Use the task field verbatim as the child's self-contained prompt. Do not append this thread's conversation history. Delegate the work rather than performing it yourself or using a provider-native agent.",
        JSON.stringify(request, null, 2),
      ].join("\n\n"),
      attachments: [],
    },
    runtimeMode: input.thread.runtimeMode,
    interactionMode: input.thread.interactionMode,
    dispatchMode: "queue",
  };
}
