import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ThreadNativeAgent, ThreadTaskMetadata } from "@t3tools/contracts";
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

const shell = (
  task: ThreadTaskMetadata,
  overrides: Record<string, unknown> = {},
): EnvironmentThreadShell =>
  ({
    id: "task-1",
    environmentId: "env-1",
    task,
    latestTurn: null,
    session: null,
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

const runningTurn = (startedAt = "2026-07-25T11:58:00.000Z") => ({
  latestTurn: { state: "running", requestedAt: startedAt, startedAt, completedAt: null },
  session: { activeTurnId: "turn-2" },
});

const render = (props: Partial<Parameters<typeof SidebarTaskGroup>[0]> = {}) =>
  renderToStaticMarkup(
    <SidebarTaskGroup
      parentThreadKey="env-1:parent-1"
      tasks={[shell(metadata())]}
      nativeAgents={[]}
      expanded
      openTaskKey={null}
      openNativeAgentKey={null}
      nowMs={NOW}
      onPeekTask={() => {}}
      onPeekNativeAgent={() => {}}
      onPeekLeave={() => {}}
      onOpenThread={() => {}}
      onNativeAgentClick={() => {}}
      onContextMenu={() => {}}
      renamingTaskKey={null}
      renamingTitle=""
      onRenameTitleChange={() => {}}
      onCommitRename={() => {}}
      onCancelRename={() => {}}
      onNewTask={() => {}}
      miniWindow={null}
      nativeAgentMiniWindow={null}
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
    const rowTag = render().split('data-testid="sidebar-task-row"')[0]?.split("<button").pop();
    expect(rowTag).not.toContain("aria-expanded");
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

describe("SidebarTaskGroup — a long list", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      shell(metadata({ title: `Task ${index + 1}` }), { id: `task-${index + 1}` }),
    );

  it("renders every task, however many there are", () => {
    const html = render({ tasks: many(9) });
    expect(html).toContain("Task 1");
    expect(html).toContain("Task 9");
  });

  // A parent can accumulate a lot of tasks; an unbounded group would push
  // every thread below it off the sidebar.
  it("scrolls in place once the list runs past four rows", () => {
    expect(render({ tasks: many(5) })).toContain("overflow-y-auto");
  });

  it("leaves a list of four or fewer to size itself", () => {
    expect(render({ tasks: many(4) })).not.toContain("overflow-y-auto");
    expect(render({ tasks: many(1) })).not.toContain("overflow-y-auto");
  });
});

// A task thread is still an ordinary thread: steering it, or opening it and
// sending a prompt, starts a new turn that the sidebar has to reflect.
describe("SidebarTaskGroup — a settled task that starts working again", () => {
  const revived = () => shell(metadata(), runningTurn());

  it("counts as working rather than settling into the done shelf", () => {
    const html = render({ tasks: [revived()] });
    expect(html).not.toContain('data-testid="sidebar-task-done-toggle"');
  });

  it("shows the running icon even though the recorded status is finished", () => {
    const html = render({ tasks: [revived()] });
    expect(html).toContain('data-task-status="finished"');
    expect(html).toContain("Running");
    expect(html).not.toContain('aria-label="Done"');
  });

  it("times the new turn, not the original run", () => {
    // Turn started 2m before now; the original run took 12s.
    expect(render({ tasks: [revived()], nowMs: NOW })).toContain("2m");
    expect(render({ tasks: [revived()], nowMs: NOW })).not.toContain("12s");
  });
});

// In-session agents nest under the task rows, grouped per turn. They are not
// threads: no context menu, no rename, and their rows never claim to open one.
describe("SidebarTaskGroup — in-session agents", () => {
  const nativeAgent = (
    overrides: Omit<Partial<ThreadNativeAgent>, "turnId"> & {
      taskId: string;
      turnId?: string | null;
    },
  ): ThreadNativeAgent =>
    ({
      turnId: "turn-1",
      status: "running",
      description: overrides.taskId,
      startedAt: "2026-07-25T11:58:00.000Z",
      updatedAt: "2026-07-25T11:58:00.000Z",
      ...overrides,
    }) as ThreadNativeAgent;

  it("renders a per-turn group with a relative label and live counts", () => {
    const html = render({
      nativeAgents: [
        nativeAgent({ taskId: "w1", description: "Map handlers" }),
        nativeAgent({
          taskId: "w2",
          description: "Trace refresh",
          status: "failed",
          updatedAt: "2026-07-25T11:59:00.000Z",
        }),
      ],
    });
    expect(html).toContain('data-testid="sidebar-native-agent-groups"');
    expect(html).toContain("Latest turn · 2 agents");
    expect(html).toContain("Map handlers");
    expect(html).toContain("Trace refresh");
    // One running, one failed — a zero count is omitted, not rendered.
    const groupsHtml = html.split('data-testid="sidebar-native-agent-groups"')[1] ?? "";
    expect(groupsHtml).toContain("1 running");
    expect(groupsHtml).toContain("1 failed");
    expect(groupsHtml).not.toContain("finished");
  });

  it("opens the group while work is live, even without a user toggle", () => {
    const html = render({ nativeAgents: [nativeAgent({ taskId: "w1" })] });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-testid="sidebar-native-agent-row"');
  });

  it("keeps an old, fully settled group collapsed", () => {
    const html = render({
      nativeAgents: [
        nativeAgent({ taskId: "w1", turnId: "turn-old", status: "finished" }),
        nativeAgent({ taskId: "w2", turnId: "turn-new", status: "finished" }),
      ],
    });
    const toggles = html.split('data-testid="sidebar-native-agent-group-toggle"');
    // Two groups: the older collapsed, the latest expanded.
    expect(toggles).toHaveLength(3);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-expanded="true"');
  });

  it("marks a retry with ↺ and never presents the row as a thread", () => {
    const html = render({
      nativeAgents: [nativeAgent({ taskId: "w4", retryOfTaskId: "w3", description: "Retry run" })],
    });
    expect(html).toContain("↺");
    const rowTag = html.split('data-testid="sidebar-native-agent-row"')[0]?.split("<button").pop();
    expect(rowTag).not.toContain("data-thread-item");
    expect(rowTag).not.toContain("aria-expanded");
  });

  it("renders no agent section when the thread has none", () => {
    expect(render()).not.toContain('data-testid="sidebar-native-agent-groups"');
  });
});
