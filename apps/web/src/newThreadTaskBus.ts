import type { ScopedThreadRef } from "@t3tools/contracts";

const NEW_THREAD_TASK_EVENT = "t3code:new-thread-task";

/** The chat header owns the dialog; other entry points address its environment-local thread. */
export function openNewThreadTaskDialog(threadRef: ScopedThreadRef): void {
  window.dispatchEvent(new CustomEvent(NEW_THREAD_TASK_EVENT, { detail: threadRef }));
}

export function onOpenNewThreadTaskDialog(
  listener: (threadRef: ScopedThreadRef) => void,
): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<ScopedThreadRef>).detail);
  window.addEventListener(NEW_THREAD_TASK_EVENT, handler);
  return () => window.removeEventListener(NEW_THREAD_TASK_EVENT, handler);
}
