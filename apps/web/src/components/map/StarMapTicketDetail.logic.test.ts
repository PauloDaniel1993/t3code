import { describe, expect, it } from "vite-plus/test";

import {
  STAR_MAP_TASK_PROMPT_MAX_CHARS,
  buildStarMapTicketTaskDraft,
} from "./StarMapTicketDetail.logic";

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
      contents: "x".repeat(STAR_MAP_TASK_PROMPT_MAX_CHARS + 1_000),
      truncated: false,
    });

    expect(draft.prompt).toHaveLength(STAR_MAP_TASK_PROMPT_MAX_CHARS);
    expect(draft.prompt).toContain("Embedded ticket context truncated for the task prompt.");
    expect(
      draft.prompt.endsWith(`Read the full ticket at \`${node.relativePath}\` before starting.`),
    ).toBe(true);
  });
});
