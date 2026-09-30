import type {
  ProviderUserInputAnswers,
  OrchestrationV2UserInputQuestion,
} from "@t3tools/contracts";
import type * as AcpSchema from "effect-acp/compat";

export const KIMI_SUBAGENT_SUPERVISION_GUIDANCE = `<t3-subagent-supervision>
You may use Agent or AgentSwarm subagents. In this ACP client, autonomous background-agent replies are not visible to the user. If the current request depends on a subagent result, omit run_in_background so it runs in the foreground; independent foreground Agent calls or one AgentSwarm may run concurrently. Receive and synthesize all required delegated results before ending this turn. First report any completed background-task notifications or results already present in session context before doing unrelated status work. After tool use, always finish with a user-facing response.
</t3-subagent-supervision>`;

/** Older Kimi Code omits the command kind and puts the command in content. */
export function normalizeKimiPermissionRequest(request: AcpSchema.RequestPermissionRequest) {
  const title = request.toolCall.title?.trim().toLowerCase();
  const command = ["bash", "shell", "terminal", "command"].includes(title ?? "");
  const detail = request.toolCall.content
    ?.flatMap((entry) =>
      entry.type === "content" && entry.content.type === "text" ? [entry.content.text] : [],
    )
    .join("\n")
    .trim();
  return {
    ...request,
    toolCall: {
      ...request.toolCall,
      ...(command && !request.toolCall.kind ? { kind: "execute" as const } : {}),
      ...(command && detail
        ? {
            rawInput: request.toolCall.rawInput ?? {
              command: detail.replace(/^Requesting approval to Running:\s*/i, ""),
            },
          }
        : {}),
    },
  };
}

export function extractKimiPermissionQuestion(request: AcpSchema.RequestPermissionRequest) {
  if (request.toolCall.title?.trim().toLowerCase() !== "askuserquestion") return undefined;
  const content = request.toolCall.content?.find(
    (entry) => entry.type === "content" && entry.content.type === "text",
  );
  const question: OrchestrationV2UserInputQuestion = {
    id: request.toolCall.toolCallId,
    header: "Question",
    question:
      content?.type === "content" && content.content.type === "text"
        ? content.content.text.trim() || "Kimi needs your input."
        : "Kimi needs your input.",
    options: request.options
      .filter((option) => option.kind === "allow_once")
      .map((option) => ({ label: option.name, description: option.name })),
    multiSelect: false,
  };
  return {
    question,
    respond: (
      answers: ProviderUserInputAnswers,
    ): AcpSchema.RequestPermissionResponse | undefined => {
      const answer = answers[question.id] ?? Object.values(answers)[0];
      const selected = Array.isArray(answer) ? answer[0] : answer;
      if (typeof selected !== "string") return undefined;
      const option = request.options.find(
        (option) =>
          option.kind === "allow_once" &&
          (option.name.trim().toLowerCase() === selected.trim().toLowerCase() ||
            option.optionId === selected),
      );
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : undefined;
    },
  };
}
