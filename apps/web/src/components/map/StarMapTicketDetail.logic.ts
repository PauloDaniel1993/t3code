import type { StarMapGraphNode } from "./starMapGraph";

/**
 * Longest prompt a task draft may carry. This is the fork's `THREAD_TASK_TOOL_PROMPT_MAX_CHARS`;
 * V2 has no shared constant yet, so whoever attaches the New task dialog should replace it
 * with that dialog's own limit.
 */
export const STAR_MAP_TASK_PROMPT_MAX_CHARS = 100_000;

const TRUNCATED_CONTEXT_NOTE =
  "The embedded ticket context is truncated. Read the full source file before starting.";

/** The part of a New task dialog draft a map ticket can fill in. */
export interface StarMapTicketTaskDraft {
  readonly title: string;
  readonly prompt: string;
}

/**
 * Turn the ticket being read into an editable manual-task draft. The source
 * path stays in the brief even when the preview is complete: the task runs in
 * the same workspace and can return to the canonical ticket if it needs to.
 */
export function buildStarMapTicketTaskDraft(input: {
  readonly node: Pick<StarMapGraphNode, "label" | "relativePath">;
  readonly contents: string | null;
  readonly truncated: boolean;
}): StarMapTicketTaskDraft {
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

  return { title: input.node.label, prompt: clampTaskPrompt(prompt, source) };
}

function clampTaskPrompt(prompt: string, source: string): string {
  if (prompt.length <= STAR_MAP_TASK_PROMPT_MAX_CHARS) return prompt;
  const ending = `\n\n[Embedded ticket context truncated for the task prompt.]\nRead the full ticket at ${source} before starting.`;
  return `${prompt.slice(0, STAR_MAP_TASK_PROMPT_MAX_CHARS - ending.length).trimEnd()}${ending}`;
}
