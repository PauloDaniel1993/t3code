import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";
import { useThreadProjection, useThreadShell } from "../state/entities";
import { useUiStateStore } from "../uiStateStore";

/** Task delivery unread state stays local even when V2 syncs ordinary thread visits. */
export function SidebarTaskVisits({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const thread = useThreadShell(threadRef);
  const subagents = useThreadProjection(threadRef)?.projection.subagents;
  const visit = useUiStateStore((state) => state.markThreadVisited);
  const environmentId = thread?.environmentId;
  const threadId = thread?.id;
  const updatedAt = thread?.updatedAt;
  const deliveredAt =
    subagents?.reduce((latest, task) => {
      const time = Date.parse(
        task.origin === "app_owned" ? (task.completionDelivery?.deliveredAt ?? "") : "",
      );
      return Number.isFinite(time) ? Math.max(latest, time) : latest;
    }, 0) ?? 0;
  useEffect(() => {
    if (environmentId === undefined || threadId === undefined || updatedAt === undefined) return;
    // Acceptance can follow the parent's last shell update. Visit the visible
    // delivery watermark as well, including when the server's clock is ahead.
    visit(
      scopedThreadKey({ environmentId, threadId }),
      new Date(Math.max(Date.now(), deliveredAt)).toISOString(),
    );
  }, [environmentId, threadId, updatedAt, deliveredAt, visit]);
  return null;
}
