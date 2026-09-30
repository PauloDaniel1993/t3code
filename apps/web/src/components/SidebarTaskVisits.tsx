import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isSidebarTaskThread } from "@t3tools/client-runtime/state/sidebar-task-subthreads";
import { useEffect } from "react";
import { readThreadShell } from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { sidebarTaskPresentationStore } from "./sidebarTaskPresentation";

/** Record navigation, never streaming. Leaving also clears deliveries received while open. */
export function SidebarTaskVisits({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  useEffect(() => {
    if (environmentId === undefined || threadId === undefined) return;
    const ref = scopeThreadRef(environmentId, threadId);
    const key = scopedThreadKey(ref);
    const visit = () => {
      const thread = readThreadShell(ref);
      if (thread === null) return;
      const known = sidebarTaskPresentationStore.getState().byParent.get(key);
      let deliveredAt = Date.parse(thread.source.latestTaskDeliveredAt ?? "") || 0;
      for (const task of known?.subagents ?? []) {
        if (task.origin === "app_owned")
          deliveredAt = Math.max(
            deliveredAt,
            Date.parse(task.completionDelivery?.deliveredAt ?? "") || 0,
          );
      }
      if (!isSidebarTaskThread(thread) && deliveredAt === 0) return;
      useUiStateStore
        .getState()
        .markThreadVisited(key, new Date(Math.max(Date.now(), deliveredAt)).toISOString());
    };
    visit();
    return visit;
  }, [environmentId, threadId]);
  return null;
}
