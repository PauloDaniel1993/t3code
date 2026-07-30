import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  deriveNativeAgents,
  isNativeAgentActivityKind,
  selectVisibleNativeAgents,
} from "./nativeAgents.ts";

const TURN = TurnId.make("turn-1");

let nextId = 0;
function activity(
  kind: string,
  payload: Record<string, unknown>,
  createdAt: string,
  turnId: TurnId | null = TURN,
): OrchestrationThreadActivity {
  nextId += 1;
  return {
    id: EventId.make(`event-${nextId}`),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId,
    createdAt,
  } as OrchestrationThreadActivity;
}

describe("deriveNativeAgents", () => {
  it("folds a start/progress/complete run into one entry", () => {
    const agents = deriveNativeAgents([
      activity(
        "task.started",
        { taskId: "w1", description: "Map handlers", subagentType: "Explore", prompt: "Map them." },
        "2026-07-29T10:00:00.000Z",
      ),
      activity(
        "task.progress",
        { taskId: "w1", description: "scanning", summary: "7 of 12 checked", lastToolName: "Grep" },
        "2026-07-29T10:00:30.000Z",
      ),
      activity(
        "task.completed",
        { taskId: "w1", status: "completed", summary: "3 gaps found", usage: { totalTokens: 900 } },
        "2026-07-29T10:01:00.000Z",
      ),
    ]);

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      taskId: "w1",
      status: "finished",
      description: "Map handlers",
      subagentType: "Explore",
      prompt: "Map them.",
      progressSummary: "7 of 12 checked",
      resultSummary: "3 gaps found",
      lastToolName: "Grep",
      usage: { totalTokens: 900 },
      startedAt: "2026-07-29T10:00:00.000Z",
      updatedAt: "2026-07-29T10:01:00.000Z",
      turnId: TURN,
    });
  });

  it("maps a failed completion and links retries both ways", () => {
    const agents = deriveNativeAgents([
      activity(
        "task.started",
        { taskId: "w3", description: "Find gates", subagentType: "Explore" },
        "2026-07-29T10:00:00.000Z",
      ),
      activity(
        "task.completed",
        { taskId: "w3", status: "failed", error: "Budget exceeded" },
        "2026-07-29T10:00:34.000Z",
      ),
      activity(
        "task.started",
        { taskId: "w4", description: "Find gates", subagentType: "Explore", retryOfTaskId: "w3" },
        "2026-07-29T10:00:40.000Z",
      ),
    ]);

    const [failed, retry] = agents;
    expect(failed).toMatchObject({
      taskId: "w3",
      status: "failed",
      errorMessage: "Budget exceeded",
      retriedByTaskId: "w4",
    });
    expect(retry).toMatchObject({ taskId: "w4", status: "running", retryOfTaskId: "w3" });
  });

  it("never invents data the activities did not carry", () => {
    const agents = deriveNativeAgents([
      activity(
        "task.started",
        { taskId: "w1", subagentType: "Explore" },
        "2026-07-29T10:00:00.000Z",
      ),
    ]);
    const agent = agents[0]!;
    // Falls back to the subagent type rather than an empty label.
    expect(agent.description).toBe("Explore");
    expect(agent.usage).toBeUndefined();
    expect(agent.prompt).toBeUndefined();
    expect(agent.progressSummary).toBeUndefined();
  });

  it("drops a usage object whose every counter is absent", () => {
    const agents = deriveNativeAgents([
      activity(
        "task.started",
        { taskId: "w1", description: "x", subagentType: "Explore", usage: {} },
        "2026-07-29T10:00:00.000Z",
      ),
    ]);
    expect(agents[0]?.usage).toBeUndefined();
  });

  it("excludes backgrounded shells, which arrive on the same task.* channel", () => {
    // Real payloads observed in the wild: Claude Code reports every
    // `Bash run_in_background` call as a task, with no subagentType. Folding
    // these in produced a sidebar row named "Restart the mockup static server"
    // that span forever, because the server never exits.
    expect(
      deriveNativeAgents([
        activity(
          "task.started",
          {
            taskId: "bma53ubju",
            taskType: "local_bash",
            description: "Restart the mockup static server",
            toolUseId: "toolu_1",
          },
          "2026-07-30T07:00:00.000Z",
        ),
      ]),
    ).toEqual([]);
  });

  it("excludes plan tasks", () => {
    expect(
      deriveNativeAgents([
        activity(
          "task.started",
          { taskId: "p1", taskType: "plan", description: "Plan the work" },
          "2026-07-30T07:00:00.000Z",
        ),
      ]),
    ).toEqual([]);
  });

  it("admits a workflow-named run even without a subagent type", () => {
    expect(
      deriveNativeAgents([
        activity(
          "task.started",
          { taskId: "wf1", workflowName: "review-changes", description: "Review" },
          "2026-07-30T07:00:00.000Z",
        ),
      ]),
    ).toMatchObject([{ taskId: "wf1", status: "running" }]);
  });

  it("never admits an unrecognised task id through progress or completion", () => {
    // These two kinds carry no evidence of what kind of task they belong to, so
    // a bash task's completion must not create an entry.
    expect(
      deriveNativeAgents([
        activity(
          "task.progress",
          { taskId: "bt569t33v", toolUseId: "t" },
          "2026-07-30T07:00:00.000Z",
        ),
        activity(
          "task.completed",
          { taskId: "bt569t33v", toolUseId: "t" },
          "2026-07-30T07:00:01.000Z",
        ),
      ]),
    ).toEqual([]);
  });

  it("still tracks a real subagent through progress and completion", () => {
    const agents = deriveNativeAgents([
      activity(
        "task.started",
        { taskId: "w1", subagentType: "Explore", description: "Map handlers", toolUseId: "t" },
        "2026-07-30T07:00:00.000Z",
      ),
      activity(
        "task.progress",
        { taskId: "w1", description: "scanning" },
        "2026-07-30T07:00:10.000Z",
      ),
      activity(
        "task.completed",
        { taskId: "w1", status: "completed", summary: "done" },
        "2026-07-30T07:00:20.000Z",
      ),
    ]);
    expect(agents).toMatchObject([
      { taskId: "w1", status: "finished", description: "Map handlers", resultSummary: "done" },
    ]);
  });

  it("ignores activities that are not in-session agent lifecycle", () => {
    expect(
      deriveNativeAgents([
        activity("tool.progress", { taskId: "w1" }, "2026-07-29T10:00:00.000Z"),
        activity("task.created", { taskThreadId: "t1" }, "2026-07-29T10:00:01.000Z"),
      ]),
    ).toEqual([]);
    expect(isNativeAgentActivityKind("task.started")).toBe(true);
    expect(isNativeAgentActivityKind("task.created")).toBe(false);
  });
});

