export type TerminalFocusOwner = "drawer" | "right-panel";

interface DocumentScrollTarget {
  readonly scrollX: number;
  readonly scrollY: number;
  scrollTo(x: number, y: number): void;
  requestAnimationFrame?(callback: FrameRequestCallback): number;
}

export function runWithDocumentScrollPreserved(
  action: () => void,
  scrollTarget: DocumentScrollTarget | null | undefined = typeof window === "undefined"
    ? null
    : window,
): void {
  if (!scrollTarget) {
    action();
    return;
  }

  const scrollX = scrollTarget.scrollX;
  const scrollY = scrollTarget.scrollY;
  const restoreScroll = () => {
    if (scrollTarget.scrollX !== scrollX || scrollTarget.scrollY !== scrollY) {
      scrollTarget.scrollTo(scrollX, scrollY);
    }
  };

  action();
  restoreScroll();
  scrollTarget.requestAnimationFrame?.(restoreScroll);
}

export function getTerminalFocusOwner(): TerminalFocusOwner | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;
  if (!activeElement.isConnected) return null;
  const owner = activeElement.closest<HTMLElement>("[data-terminal-owner]")?.dataset.terminalOwner;
  if (owner === "drawer" || owner === "right-panel") return owner;
  return null;
}

export function isTerminalFocused(): boolean {
  return getTerminalFocusOwner() !== null;
}
