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