describe("deriveNativeAgents: the canonical nativeAgent marker", () => {
  it("admits a Codex agent, which labels no subagent type at all", () => {
    // The regression this whole change exists for. Codex names its in-session
    // agents by child thread id and reports no `subagentType` or `workflowName`,
    // so the original evidence rule rejected every one of them and the sidebar
    // stayed empty while three agents ran. The canonical marker is the evidence.
    expect(
      deriveNativeAgents([
        activity(
          "task.started",
          {
            taskId: "01997f3c-child-1",
            taskType: "subagent",
            nativeAgent: true,
            description: "Inspect SidebarV2.tsx",
          },
          "2026-07-30T07:00:00.000Z",
        ),
      ]),
    ).toMatchObject([
      { taskId: "01997f3c-child-1", status: "running", description: "Inspect SidebarV2.tsx" },
    ]);
  });

  it("still refuses an unmarked task on every lifecycle kind", () => {
    // Admitting on progress and completion is what makes out-of-order events
    // work; it must not become a back door for backgrounded shells.
    for (const kind of ["task.started", "task.progress", "task.completed"]) {
      expect(
        deriveNativeAgents([
          activity(
            kind,
            { taskId: "bma53ubju", taskType: "local_bash", description: "Serve the mockups" },
            "2026-07-30T07:00:00.000Z",
          ),
        ]),
      ).toEqual([]);
    }
  });

  it("admits a marked run from a completion that outran its start", () => {
    // A resumed thread, or a dropped start, must still settle rather than leave
    // nothing at all. The completion names the row from what it carries.
    expect(
      deriveNativeAgents([
        activity(
          "task.completed",
          {
            taskId: "child-9",
            status: "completed",
            nativeAgent: true,
            description: "Summarize the contract",
            summary: "12 fields",
          },
          "2026-07-30T07:01:00.000Z",
        ),
      ]),
    ).toMatchObject([
      {
        taskId: "child-9",
        status: "finished",
        description: "Summarize the contract",
        resultSummary: "12 fields",
      },
    ]);
  });

  it("keeps a settled agent settled when its start arrives late", () => {
    const agents = deriveNativeAgents([
      activity(
        "task.completed",
        { taskId: "child-9", status: "failed", nativeAgent: true, error: "worker died" },
        "2026-07-30T07:01:00.000Z",
      ),
      activity(
        "task.started",
        { taskId: "child-9", nativeAgent: true, description: "Summarize the contract" },
        "2026-07-30T07:00:00.000Z",
      ),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      status: "failed",
      errorMessage: "worker died",
      // The start is authoritative for the label and the start time...
      description: "Summarize the contract",
      startedAt: "2026-07-30T07:00:00.000Z",
      // ...but must not drag `updatedAt` backwards behind the completion.
      updatedAt: "2026-07-30T07:01:00.000Z",
    });
  });

  it("fills in a turn id that was not yet known when the agent first appeared", () => {
    const agents = deriveNativeAgents([
      activity(
        "task.started",
        { taskId: "child-1", nativeAgent: true, description: "Inspect" },
        "2026-07-30T07:00:00.000Z",
        null,
      ),
      activity(
        "task.progress",
        { taskId: "child-1", description: "reading", nativeAgent: true },
        "2026-07-30T07:00:10.000Z",
      ),
    ]);
    expect(agents[0]?.turnId).toBe(TURN);
  });

  it("is idempotent across duplicate and repeated events", () => {
    const events = [
      activity(
        "task.started",
        { taskId: "child-1", nativeAgent: true, description: "Inspect" },
        "2026-07-30T07:00:00.000Z",
      ),
      activity(
        "task.completed",
        { taskId: "child-1", status: "completed", nativeAgent: true },
        "2026-07-30T07:00:20.000Z",
      ),
    ];
    expect(deriveNativeAgents([...events, ...events])).toEqual(deriveNativeAgents(events));
  });

  it("settles a stopped agent as finished rather than leaving it running", () => {
    expect(
      deriveNativeAgents([
        activity(
          "task.started",
          { taskId: "child-1", nativeAgent: true, description: "Inspect" },
          "2026-07-30T07:00:00.000Z",
        ),
        activity(
          "task.completed",
          { taskId: "child-1", status: "stopped", nativeAgent: true },
          "2026-07-30T07:00:20.000Z",
        ),
      ]),
    ).toMatchObject([{ taskId: "child-1", status: "finished" }]);
  });
});

