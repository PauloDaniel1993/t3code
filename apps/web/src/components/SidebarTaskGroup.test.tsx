import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ThreadTaskMetadata } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarTaskGroup } from "./SidebarTaskGroup";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const TASK_KEY = "env-1:task-1";

const metadata = (overrides: Partial<ThreadTaskMetadata> = {}): ThreadTaskMetadata =>
  ({
    parentThreadId: "parent-1",
    title: "Inventory handlers",
    prompt: "List every handler.",
    context: { kind: "full-thread" },
    contextTruncated: false,
    createdBy: "agent",
    status: "finished",
    requestedAt: "2026-07-25T11:50:00.000Z",
    startedAt: "2026-07-25T11:50:00.000Z",
    finishedAt: "2026-07-25T11:50:12.000Z",
    result: null,
    delivery: { state: "delivered", updatedAt: "2026-07-25T11:50:12.000Z" },
    ...overrides,
  }) as ThreadTaskMetadata;

const shell = (task: ThreadTaskMetadata): EnvironmentThreadShell =>
  ({ id: "task-1", environmentId: "env-1", task }) as unknown as EnvironmentThreadShell;

const render = (props: Partial<Parameters<typeof SidebarTaskGroup>[0]> = {}) =>
  renderToStaticMarkup(
    <SidebarTaskGroup
      parentThreadKey="env-1:parent-1"
      tasks={[shell(metadata())]}
      expanded
      openTaskKey={null}
      nowMs={NOW}
      onPeekTask={() => {}}
      onPeekLeave={() => {}}
      onOpenThread={() => {}}
      onContextMenu={() => {}}
      renamingTaskKey={null}
      renamingTitle=""
      onRenameTitleChange={() => {}}
      onCommitRename={() => {}}
      onCancelRename={() => {}}
      onNewTask={() => {}}
      miniWindow={null}
      {...props}
    />,
  );

describe("SidebarTaskGroup", () => {
  it("renders a task row with its title, returned marker, and run duration", () => {
    const html = render();
    expect(html).toContain('data-testid="sidebar-task-row"');
    expect(html).toContain("Inventory handlers");
    expect(html).toContain("↩");
    expect(html).toContain("12s");
  });

  // The row navigates now, so it is not a disclosure control — the peek opens
  // on hover and focus instead.
  it("does not present the row as an expandable disclosure", () => {
    expect(render()).not.toContain("aria-expanded");
  });

  // A settled task shows how long it took. Before, this measured time since it
  // finished, so a finished task's row counted up forever.
  it("freezes the row's duration once the task has settled", () => {
    expect(render()).toContain("12s");
    expect(render({ nowMs: NOW + 6 * 60 * 60 * 1000 })).toContain("12s");
  });

  it("keeps counting while the task is still running", () => {
    const running = metadata({ status: "running", finishedAt: null });
    expect(render({ tasks: [shell(running)], nowMs: NOW })).toContain("10m");
    expect(render({ tasks: [shell(running)], nowMs: NOW + 60_000 })).toContain("11m");
  });

  it("swaps the row for an editor while the task is being renamed", () => {
    const html = render({ renamingTaskKey: TASK_KEY, renamingTitle: "Handler audit" });
    expect(html).toContain('aria-label="Task title"');
    expect(html).toContain('value="Handler audit"');
    // The row itself steps aside so the editor is not competing with a
    // navigating button or a peek that would steal focus.
    expect(html).not.toContain('data-testid="sidebar-task-row"');
  });

  it("renders nothing while the group is collapsed", () => {
    expect(render({ expanded: false })).toBe("");
  });
});
