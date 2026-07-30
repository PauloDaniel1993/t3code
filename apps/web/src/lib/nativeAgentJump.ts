/**
 * Locating an in-session agent in the transcript: scroll the run's row in its
 * turn's workflow card into view and flash it.
 *
 * The transcript is a separate component tree from the sidebar with no jump
 * API, so this works at the DOM level against two markers the workflow card
 * already publishes (and one the worker rows add): the per-row
 * `data-native-agent-task-id` and the per-card `data-workflow-activity-turn-id`.
 *
 * The card renders inline at its turn's terminal response with every worker
 * row mounted, so the exact row is normally found. When it is absent (the
 * turn is outside the rendered window), the turn's card is the honest
 * fallback: it is where the run lives.
 */
const FLASH_CLASS = "native-agent-jump-flash";
/** Covers navigating to the parent thread and its timeline mounting first. */
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 5_000;

export function jumpToNativeAgentInTranscript(input: {
  readonly taskId: string;
  readonly turnId: string | null;
}): void {
  if (typeof document === "undefined") return;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const attempt = () => {
    const target = findNativeAgentRow(input.taskId) ?? findTurnCard(input.turnId);
    if (target !== null) {
      flashElement(target);
      return;
    }
    // Not every turn is rendered — older activity loads behind paging — so a
    // target that never appears is dropped quietly rather than reported.
    if (Date.now() < deadline) {
      window.setTimeout(attempt, POLL_INTERVAL_MS);
    }
  };
  attempt();
}

function findNativeAgentRow(taskId: string): HTMLElement | null {
  // Attribute comparison rather than a selector: provider task ids can carry
  // characters a CSS selector would need escaped.
  for (const element of document.querySelectorAll<HTMLElement>("[data-native-agent-task-id]")) {
    if (element.dataset.nativeAgentTaskId === taskId) return element;
  }
  return null;
}

function findTurnCard(turnId: string | null): HTMLElement | null {
  if (turnId === null) return null;
  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-workflow-activity-turn-id]",
  )) {
    if (element.dataset.workflowActivityTurnId === turnId) return element;
  }
  return null;
}

function flashElement(element: HTMLElement): void {
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  // Restart the animation when the same target flashes twice in a row.
  element.classList.remove(FLASH_CLASS);
  void element.offsetWidth;
  element.classList.add(FLASH_CLASS);
  element.addEventListener("animationend", () => element.classList.remove(FLASH_CLASS), {
    once: true,
  });
}
