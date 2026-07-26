/**
 * Draft rules for the manual task creation dialog.
 *
 * Kept out of the component so the parts that can be wrong — what counts as a
 * usable draft, which messages can be picked, and what the selection bound
 * does when it is hit — are testable without rendering.
 */
import {
  THREAD_TASK_MAX_SELECTED_MESSAGES,
  type MessageId,
  type OrchestrationMessageRole,
  type OrchestrationMessageSource,
  type ThreadTaskContextSpec,
} from "@t3tools/contracts";
import { isTaskResultMessage } from "@t3tools/client-runtime/state/thread-tasks";

export type NewThreadTaskContextKind = ThreadTaskContextSpec["kind"];

export interface NewThreadTaskDraft {
  readonly title: string;
  readonly prompt: string;
  readonly contextKind: NewThreadTaskContextKind;
  readonly selectedMessageIds: ReadonlyArray<MessageId>;
}

export const EMPTY_NEW_THREAD_TASK_DRAFT: NewThreadTaskDraft = {
  title: "",
  prompt: "",
  contextKind: "full-thread",
  selectedMessageIds: [],
};

/** How long a derived title is allowed to get before it is cut. */
const DERIVED_TITLE_MAX_CHARS = 80;
const MESSAGE_PREVIEW_MAX_CHARS = 160;

export interface SelectableMessage {
  readonly id: MessageId;
  readonly role: OrchestrationMessageRole;
  readonly preview: string;
  readonly createdAt: string;
}

interface PickableMessage {
  readonly id: MessageId;
  readonly role: OrchestrationMessageRole;
  readonly source?: OrchestrationMessageSource | undefined;
  readonly text: string;
  readonly createdAt: string;
  readonly streaming?: boolean | undefined;
}

/**
 * The picker list, newest first — a task is almost always about what just
 * happened, so the useful end of the thread is the end the user sees first.
 *
 * Half-streamed assistant text and the wake-up messages other tasks injected
 * are not things a person can meaningfully point at, so they are left out.
 */
export function deriveSelectableMessages(
  messages: ReadonlyArray<PickableMessage>,
): ReadonlyArray<SelectableMessage> {
  return messages
    .filter(
      (message) =>
        message.streaming !== true &&
        message.text.trim().length > 0 &&
        !isTaskResultMessage(message),
    )
    .map((message) => ({
      id: message.id,
      role: message.role,
      preview: truncate(collapseWhitespace(message.text), MESSAGE_PREVIEW_MAX_CHARS),
      createdAt: message.createdAt,
    }))
    .reverse();
}

/**
 * Add or remove one message. Deselecting always works; selecting past the
 * bound is refused so the caller can say so rather than silently dropping it.
 */
export function toggleMessageSelection(input: {
  readonly selected: ReadonlyArray<MessageId>;
  readonly messageId: MessageId;
}): { readonly selected: ReadonlyArray<MessageId>; readonly rejected: boolean } {
  const { messageId, selected } = input;
  if (selected.includes(messageId)) {
    return { selected: selected.filter((id) => id !== messageId), rejected: false };
  }
  if (selected.length >= THREAD_TASK_MAX_SELECTED_MESSAGES) {
    return { selected, rejected: true };
  }
  return { selected: [...selected, messageId], rejected: false };
}

export function formatSelectionSummary(selectedCount: number): string {
  const noun = selectedCount === 1 ? "message" : "messages";
  return `${selectedCount} of ${THREAD_TASK_MAX_SELECTED_MESSAGES} ${noun} selected`;
}

/**
 * A title the user did not have to write. The prompt's first line is what they
 * would have typed anyway, so use it when the field is left blank.
 */
export function deriveTaskTitle(draft: Pick<NewThreadTaskDraft, "title" | "prompt">): string {
  const explicit = draft.title.trim();
  if (explicit.length > 0) return truncate(explicit, DERIVED_TITLE_MAX_CHARS);
  const firstLine = draft.prompt.trim().split("\n")[0]?.trim() ?? "";
  return truncate(collapseWhitespace(firstLine), DERIVED_TITLE_MAX_CHARS);
}

/**
 * Why this draft cannot be submitted yet, or `null` when it can. Returned as
 * text because it is shown verbatim next to the offending field.
 */
export function validateNewThreadTaskDraft(draft: NewThreadTaskDraft): string | null {
  // A non-empty prompt always yields a title, so the prompt is the only text
  // the user is actually required to supply.
  if (draft.prompt.trim().length === 0) {
    return "Describe what the task should do.";
  }
  if (draft.contextKind === "selected-messages") {
    if (draft.selectedMessageIds.length === 0) {
      return "Pick at least one message, or choose a different context.";
    }
    if (draft.selectedMessageIds.length > THREAD_TASK_MAX_SELECTED_MESSAGES) {
      return `Select at most ${THREAD_TASK_MAX_SELECTED_MESSAGES} messages.`;
    }
  }
  return null;
}

export function resolveTaskContextSpec(draft: NewThreadTaskDraft): ThreadTaskContextSpec {
  switch (draft.contextKind) {
    case "full-thread":
      return { kind: "full-thread" };
    case "none":
      return { kind: "none" };
    case "selected-messages":
      return { kind: "selected-messages", messageIds: [...draft.selectedMessageIds] };
  }
}

export const NEW_THREAD_TASK_CONTEXT_OPTIONS: ReadonlyArray<{
  readonly kind: NewThreadTaskContextKind;
  readonly label: string;
  readonly description: string;
}> = [
  {
    kind: "full-thread",
    label: "Full thread",
    description: "The task starts knowing everything said here so far.",
  },
  {
    kind: "selected-messages",
    label: "Selected messages",
    description: "Only the messages you pick are carried over.",
  },
  {
    kind: "none",
    label: "No context",
    description: "The task starts fresh, with only the prompt.",
  },
];

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
