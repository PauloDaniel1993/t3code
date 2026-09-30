import type { ScopedThreadRef } from "@t3tools/contracts";

import { openNewThreadTaskDialog } from "../../newThreadTaskBus";
import {
  TASK_PROMPT_MAX_LENGTH,
  TASK_TITLE_MAX_LENGTH,
  type NewThreadTaskDraft,
} from "../NewThreadTaskDialog.logic";
import type { StarMapGraphNode } from "./starMapGraph";

const TRUNCATED_CONTEXT_NOTE =
  "The embedded ticket context is truncated. Read the full source file before starting.";

/** The part of a New task dialog draft a map ticket fills in; thread context stays the user's choice. */
export type StarMapTicketTaskDraft = Pick<NewThreadTaskDraft, "title" | "prompt">;

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

  return {
    title: input.node.label.slice(0, TASK_TITLE_MAX_LENGTH),
    prompt: clampTaskPrompt(prompt, source),
  };
}

/**
 * The Open as task action: ask the app-level New task host to open its dialog on `threadRef`,
 * prefilled from the ticket. Nothing is created until the user confirms in the dialog. It runs
 * from a click, so the prompt (which embeds the ticket body) is never built while rendering.
 */
export function openStarMapTicketAsTask(
  input: Parameters<typeof buildStarMapTicketTaskDraft>[0] & {
    readonly threadRef: ScopedThreadRef;
  },
  open: typeof openNewThreadTaskDialog = openNewThreadTaskDialog,
): void {
  open({ threadRef: input.threadRef, initialDraft: buildStarMapTicketTaskDraft(input) });
}

function clampTaskPrompt(prompt: string, source: string): string {
  if (prompt.length <= TASK_PROMPT_MAX_LENGTH) return prompt;
  const ending = `\n\n[Embedded ticket context truncated for the task prompt.]\nRead the full ticket at ${source} before starting.`;
  const kept = prompt.slice(0, TASK_PROMPT_MAX_LENGTH - ending.length);
  // Never leave half of a surrogate pair at the cut.
  const whole = /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept;
  return `${whole.trimEnd()}${ending}`;
}
