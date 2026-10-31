import type { FlowRunsPage, FlowRunsCursor, ScheduledTaskId } from "@t3tools/contracts";

export async function findScheduledFlowRun(
  initial: FlowRunsPage,
  taskId: ScheduledTaskId,
  loadPage: (cursor: FlowRunsCursor) => Promise<FlowRunsPage>,
) {
  let page = initial;
  const visited = new Set<string>();
  while (true) {
    const latest = page.runs
      .filter((run) => run.scheduledTaskId === taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (latest) return latest;
    const cursor = page.nextCursor;
    if (!cursor || visited.has(cursor.id)) return null;
    visited.add(cursor.id);
    page = await loadPage(cursor);
  }
}
