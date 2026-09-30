// @vitest-environment jsdom
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { onOpenNewThreadTaskDialog, type OpenNewThreadTaskRequest } from "../../newThreadTaskBus";
import { TASK_PROMPT_MAX_LENGTH, validateNewThreadTaskDraft } from "../NewThreadTaskDialog.logic";
import { buildStarMapTicketTaskDraft, openStarMapTicketAsTask } from "./StarMapTicketDetail.logic";

const node = {
  label: "Repair Windows destination window discovery",
  relativePath: ".plan/issues/05-repair-windows-destination.md",
};

describe("buildStarMapTicketTaskDraft", () => {
  it("prefills the task title and prompt from the ticket", () => {
    const draft = buildStarMapTicketTaskDraft({
      node,
      contents: "# Repair Windows destination window discovery\n\nFix the discovery seam.",
      truncated: false,
    });

    expect(draft.title).toBe(node.label);
    expect(draft.prompt).toContain(`Source: \`${node.relativePath}\``);
    expect(draft.prompt).toContain("Fix the discovery seam.");
  });

  it("points the task at the canonical file when no preview is available", () => {
    const draft = buildStarMapTicketTaskDraft({ node, contents: null, truncated: false });

    expect(draft.prompt).toContain("The ticket preview is unavailable.");
    expect(draft.prompt).toContain(`Read the full ticket at \`${node.relativePath}\``);
  });

  it("keeps a ticket without a body usable: source path, no empty context section", () => {
    for (const contents of [null, "", "  \n\t "]) {
      const draft = buildStarMapTicketTaskDraft({ node, contents, truncated: false });

      expect(draft.prompt).not.toContain("Ticket context:");
      expect(draft.prompt).toContain(`Source: \`${node.relativePath}\``);
      expect(validateNewThreadTaskDraft(draft)).toBeNull();
    }
  });

  it("warns the task to read the source when the preview is truncated", () => {
    const draft = buildStarMapTicketTaskDraft({
      node,
      contents: "partial ticket",
      truncated: true,
    });

    expect(draft.prompt).toContain("The embedded ticket context is truncated.");
    expect(draft.prompt).toContain("partial ticket");
  });

  it("bounds an oversized embedded ticket without losing its source", () => {
    const draft = buildStarMapTicketTaskDraft({
      node,
      contents: "x".repeat(TASK_PROMPT_MAX_LENGTH + 1_000),
      truncated: false,
    });

    expect(draft.prompt).toHaveLength(TASK_PROMPT_MAX_LENGTH);
    expect(draft.prompt).toContain("Embedded ticket context truncated for the task prompt.");
    expect(
      draft.prompt.endsWith(`Read the full ticket at \`${node.relativePath}\` before starting.`),
    ).toBe(true);
    expect(validateNewThreadTaskDraft(draft)).toBeNull();
  });

  it("does not split a surrogate pair where a long body is cut", () => {
    for (let offset = 0; offset < 2; offset += 1) {
      const draft = buildStarMapTicketTaskDraft({
        node,
        contents: "a".repeat(offset) + "\u{1F600}".repeat(TASK_PROMPT_MAX_LENGTH),
        truncated: false,
      });

      expect(draft.prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(draft.prompt.length).toBeLessThanOrEqual(TASK_PROMPT_MAX_LENGTH);
    }
  });

  it("carries markdown in the title verbatim and keeps it out of the prompt structure", () => {
    const title = "**Fix** `parser` [docs](x) # not a heading";
    const draft = buildStarMapTicketTaskDraft({
      node: { ...node, label: title },
      contents: "body",
      truncated: false,
    });

    expect(draft.title).toBe(title);
    expect(draft.prompt.startsWith("Work on this Wayfinder ticket")).toBe(true);
    expect(draft.prompt).not.toContain("**Fix**");
  });

  it("clamps a title longer than the dialog allows", () => {
    const draft = buildStarMapTicketTaskDraft({
      node: { ...node, label: "t".repeat(2_000) },
      contents: "body",
      truncated: false,
    });

    expect(validateNewThreadTaskDraft(draft)).toBeNull();
  });
});

describe("openStarMapTicketAsTask", () => {
  const parent = scopeThreadRef(EnvironmentId.make("remote-env"), ThreadId.make("parent-thread"));

  it("asks the New task host to open on the given parent with the ticket draft", () => {
    const open = vi.fn();

    openStarMapTicketAsTask(
      { threadRef: parent, node, contents: "Fix the seam.", truncated: false },
      open,
    );

    expect(open).toHaveBeenCalledTimes(1);
    const request: OpenNewThreadTaskRequest = open.mock.calls[0]![0];
    expect(request.threadRef).toEqual(parent);
    expect(request.initialDraft?.title).toBe(node.label);
    expect(request.initialDraft?.prompt).toContain("Fix the seam.");
    expect(request.initialDraft?.includeThreadContext).toBeUndefined();
  });

  it("reaches the app-level host through the real request bus", () => {
    const received: OpenNewThreadTaskRequest[] = [];
    const stop = onOpenNewThreadTaskDialog((request) => received.push(request));
    try {
      openStarMapTicketAsTask({ threadRef: parent, node, contents: null, truncated: false });
    } finally {
      stop();
    }

    expect(received).toHaveLength(1);
    expect(received[0]!.threadRef).toEqual(parent);
    expect(received[0]!.initialDraft?.title).toBe(node.label);
  });
});
