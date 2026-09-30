import type { ScopedThreadRef } from "@t3tools/contracts";
import type { NewThreadTaskDraft } from "./components/NewThreadTaskDialog.logic";

/**
 * App-level NewThreadTaskHost owns every request, including unopened parents.
 * Import openNewThreadTaskDialog from this module and call it with
 * { threadRef: scopeThreadRef(environmentId, parentThreadId), initialDraft?: { title, prompt } }.
 * The optional draft is copied into a new dialog; route changes never retarget the parent.
 * Sidebar (ticket 32) supplies only threadRef; Wayfinder (ticket 38) also supplies initialDraft.
 */
export interface OpenNewThreadTaskRequest {
  readonly threadRef: ScopedThreadRef;
  readonly initialDraft?: NewThreadTaskDraft;
}

const NEW_THREAD_TASK_EVENT = "t3code:new-thread-task";

export function openNewThreadTaskDialog(request: OpenNewThreadTaskRequest): void {
  window.dispatchEvent(new CustomEvent(NEW_THREAD_TASK_EVENT, { detail: request }));
}

export function onOpenNewThreadTaskDialog(
  listener: (request: OpenNewThreadTaskRequest) => void,
): () => void {
  const handler = (event: Event) =>
    listener((event as CustomEvent<OpenNewThreadTaskRequest>).detail);
  window.addEventListener(NEW_THREAD_TASK_EVENT, handler);
  return () => window.removeEventListener(NEW_THREAD_TASK_EVENT, handler);
}
