import { THREAD_TASK_MAX_SELECTED_MESSAGES, MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveSelectableMessages,
  deriveTaskTitle,
  EMPTY_NEW_THREAD_TASK_DRAFT,
  formatSelectionSummary,
  resolveTaskContextSpec,
  toggleMessageSelection,
  validateNewThreadTaskDraft,
  type NewThreadTaskDraft,
} from "./NewThreadTaskDialog.logic";

const draft = (overrides: Partial<NewThreadTaskDraft> = {}): NewThreadTaskDraft => ({
  ...EMPTY_NEW_THREAD_TASK_DRAFT,
  prompt: "Inventory every provider handler.",
  ...overrides,
});

const message = (input: {
  id: string;
  role?: "user" | "assistant";
  text?: string;
  source?: "user" | "task-result";
  streaming?: boolean;
}) => ({
  id: MessageId.make(input.id),
  role: input.role ?? "user",
  text: input.text ?? input.id,
  createdAt: `2026-07-25T12:00:0${input.id.slice(-1)}.000Z`,
  ...(input.source !== undefined ? { source: input.source } : {}),
  ...(input.streaming !== undefined ? { streaming: input.streaming } : {}),
});

describe("deriveSelectableMessages", () => {
  it("lists messages newest first", () => {
    const list = deriveSelectableMessages([
      message({ id: "m1" }),
      message({ id: "m2" }),
      message({ id: "m3" }),
    ]);
    expect(list.map((entry) => entry.id)).toEqual(["m3", "m2", "m1"]);
  });

  it("leaves out what a person cannot meaningfully point at", () => {
    const list = deriveSelectableMessages([
      message({ id: "m1" }),
      message({ id: "m2", text: "   " }),
      message({ id: "m3", streaming: true }),
      // Another task's wake-up message is not part of this conversation.
      message({ id: "m4", source: "task-result" }),
    ]);
    expect(list.map((entry) => entry.id)).toEqual(["m1"]);
  });

  it("collapses whitespace into a single-line preview", () => {
    const [entry] = deriveSelectableMessages([
      message({ id: "m1", text: "  first line\n\n  second   line " }),
    ]);
    expect(entry?.preview).toBe("first line second line");
  });
});

describe("toggleMessageSelection", () => {
  const id = (value: string) => MessageId.make(value);

  it("adds and removes without reordering the rest", () => {
    const added = toggleMessageSelection({ selected: [id("a")], messageId: id("b") });
    expect(added).toEqual({ selected: [id("a"), id("b")], rejected: false });
    expect(toggleMessageSelection({ selected: added.selected, messageId: id("a") })).toEqual({
      selected: [id("b")],
      rejected: false,
    });
  });

  it("refuses to select past the bound instead of silently dropping the pick", () => {
    const full = Array.from({ length: THREAD_TASK_MAX_SELECTED_MESSAGES }, (_, index) =>
      id(`m${index}`),
    );
    const rejected = toggleMessageSelection({ selected: full, messageId: id("one-too-many") });
    expect(rejected.rejected).toBe(true);
    expect(rejected.selected).toBe(full);

    // Deselecting still works at the bound — otherwise the user would be stuck.
    const removed = toggleMessageSelection({ selected: full, messageId: id("m0") });
    expect(removed.rejected).toBe(false);
    expect(removed.selected).toHaveLength(THREAD_TASK_MAX_SELECTED_MESSAGES - 1);
  });
});

describe("deriveTaskTitle", () => {
  it("prefers what the user typed", () => {
    expect(deriveTaskTitle({ title: "  Handler audit  ", prompt: "anything" })).toBe(
      "Handler audit",
    );
  });

  it("falls back to the prompt's first line", () => {
    expect(deriveTaskTitle({ title: "  ", prompt: "Audit handlers\nThen report." })).toBe(
      "Audit handlers",
    );
  });

  it("bounds a long derived title", () => {
    const title = deriveTaskTitle({ title: "", prompt: "x".repeat(200) });
    expect(title).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("is empty when there is nothing to derive from", () => {
    expect(deriveTaskTitle({ title: "", prompt: "   " })).toBe("");
  });
});

describe("validateNewThreadTaskDraft", () => {
  it("accepts a full-thread draft with only a prompt", () => {
    expect(validateNewThreadTaskDraft(draft())).toBeNull();
  });

  it("requires a prompt, and nothing else for the title", () => {
    expect(validateNewThreadTaskDraft(draft({ prompt: "  " }))).toBe(
      "Describe what the task should do.",
    );
    // The title field stays optional: the prompt supplies one.
    expect(validateNewThreadTaskDraft(draft({ title: "  " }))).toBeNull();
    expect(deriveTaskTitle(draft({ title: "  " }))).toBe("Inventory every provider handler.");
  });

  it("requires at least one message when the context is a selection", () => {
    expect(validateNewThreadTaskDraft(draft({ contextKind: "selected-messages" }))).toBe(
      "Pick at least one message, or choose a different context.",
    );
    expect(
      validateNewThreadTaskDraft(
        draft({ contextKind: "selected-messages", selectedMessageIds: [MessageId.make("m1")] }),
      ),
    ).toBeNull();
  });

  it("rejects a selection past the bound", () => {
    expect(
      validateNewThreadTaskDraft(
        draft({
          contextKind: "selected-messages",
          selectedMessageIds: Array.from(
            { length: THREAD_TASK_MAX_SELECTED_MESSAGES + 1 },
            (_, i) => MessageId.make(`m${i}`),
          ),
        }),
      ),
    ).toBe(`Select at most ${THREAD_TASK_MAX_SELECTED_MESSAGES} messages.`);
  });
});

describe("resolveTaskContextSpec", () => {
  it("maps each choice onto its contract shape", () => {
    expect(resolveTaskContextSpec(draft())).toEqual({ kind: "full-thread" });
    expect(resolveTaskContextSpec(draft({ contextKind: "none" }))).toEqual({ kind: "none" });
    expect(
      resolveTaskContextSpec(
        draft({ contextKind: "selected-messages", selectedMessageIds: [MessageId.make("m1")] }),
      ),
    ).toEqual({ kind: "selected-messages", messageIds: ["m1"] });
  });
});

describe("formatSelectionSummary", () => {
  it("names the bound so the limit is visible before it is hit", () => {
    expect(formatSelectionSummary(0)).toBe(
      `0 of ${THREAD_TASK_MAX_SELECTED_MESSAGES} messages selected`,
    );
    expect(formatSelectionSummary(1)).toBe(
      `1 of ${THREAD_TASK_MAX_SELECTED_MESSAGES} message selected`,
    );
  });
});
