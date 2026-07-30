import { TurnId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type {
  WorkflowActivityModel,
  WorkflowActivityStep,
  WorkflowActivityWorker,
  WorkflowRecentTool,
} from "../workflow-activity";
import {
  WorkflowActivityCard,
  deriveUsageMetricSegments,
  deriveWorkflowCardTitle,
  deriveWorkflowEmptyWorkersMessage,
  deriveWorkflowSelectionGroups,
  deriveWorkflowStepCounter,
} from "./WorkflowActivityCard";

const TURN_ID = TurnId.make("turn-1");

function makeWorker(overrides: Partial<WorkflowActivityWorker> = {}): WorkflowActivityWorker {
  return Object.assign(
    {
      id: "task-1",
      taskId: "task-1",
      turnId: TURN_ID,
      startedAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:01:00.000Z",
      status: "inProgress",
    } satisfies WorkflowActivityWorker,
    overrides,
  );
}

function makeStep(overrides: Partial<WorkflowActivityStep> = {}): WorkflowActivityStep {
  return Object.assign(
    {
      id: "turn-1:step:0",
      index: 0,
      label: "Scan the repository",
      status: "completed",
      sourcePlanActivityId: "plan-activity-1",
      workers: [],
    } satisfies WorkflowActivityStep,
    overrides,
  );
}

function makeRecentTool(overrides: Partial<WorkflowRecentTool> = {}): WorkflowRecentTool {
  return Object.assign(
    {
      id: "tool:toolu_1",
      activityId: "activity-tool-1",
      createdAt: "2026-07-19T00:00:30.000Z",
      status: "inProgress",
      toolUseId: "toolu_1",
      toolName: "Bash",
      summary: "pnpm test",
    } satisfies WorkflowRecentTool,
    overrides,
  );
}

function makeModel(overrides: Partial<WorkflowActivityModel> = {}): WorkflowActivityModel {
  return Object.assign(
    {
      turnId: TURN_ID,
      steps: [],
      historicalSteps: [],
      otherActivity: null,
      workers: [],
      recentTools: [],
    } satisfies WorkflowActivityModel,
    overrides,
  );
}

function makePlanModel(): WorkflowActivityModel {
  const stepOneWorkers = [
    makeWorker({ id: "task-a", taskId: "task-a", description: "Map the codebase" }),
    makeWorker({
      id: "task-b",
      taskId: "task-b",
      description: "Sweep ambient caches",
      skipTranscript: true,
      status: "completed",
    }),
  ];
  return makeModel({
    steps: [
      makeStep({ id: "turn-1:step:0", index: 0, label: "Alpha", status: "completed" }),
      makeStep({
        id: "turn-1:step:1",
        index: 1,
        label: "Beta",
        status: "inProgress",
        workers: stepOneWorkers,
      }),
      makeStep({ id: "turn-1:step:2", index: 2, label: "Gamma", status: "pending" }),
    ],
    workers: stepOneWorkers,
  });
}

describe("deriveWorkflowSelectionGroups", () => {
  it("orders current steps, then historical steps, then other activity", () => {
    const model = makePlanModel();
    model.historicalSteps.push(
      makeStep({
        id: "turn-1:step:0:plan:legacy",
        label: "Alpha (old plan)",
        historical: true,
        workers: [makeWorker({ id: "task-old", taskId: "task-old" })],
      }),
    );
    model.otherActivity = {
      id: "turn-1:other-activity",
      label: "Other activity",
      workers: [makeWorker({ id: "task-free", taskId: "task-free" })],
    };

    const groups = deriveWorkflowSelectionGroups(model);

    expect(groups.map((group) => group.id)).toEqual([
      "turn-1:step:0",
      "turn-1:step:1",
      "turn-1:step:2",
      "turn-1:step:0:plan:legacy",
      "turn-1:other-activity",
    ]);
    expect(groups[3]?.historical).toBe(true);
    expect(groups[4]?.status).toBeUndefined();
  });

  it("omits an empty other-activity group", () => {
    const groups = deriveWorkflowSelectionGroups(makePlanModel());
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.id !== "turn-1:other-activity")).toBe(true);
  });

  it("surfaces unassociated workers on the active step", () => {
    const model = makePlanModel();
    const worker = makeWorker({ id: "task-free", taskId: "task-free" });
    model.otherActivity = {
      id: "turn-1:other-activity",
      label: "Other activity",
      workers: [worker],
    };

    const groups = deriveWorkflowSelectionGroups(model);

    expect(groups.find((group) => group.id === "turn-1:step:1")?.workers).toContain(worker);
    expect(groups.some((group) => group.id === "turn-1:other-activity")).toBe(true);
  });

  it("keeps unassociated workers separate when no plan step is active", () => {
    const model = makePlanModel();
    model.steps = model.steps.map((step) => ({ ...step, status: "completed" }));
    model.otherActivity = {
      id: "turn-1:other-activity",
      label: "Other activity",
      workers: [makeWorker({ id: "task-free", taskId: "task-free" })],
    };

    const groups = deriveWorkflowSelectionGroups(model);
    expect(groups.at(-1)?.id).toBe("turn-1:other-activity");
  });
});

