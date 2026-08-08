import { THREAD_TASK_TOOL_PROMPT_MAX_CHARS } from "@t3tools/contracts";

import { EMPTY_NEW_THREAD_TASK_DRAFT, type NewThreadTaskDraft } from "../NewThreadTaskDialog.logic";
import type { StarMapGraphNode } from "./starMapGraph";

const TRUNCATED_CONTEXT_NOTE =
  "The embedded ticket context is truncated. Read the full source file before starting.";

/**
 * Turn the ticket being read into an editable manual-task draft. The source
 * path stays in the brief even when the preview is complete: the task runs in
 * the same workspace and can return to the canonical ticket if it needs to.
 */
export function buildStarMapTicketTaskDraft(input: {
  readonly node: Pick<StarMapGraphNode, "label" | "relativePath">;
  readonly contents: string | null;
  readonly truncated: boolean;
}): NewThreadTaskDraft {
  const source = `\`${input.node.relativePath}\``;
  const contents = input.contents?.trim() ?? "";
  const context =
    contents.length > 0
      ? [
          ...(input.truncated ? [TRUNCATED_CONTEXT_NOTE, ""] : []),
          "Ticket context:",
          "",
          contents,
        ].join("\n")
      : `The ticket preview is unavailable. Read the full ticket at ${source} before starting.`;
  const prompt = [
    "Work on this Wayfinder ticket in the current workspace. Follow its requirements and report the result back to the parent thread.",
    "",
    `Source: ${source}`,
    "",
    context,
  ].join("\n");

  return {
    ...EMPTY_NEW_THREAD_TASK_DRAFT,
    title: input.node.label,
    prompt: clampTaskPrompt(prompt, source),
  };
}

function clampTaskPrompt(prompt: string, source: string): string {
  if (prompt.length <= THREAD_TASK_TOOL_PROMPT_MAX_CHARS) return prompt;
  const ending = `\n\n[Embedded ticket context truncated for the task prompt.]\nRead the full ticket at ${source} before starting.`;
  return `${prompt.slice(0, THREAD_TASK_TOOL_PROMPT_MAX_CHARS - ending.length).trimEnd()}${ending}`;
}
