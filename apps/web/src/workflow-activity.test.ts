import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { MAX_RECENT_WORKFLOW_TOOLS, deriveWorkflowActivityModel } from "./workflow-activity";

let nextActivityId = 0;

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind: string;
  payload?: Record<string, unknown>;
  sequence?: number;
  summary?: string;
  turnId?: string | null;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(overrides.id ?? `workflow-activity-${nextActivityId++}`),
    createdAt: overrides.createdAt ?? "2026-07-19T00:00:00.000Z",
    kind: overrides.kind,
    payload: overrides.payload ?? {},
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
    summary: overrides.summary ?? overrides.kind,
    tone: overrides.kind === "tool.progress" ? "tool" : "info",
    turnId: overrides.turnId === null ? null : TurnId.make(overrides.turnId ?? "turn-current"),
  };
}

describe("deriveWorkflowActivityModel", () => {
  it("is strictly scoped to the requested turn and never inherits an older plan", () => {
    const model = deriveWorkflowActivityModel(
      [
        makeActivity({
          id: "old-plan",
          turnId: "turn-old",
          sequence: 1,
          kind: "turn.plan.updated",
          payload: {
            plan: [{ step: "Old step", status: "inProgress" }],
          },
        }),
        makeActivity({
          id: "old-task",
          turnId: "turn-old",
          sequence: 2,
          kind: "task.started",
          payload: { taskId: "old-worker" },
        }),
        makeActivity({
          id: "current-task",
          turnId: "turn-current",
          sequence: 3,
          kind: "task.started",
          payload: {
            taskId: "current-worker",
            taskType: "agent",
            skipTranscript: true,
          },
        }),
      ],
      TurnId.make("turn-current"),
    );

    expect(model).not.toBeNull();
    expect(model?.steps).toEqual([]);
    expect(model?.historicalSteps).toEqual([]);
    expect(model?.workers).toMatchObject([
      {
        taskId: "current-worker",
        taskType: "agent",
        skipTranscript: true,
        status: "inProgress",
      },
    ]);
    expect(model?.otherActivity?.workers.map((worker) => worker.taskId)).toEqual([
      "current-worker",
    ]);
  });

  it("returns no card when the active turn has no meaningful workflow content", () => {
    expect(
      deriveWorkflowActivityModel(
        [
          makeActivity({
            kind: "tool.completed",
            summary: "Ordinary transcript tool",
            payload: { toolCallId: "ordinary" },
          }),
        ],
        TurnId.make("turn-current"),
      ),
    ).toBeNull();
    expect(deriveWorkflowActivityModel([], TurnId.make("turn-current"))).toBeNull();
    expect(deriveWorkflowActivityModel([], null)).toBeNull();
  });

  it("associates at the first lifecycle event using the first active step and stable indices", () => {
    const activities = [
      makeActivity({
        id: "plan-initial",
        sequence: 10,
        createdAt: "2026-07-19T00:00:10.000Z",
        kind: "turn.plan.updated",
        payload: {
          plan: [
            { step: "Duplicate", status: "pending" },
            { step: "Duplicate", status: "inProgress" },
            { step: "Third", status: "inProgress" },
          ],
        },
      }),
      makeActivity({
        id: "task-a-start",
        sequence: 11,
        createdAt: "2026-07-19T00:00:01.000Z",
        kind: "task.started",
        payload: { taskId: "task-a" },
      }),
      makeActivity({
        id: "plan-later",
        sequence: 12,
        createdAt: "2026-07-19T00:00:02.000Z",
        kind: "turn.plan.updated",
        payload: {
          plan: [
            { step: "Duplicate", status: "completed" },
            { step: "Duplicate", status: "completed" },
            { step: "Third", status: "inProgress" },
          ],
        },
      }),
      makeActivity({
        id: "task-b-progress-no-start",
        sequence: 13,
        createdAt: "2026-07-19T00:00:03.000Z",
        kind: "task.progress",
        payload: {
          taskId: "task-b",
          description: "Working on the third step",
        },
      }),
      makeActivity({
        id: "plan-no-active",
        sequence: 14,
        kind: "turn.plan.updated",
        payload: {
          plan: [
            { step: "Duplicate", status: "completed" },
            { step: "Duplicate", status: "pending" },
            { step: "Third", status: "pending" },
          ],
        },
      }),
      makeActivity({
        id: "task-c-start",
        sequence: 15,
        kind: "task.started",
        payload: { taskId: "task-c" },
      }),
    ];

    const canonical = deriveWorkflowActivityModel(activities, TurnId.make("turn-current"));
    const shuffled = deriveWorkflowActivityModel(
      [
        activities[4]!,
        activities[1]!,
        activities[5]!,
        activities[0]!,
        activities[3]!,
        activities[2]!,
      ],
      TurnId.make("turn-current"),
    );

    expect(shuffled).toEqual(canonical);
    expect(canonical?.workers).toMatchObject([
      {
        taskId: "task-a",
        stepId: "turn-current:step:1",
        stepIndex: 1,
        stepLabel: "Duplicate",
        startPlanActivityId: "plan-initial",
        startPlanSequence: 10,
      },
      {
        taskId: "task-b",
        stepId: "turn-current:step:2",
        stepIndex: 2,
        stepLabel: "Third",
        startPlanActivityId: "plan-later",
        startPlanSequence: 12,
      },
      {
        taskId: "task-c",
      },
    ]);
    expect(canonical?.workers[2]).not.toHaveProperty("stepId");
    expect(canonical?.otherActivity?.workers.map((worker) => worker.taskId)).toEqual(["task-c"]);
    expect(canonical?.steps.map((step) => step.id)).toEqual([
      "turn-current:step:0",
      "turn-current:step:1",
      "turn-current:step:2",
    ]);
  });

  it("does not reassign a worker when a later plan renames or removes its start step", () => {
    const model = deriveWorkflowActivityModel(
      [
        makeActivity({
          id: "plan-before-task",
          sequence: 100,
          kind: "turn.plan.updated",
          payload: {
            plan: [
              { step: "Inspect repository", status: "inProgress" },
              { step: "Implement adapter", status: "pending" },
            ],
          },
        }),
        makeActivity({
          id: "task-start",
          sequence: 110,
          kind: "task.started",
          payload: { taskId: "task-alpha" },
        }),
        makeActivity({
          id: "plan-after-task",
          sequence: 120,
          kind: "turn.plan.updated",
          payload: {
            plan: [
              { step: "Run checks", status: "pending" },
              { step: "Implement adapter and ingestion", status: "inProgress" },
            ],
          },
        }),
        makeActivity({
          id: "task-complete",
          sequence: 130,
          kind: "task.completed",
          payload: { taskId: "task-alpha", status: "completed" },
        }),
      ],
      TurnId.make("turn-current"),
    );

    expect(model?.steps.flatMap((step) => step.workers)).toEqual([]);
    expect(model?.historicalSteps).toMatchObject([
      {
        index: 0,
        label: "Inspect repository",
        sourcePlanActivityId: "plan-before-task",
        historical: true,
        workers: [{ taskId: "task-alpha", status: "completed" }],
      },
    ]);
    expect(model?.historicalSteps[0]?.id).not.toContain("Inspect repository");
  });

  it("uses each task's latest valid usage snapshot without merging partial counters", () => {
    const model = deriveWorkflowActivityModel(
      [
        makeActivity({
          id: "task-a-progress",
          sequence: 1,
          kind: "task.progress",
          payload: {
            taskId: "task-a",
            description: "Task A",
            usage: { totalTokens: 100, toolUses: 4, durationMs: 20 },
          },
        }),
        makeActivity({
          id: "task-b-progress",
          sequence: 2,
          kind: "task.progress",
          payload: {
            taskId: "task-b",
            description: "Task B",
            usage: { total_tokens: 5, tool_uses: 2 },
          },
        }),
        makeActivity({
          id: "task-a-complete",
          sequence: 3,
          kind: "task.completed",
          payload: {
            taskId: "task-a",
            status: "completed",
            usage: { duration_ms: 30 },
          },
        }),
        makeActivity({
          id: "task-b-invalid-usage",
          sequence: 4,
          kind: "task.progress",
          payload: {
            taskId: "task-b",
            description: "Task B",
            usage: { totalTokens: -1, toolUses: 1.5 },
          },
        }),
      ],
      TurnId.make("turn-current"),
    );

    expect(model?.workers).toMatchObject([
      { taskId: "task-a", usage: { durationMs: 30 } },
      { taskId: "task-b", usage: { totalTokens: 5, toolUses: 2 } },
    ]);
    expect(model?.workers[0]?.usage).not.toHaveProperty("totalTokens");
    expect(model?.workers[0]?.usage).not.toHaveProperty("toolUses");
    expect(model?.totalUsage).toEqual({ totalTokens: 5, toolUses: 2, durationMs: 30 });
  });

  it("keeps worker progress separate from explicitly displayable turn reasoning", () => {
    const model = deriveWorkflowActivityModel(
      [
        makeActivity({
          id: "task-progress",
          sequence: 1,
          kind: "task.progress",
          payload: {
            taskId: "task-a",
            description: "Reviewing",
            summary: "Checked the reducer paths",
          },
        }),
        makeActivity({
          id: "unsafe-lookalike",
          sequence: 2,
          kind: "content.delta",
          payload: {
            streamKind: "reasoning_text",
            reasoningSummary: "Raw thinking must not be used",
          },
        }),
        makeActivity({
          id: "reasoning-summary",
          sequence: 3,
          kind: "turn.reasoning.summary",
          payload: { reasoningSummary: " Compared the replay paths. " },
        }),
      ],
      TurnId.make("turn-current"),
    );

    expect(model?.workers[0]?.progressSummary).toBe("Checked the reducer paths");
    expect(model?.reasoningSummary).toBe("Compared the replay paths.");

    const withoutReasoning = deriveWorkflowActivityModel(
      [
        makeActivity({
          kind: "task.progress",
          payload: { taskId: "task-a", description: "Reviewing", summary: "Worker progress" },
        }),
        makeActivity({
          kind: "turn.reasoning.summary",
          payload: { reasoningSummary: "   " },
        }),
      ],
      TurnId.make("turn-current"),
    );
    expect(withoutReasoning).not.toHaveProperty("reasoningSummary");
  });

  it("coalesces recent tools by tool-use id, retains task correlation, and bounds afterward", () => {
    const activities: OrchestrationThreadActivity[] = [];
    for (let index = 0; index < MAX_RECENT_WORKFLOW_TOOLS + 2; index += 1) {
      activities.push(
        makeActivity({
          id: `tool-${index}-first`,
          sequence: index + 1,
          createdAt: `2026-07-19T00:00:${String(59 - index).padStart(2, "0")}.000Z`,
          kind: "tool.progress",
          payload: {
            toolUseId: `tool-${index}`,
            toolName: "Read",
            summary: `Tool ${index}`,
            elapsedSeconds: index,
            ...(index === 0 ? { taskId: "task-a", parentToolUseId: null } : {}),
          },
        }),
      );
    }
    activities.push(
      makeActivity({
        id: "tool-0-latest",
        sequence: MAX_RECENT_WORKFLOW_TOOLS + 3,
        createdAt: "2026-07-19T00:00:00.000Z",
        kind: "tool.progress",
        payload: {
          toolUseId: "tool-0",
          summary: "Tool zero updated",
          elapsedSeconds: 99,
        },
      }),
    );

    const canonical = deriveWorkflowActivityModel(activities, TurnId.make("turn-current"));
    const shuffled = deriveWorkflowActivityModel(
      [activities.at(-1)!, ...activities.slice(0, -1).toReversed()],
      TurnId.make("turn-current"),
    );

    expect(shuffled?.recentTools).toEqual(canonical?.recentTools);
    expect(canonical?.recentTools).toHaveLength(MAX_RECENT_WORKFLOW_TOOLS);
    expect(new Set(canonical?.recentTools.map((tool) => tool.toolUseId)).size).toBe(
      MAX_RECENT_WORKFLOW_TOOLS,
    );
    expect(canonical?.recentTools.at(-1)).toMatchObject({
      id: "tool:tool-0",
      activityId: "tool-0-latest",
      toolUseId: "tool-0",
      parentToolUseId: null,
      taskId: "task-a",
      toolName: "Read",
      summary: "Tool zero updated",
      elapsedSeconds: 99,
    });
  });

  it("orders legacy unsequenced tool progress deterministically by timestamp and id", () => {
    const a = makeActivity({
      id: "legacy-a",
      createdAt: "2026-07-19T00:00:00.000Z",
      kind: "tool.progress",
      payload: { summary: "A" },
    });
    const b = makeActivity({
      id: "legacy-b",
      createdAt: "2026-07-19T00:00:00.000Z",
      kind: "tool.progress",
      payload: { summary: "B" },
    });

    expect(
      deriveWorkflowActivityModel([b, a], TurnId.make("turn-current"))?.recentTools.map(
        (tool) => tool.activityId,
      ),
    ).toEqual(["legacy-a", "legacy-b"]);
  });
});