describe("deriveWorkflowEmptyWorkersMessage", () => {
  it("uses settled copy for completed steps and provisional copy otherwise", () => {
    expect(deriveWorkflowEmptyWorkersMessage("completed")).toBe(
      "No workers were used for this step.",
    );
    expect(deriveWorkflowEmptyWorkersMessage("inProgress")).toBe("No workers for this step yet.");
    expect(deriveWorkflowEmptyWorkersMessage("pending")).toBe("No workers for this step yet.");
    expect(deriveWorkflowEmptyWorkersMessage(undefined)).toBe("No workers for this step yet.");
  });
});

describe("deriveWorkflowStepCounter", () => {
  it("reports the active step position while a step is in progress", () => {
    expect(
      deriveWorkflowStepCounter([
        { status: "completed" },
        { status: "inProgress" },
        { status: "pending" },
        { status: "pending" },
      ]),
    ).toBe("Step 2 of 4");
  });

  it("falls back to a completion tally when no step is active", () => {
    expect(
      deriveWorkflowStepCounter([
        { status: "completed" },
        { status: "completed" },
        { status: "pending" },
      ]),
    ).toBe("2 of 3 complete");
  });
});

describe("usage metric segments", () => {
  it("formats only the values the provider supplied", () => {
    expect(deriveUsageMetricSegments({ totalTokens: 1500, toolUses: 2, durationMs: 2500 })).toEqual(
      [
        { id: "tokens", text: "1.5k tokens" },
        { id: "tools", text: "2 tools" },
        { id: "duration", text: "2.5s" },
      ],
    );
    expect(deriveUsageMetricSegments({ toolUses: 1 })).toEqual([{ id: "tools", text: "1 tool" }]);
    expect(deriveUsageMetricSegments({})).toEqual([]);
  });
});

describe("deriveWorkflowCardTitle", () => {
  // A card listing workers is a workflow whether or not a plan came with it —
  // "Activity" is only for a card that has neither.
  it("titles any card with workers a Workflow, and a bare one Activity", () => {
    expect(deriveWorkflowCardTitle(makeModel({ workers: [makeWorker()] }))).toBe("Workflow");
    expect(deriveWorkflowCardTitle(makePlanModel())).toBe("Workflow");
    expect(deriveWorkflowCardTitle(makeModel({ workers: [] }))).toBe("Activity");
  });

  it("prefers the provider-supplied workflow name", () => {
    const model = makePlanModel();
    model.workers.push(
      makeWorker({ id: "task-named", taskId: "task-named", workflowName: "Deploy flow" }),
    );
    expect(deriveWorkflowCardTitle(model)).toBe("Deploy flow");
  });
});