describe("deriveNativeAgents: providers converge on equivalent state", () => {
  // Claude and Codex report the same three-agent fan-out through different
  // events, and the sidebar reads one shape. These fixtures are the two real
  // sequences; the assertion is that the derived rows agree on everything the
  // provider actually reported.
  const CLAUDE_SEQUENCE = (index: number) => [
    activity(
      "task.started",
      {
        taskId: `claude-${index}`,
        taskType: "agent",
        subagentType: "Explore",
        nativeAgent: true,
        description: `Inspect target ${index}`,
        toolUseId: `toolu_${index}`,
      },
      `2026-07-30T07:00:0${index}.000Z`,
    ),
    activity(
      "task.progress",
      {
        taskId: `claude-${index}`,
        description: "reading files",
        summary: "reading files",
        subagentType: "Explore",
        nativeAgent: true,
      },
      `2026-07-30T07:00:1${index}.000Z`,
    ),
    activity(
      "task.completed",
      {
        taskId: `claude-${index}`,
        status: "completed",
        nativeAgent: true,
        subagentType: "Explore",
        description: `Inspect target ${index}`,
      },
      `2026-07-30T07:00:2${index}.000Z`,
    ),
  ];

  const CODEX_SEQUENCE = (index: number) => [
    activity(
      "task.started",
      {
        taskId: `codex-${index}`,
        taskType: "subagent",
        nativeAgent: true,
        description: `Inspect target ${index}`,
      },
      `2026-07-30T07:00:0${index}.000Z`,
    ),
    activity(
      "task.progress",
      {
        taskId: `codex-${index}`,
        description: "reading files",
        summary: "reading files",
        nativeAgent: true,
      },
      `2026-07-30T07:00:1${index}.000Z`,
    ),
    activity(
      "task.completed",
      { taskId: `codex-${index}`, status: "completed", nativeAgent: true },
      `2026-07-30T07:00:2${index}.000Z`,
    ),
  ];

  it.each([
    { provider: "claude", sequence: CLAUDE_SEQUENCE, prefix: "claude" },
    { provider: "codex", sequence: CODEX_SEQUENCE, prefix: "codex" },
  ])("$provider: three parallel agents all reach a terminal state", ({ sequence, prefix }) => {
    const agents = deriveNativeAgents([1, 2, 3].flatMap((index) => sequence(index)));

    expect(agents).toHaveLength(3);
    expect(agents.map((agent) => agent.taskId)).toEqual([
      `${prefix}-1`,
      `${prefix}-2`,
      `${prefix}-3`,
    ]);
    for (const agent of agents) {
      expect(agent.status).toBe("finished");
      expect(agent.turnId).toBe(TURN);
      expect(agent.progressSummary).toBe("reading files");
      expect(agent.description).toMatch(/^Inspect target [123]$/);
    }
  });

  it("shows all three as running before any of them finishes", () => {
    for (const sequence of [CLAUDE_SEQUENCE, CODEX_SEQUENCE]) {
      const agents = deriveNativeAgents([1, 2, 3].flatMap((index) => sequence(index).slice(0, 1)));
      expect(agents).toHaveLength(3);
      expect(agents.every((agent) => agent.status === "running")).toBe(true);
    }
  });

  it("reports no counters when the provider reported none, rather than zeros", () => {
    const agents = deriveNativeAgents(CODEX_SEQUENCE(1));
    expect(agents[0]?.usage).toBeUndefined();
    expect(agents[0]?.subagentType).toBeUndefined();
    expect(agents[0]?.lastToolName).toBeUndefined();
  });
});

describe("selectVisibleNativeAgents", () => {
  const agent = (taskId: string, status: "running" | "finished", at: string) => ({
    taskId,
    turnId: TURN,
    status,
    description: taskId,
    startedAt: at,
    updatedAt: at,
  });

  it("keeps every running agent regardless of the history limit", () => {
    const agents = [
      agent("r1", "running", "2026-07-29T10:00:00.000Z"),
      agent("r2", "running", "2026-07-29T10:00:01.000Z"),
      agent("f1", "finished", "2026-07-29T09:00:00.000Z"),
      agent("f2", "finished", "2026-07-29T09:30:00.000Z"),
    ];
    const visible = selectVisibleNativeAgents(agents, 1);
    expect(visible.map((a) => a.taskId)).toEqual(["f2", "r1", "r2"]);
  });

  it("keeps the newest finished agents and orders the result chronologically", () => {
    const agents = [
      agent("f1", "finished", "2026-07-29T09:00:00.000Z"),
      agent("f2", "finished", "2026-07-29T09:30:00.000Z"),
      agent("f3", "finished", "2026-07-29T09:45:00.000Z"),
    ];
    expect(selectVisibleNativeAgents(agents, 2).map((a) => a.taskId)).toEqual(["f2", "f3"]);
  });
});
