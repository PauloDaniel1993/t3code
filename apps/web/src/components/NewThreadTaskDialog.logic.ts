import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import {
  isProviderNativeSubagentThread,
  CommandId,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpDelegateTaskInput,
  type ServerProvider,
} from "@t3tools/contracts";
import { getComposerPromptLengthValidationMessage } from "./chat/composerSubmission";

// The parent must repeat this text in tool arguments. Leave room in its output for the wrapper.
export const TASK_PROMPT_MAX_LENGTH = 12_000;
export const TASK_CONTEXT_SUMMARY_MAX_LENGTH = 4_000;
export const TASK_TITLE_MAX_LENGTH = 512;

export interface NewThreadTaskDraft {
  readonly title: string;
  readonly prompt: string;
  readonly includeThreadContext?: boolean;
}

export function deriveTaskTitle(draft: NewThreadTaskDraft): string {
  return draft.title.trim() || draft.prompt.trim().split(/\r?\n/, 1)[0]!.slice(0, 80);
}

export function validateNewThreadTaskDraft(draft: NewThreadTaskDraft): string | null {
  if (!draft.prompt.trim()) return "Describe what the task should do.";
  if (draft.prompt.length > TASK_PROMPT_MAX_LENGTH) {
    return "The task prompt exceeds 12,000 characters. The parent must repeat it in a tool call; put longer context in files the task can read.";
  }
  if (draft.title.trim().length > TASK_TITLE_MAX_LENGTH) {
    return "The task title must be at most 512 characters.";
  }
  return null;
}

/** Plan children cannot escalate to Default; permission approval remains provider-owned. */
export function getNewThreadTaskModeNotice(
  thread: Pick<OrchestrationV2AppThread, "interactionMode" | "runtimeMode">,
  driverKind: ServerProvider["driver"] | undefined,
): string | null {
  const notices = [];
  if (thread.interactionMode === "plan") {
    notices.push(
      "The parent is in Plan mode and may refuse delegation. Any child also inherits Plan mode and only plans. Switch the parent to Default mode before requesting implementation.",
    );
  }
  if (thread.runtimeMode === "approval-required" || thread.runtimeMode === "auto-accept-edits") {
    notices.push(
      "The parent's runtime mode can require approval; the parent will ask for approval when required.",
    );
  }
  if (driverKind === "claudeAgent") {
    notices.push(
      "In a Claude read-only sandbox, delegation requires approval and may be denied if approvals are disabled.",
    );
  }
  return notices.length ? notices.join(" ") : null;
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
  if (input.status === "deleted" || (input.projection?.thread.deletedAt ?? null) !== null) {
    return "This thread is no longer available.";
  }
  if (!input.connected) return "Connect to this thread's environment to request a task.";
  if (input.status !== "live" || input.projection === null) return "Wait for the thread to load.";
  const { thread, runtimeRequests } = input.projection;
  if (thread.archivedAt !== null) {
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

function buildDelegationMessage(input: {
  readonly draft: NewThreadTaskDraft;
  readonly childModelSelection: ModelSelection;
  readonly commandId: CommandId;
}): string {
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
  return [
    "Please delegate one T3 Code task with a single delegate_task tool call using the JSON arguments below.",
    "Do not silently substitute another instance, model or reasoning level; report any unavailable selection or tool error.",
    input.draft.includeThreadContext
      ? `Keep the supplied task text verbatim. Append your own concise summary of the relevant context this task needs from this thread, at most ${TASK_CONTEXT_SUMMARY_MAX_LENGTH} additional characters. The final task field must be at most ${TASK_PROMPT_MAX_LENGTH + TASK_CONTEXT_SUMMARY_MAX_LENGTH} characters. Do not copy the conversation transcript. Preserve every other JSON argument exactly. Delegate the work rather than performing it yourself or using a provider-native agent.`
      : "Use the task field verbatim as the child's self-contained prompt. Do not append this thread's conversation history. Delegate the work rather than performing it yourself or using a provider-native agent.",
    "```json\n" + JSON.stringify(request, null, 2) + "\n```",
  ].join("\n\n");
}

export function validateNewThreadTaskRequest(
  draft: NewThreadTaskDraft,
  childModelSelection: ModelSelection,
): string | null {
  return (
    validateNewThreadTaskDraft(draft) ??
    getComposerPromptLengthValidationMessage(
      buildDelegationMessage({
        draft,
        childModelSelection,
        commandId: CommandId.make("00000000-0000-0000-0000-000000000000"),
      }),
    )
  );
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
  const text = buildDelegationMessage(input);
  const problem =
    validateNewThreadTaskDraft(input.draft) ?? getComposerPromptLengthValidationMessage(text);
  if (problem !== null) throw new Error(problem);
  return {
    threadId: input.thread.id,
    commandId: input.commandId,
    createdAt: input.createdAt,
    creationSource: "web",
    message: {
      messageId: input.messageId,
      role: "user",
      text,
      attachments: [],
    },
    runtimeMode: input.thread.runtimeMode,
    interactionMode: input.thread.interactionMode,
    dispatchMode: "queue",
  };
}