describe("WorkflowActivityCard rendering", () => {
  it("renders nothing when the model has no meaningful activity", () => {
    const markup = renderToStaticMarkup(<WorkflowActivityCard model={makeModel()} />);
    expect(markup).toBe("");
  });

  it("always renders expanded with a stable fixed-height, internally scrolling box", () => {
    const model = makeModel({
      workers: [makeWorker({ description: "Background investigation" })],
      totalUsage: { totalTokens: 1_500, toolUses: 2 },
    });

    const markup = renderToStaticMarkup(<WorkflowActivityCard model={model} />);
    expect(markup).toContain('data-slot="workflow-activity-card"');
    expect(markup).toContain('data-workflow-activity-turn-id="turn-1"');
    expect(markup).toContain('data-slot="workflow-activity-details"');
    // The outer box is fixed at the height cap; content scrolls inside it.
    expect(markup).toContain("height:min(26rem, 55vh)");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("overscroll-contain");
    // Header carries the aggregate metrics and worker count.
    expect(markup).toContain("1.5k tokens");
    expect(markup).toContain("2 tools");
    expect(markup).toContain("1 worker");
    // Workers mount without any disclosure interaction.
    expect(markup).toContain("Background investigation");
  });

  it("renders plan steps in order with counter, strip, and every group's workers mounted", () => {
    const markup = renderToStaticMarkup(<WorkflowActivityCard model={makePlanModel()} />);

    expect(markup).toContain('aria-label="Workflow activity"');
    expect(markup.indexOf("Alpha")).toBeLessThan(markup.indexOf("Beta"));
    expect(markup.indexOf("Beta")).toBeLessThan(markup.indexOf("Gamma"));
    expect(markup).toContain("Step 2 of 3");
    expect(markup).toContain("2 workers");
    expect(markup.match(/data-slot="workflow-step-strip-segment"/g)).toHaveLength(3);
    // Every group's workers render without a selection interaction so sidebar
    // jumps can locate any of them.
    expect(markup).toContain("Map the codebase");
    expect(markup).toContain("Sweep ambient caches");
    expect(markup).toContain('data-native-agent-task-id="task-a"');
    expect(markup).toContain('data-native-agent-task-id="task-b"');
    // Worker-less steps say so inline instead of hiding behind a toggle.
    expect(markup).toContain("No workers were used for this step.");
    expect(markup).toContain("No workers for this step yet.");
    // Screen-reader status labeling rides on the step headers.
    expect(markup).toContain("(In progress)");
  });

  it("renders plan-less worker activity under the Workflow heading", () => {
    const model = makeModel({
      workers: [makeWorker({ description: "Unplanned investigation", status: "completed" })],
    });
    const markup = renderToStaticMarkup(<WorkflowActivityCard model={model} />);

    expect(markup).toContain('aria-label="Task activity"');
    expect(markup).toContain(">Workflow</p>");
    expect(markup).toContain("Unplanned investigation");
    expect(markup).toContain("Completed");
    expect(markup).not.toContain("workflow-step-strip-segment");
  });

  it("renders only the metrics a worker actually has, without placeholders", () => {
    const withMetrics = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({
          workers: [
            makeWorker({
              description: "Measured worker",
              usage: { totalTokens: 1500, toolUses: 2, durationMs: 2500 },
              lastToolName: "Bash",
            }),
          ],
        })}
      />,
    );
    expect(withMetrics).toContain("1.5k tokens");
    expect(withMetrics).toContain("2 tools");
    expect(withMetrics).toContain("2.5s");
    expect(withMetrics).toContain("Last: Bash");

    const withoutMetrics = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({ workers: [makeWorker({ description: "Bare worker" })] })}
      />,
    );
    expect(withoutMetrics).toContain("Bare worker");
    expect(withoutMetrics).not.toContain("tokens");
    expect(withoutMetrics).not.toContain("Last:");
    expect(withoutMetrics).not.toContain(">·<");
  });

  it("keeps skipTranscript workers in the card", () => {
    const markup = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({
          workers: [makeWorker({ description: "Ambient sweep", skipTranscript: true })],
        })}
      />,
    );
    expect(markup).toContain("Ambient sweep");
  });

  it("escapes provider-supplied text", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const markup = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({ workers: [makeWorker({ description: payload })] })}
      />,
    );
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).not.toContain("<img src=x");
  });

  // A worker reads as one row: status icon, name, its latest line, then the
  // status word and its own usage. The summary is shown rather than hidden
  // behind a "Result" disclosure, and no worker is boxed — five of those read as
  // five competing cards rather than one list.
  it("shows a completed worker's result inline with its status word", () => {
    const markup = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({
          workers: [
            makeWorker({
              description: "Finished worker",
              status: "completed",
              resultSummary: "Found 3 issues",
              outputFile: "/tmp/review-output.md",
            }),
          ],
        })}
      />,
    );
    expect(markup).toContain("Found 3 issues");
    expect(markup).toContain(">Completed<");
    expect(markup).toContain("/tmp/review-output.md");
    // The old presentation's affordances are gone.
    expect(markup).not.toContain('data-slot="workflow-worker-result-toggle"');
    expect(markup).not.toContain("Output:");
  });

  it("prefers the result over the progress line it superseded", () => {
    const markup = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({
          workers: [
            makeWorker({
              description: "Finished worker",
              status: "completed",
              progressSummary: "Read the relevant source files.",
              resultSummary: "Produced the final report.",
            }),
          ],
        })}
      />,
    );
    expect(markup).toContain("Produced the final report.");
    expect(markup).not.toContain("Read the relevant source files.");
  });

  it("shows an error over a result, and names both sides of a retry", () => {
    const markup = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({
          workers: [
            makeWorker({
              id: "task-old",
              taskId: "task-old",
              status: "failed",
              errorMessage: "Worker connection closed unexpectedly.",
              retriedByTaskId: "task-new",
            }),
            makeWorker({
              id: "task-new",
              taskId: "task-new",
              status: "completed",
              retryOfTaskId: "task-old",
              resultSummary: "Retry completed successfully.",
            }),
          ],
        })}
      />,
    );

    expect(markup).toContain("Worker connection closed unexpectedly.");
    expect(markup).toContain(">Failed<");
    // The retry is described where the reader is looking, not as a separate
    // line referencing an opaque task id.
    expect(markup).toContain("Retried below");
    expect(markup).toContain("Retry of the failed run");
    expect(markup).toContain("Retry completed successfully.");
  });

  it("falls back to the progress line while a worker is still running", () => {
    const running = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({
          workers: [
            makeWorker({
              description: "Chatty worker",
              status: "inProgress",
              progressSummary: "Halfway there",
              lastToolName: "Grep",
            }),
          ],
        })}
      />,
    );
    expect(running).toContain("Halfway there");
    expect(running).toContain("Last: Grep");
    expect(running).toContain(">Running<");

    const quiet = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({ workers: [makeWorker({ description: "Quiet worker" })] })}
      />,
    );
    expect(quiet).toContain("Quiet worker");
    expect(quiet).not.toContain(">Progress</span>");
  });

  it("collapses the reasoning disclosure by default and omits it without content", () => {
    const withReasoning = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({
          workers: [makeWorker()],
          reasoningSummary: "Provider reasoning trace",
        })}
      />,
    );
    expect(withReasoning).toContain(">Reasoning</span>");
    expect(withReasoning).toContain('aria-expanded="false"');
    expect(withReasoning).not.toContain("Provider reasoning trace");

    const withoutReasoning = renderToStaticMarkup(
      <WorkflowActivityCard model={makeModel({ workers: [makeWorker()] })} />,
    );
    expect(withoutReasoning).not.toContain(">Reasoning</span>");
  });

  it("renders compact recent tool rows and preserves linked vs unlinked status", () => {
    const markup = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({
          workers: [makeWorker()],
          recentTools: [
            makeRecentTool({ id: "tool:linked", taskId: "task-1", elapsedSeconds: 90 }),
            makeRecentTool({
              id: "tool:unlinked",
              toolUseId: "toolu_2",
              toolName: "Read",
              summary: "src/index.ts",
              parentToolUseId: null,
            }),
          ],
        })}
      />,
    );

    expect(markup.match(/data-slot="workflow-recent-tool"/g)).toHaveLength(2);
    // Exactly one row carries the linked-task badge.
    expect(markup.match(/>task</g)).toHaveLength(1);
    expect(markup).toContain("1m 30s");
    expect(markup).toContain("src/index.ts");
    // Compact rows only — never full-size tool cards.
    expect(markup).not.toContain('data-slot="tool-card"');
  });

  it("renders terminal recent-tool labels without leaving terminal spinners running", () => {
    const markup = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({
          recentTools: [
            makeRecentTool({ id: "tool:running", status: "inProgress" }),
            makeRecentTool({ id: "tool:completed", status: "completed" }),
            makeRecentTool({ id: "tool:failed", status: "failed" }),
            makeRecentTool({ id: "tool:declined", status: "declined" }),
            makeRecentTool({ id: "tool:stopped", status: "stopped" }),
          ],
        })}
      />,
    );

    expect(markup.match(/data-slot="workflow-recent-tool"/g)).toHaveLength(5);
    for (const label of ["Running", "Completed", "Failed", "Declined", "Stopped"]) {
      expect(markup).toContain(`aria-label="${label}"`);
      expect(markup).toContain(label);
    }
    expect(markup.match(/animate-spin/g)).toHaveLength(1);
  });

  it("labels historical steps and the other-activity group", () => {
    const model = makePlanModel();
    model.historicalSteps.push(
      makeStep({
        id: "turn-1:step:0:plan:legacy",
        label: "Alpha (old plan)",
        historical: true,
        workers: [makeWorker({ id: "task-old", taskId: "task-old" })],
      }),
    );
    model.otherActivity = {
      id: "turn-1:other-activity",
      label: "Other activity",
      workers: [makeWorker({ id: "task-free", taskId: "task-free" })],
    };

    const markup = renderToStaticMarkup(<WorkflowActivityCard model={model} />);

    expect(markup).toContain("Alpha (old plan)");
    expect(markup).toContain("earlier plan");
    expect(markup).toContain("Other activity");
  });

  it("keeps worker rows and detail regions inside the card's own scroll", () => {
    const markup = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({ workers: [makeWorker({ description: "Tall worker" })] })}
      />,
    );
    expect(markup).toContain('data-slot="workflow-worker-list"');
    // Exactly one height bound, on the card itself: it hugs its rows up to the
    // cap, and its single internal scroller takes over past that. A second bound
    // further in would give the card two things fighting over the same overflow.
    expect(markup.split("max-height:min(26rem, 55vh)").length - 1).toBe(1);
    const detailsStart = markup.indexOf('data-slot="workflow-activity-details"');
    const workerListStart = markup.indexOf('data-slot="workflow-worker-list"');
    expect(detailsStart).toBeGreaterThan(-1);
    expect(workerListStart).toBeGreaterThan(detailsStart);
  });
});
