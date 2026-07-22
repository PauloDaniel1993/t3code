import { TurnId } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type {
  WorkflowActivityModel,
  WorkflowActivityStep,
  WorkflowActivityWorker,
  WorkflowRecentTool,
} from "../workflow-activity";
import {
  WorkflowActivityCard as WorkflowActivityCardComponent,
  deriveUsageMetricSegments,
  deriveWorkflowCardTitle,
  deriveWorkflowSelectionGroups,
  deriveWorkflowStepCounter,
  deriveWorkerMetricSegments,
  resolveNextWorkflowStepSelection,
  resolveSelectedWorkflowGroup,
  resolveTurnScopedSelectedStepId,
} from "./WorkflowActivityCard";

// Detail-focused rendering tests initialize the outer disclosure open. Tests
// for the production default use WorkflowActivityCardComponent directly.
function WorkflowActivityCard(props: ComponentProps<typeof WorkflowActivityCardComponent>) {
  return <WorkflowActivityCardComponent defaultOpen {...props} />;
}

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
});

describe("workflow step selection", () => {
  it("opens a closed step, collapses the open step, and switches to another step", () => {
    expect(resolveNextWorkflowStepSelection(null, "step-a")).toBe("step-a");
    expect(resolveNextWorkflowStepSelection("step-a", "step-a")).toBeNull();
    expect(resolveNextWorkflowStepSelection("step-a", "step-b")).toBe("step-b");
  });

  it("collapses a stale selection when the step vanishes from a replaced plan", () => {
    const groups = deriveWorkflowSelectionGroups(makePlanModel());
    expect(resolveSelectedWorkflowGroup(groups, "turn-1:step:1")?.label).toBe("Beta");
    expect(resolveSelectedWorkflowGroup(groups, "turn-9:step:0")).toBeNull();
    expect(resolveSelectedWorkflowGroup(groups, null)).toBeNull();
  });

  it("scopes selection to the turn it was made under so a new turn resets it", () => {
    const selection = { turnId: "turn-1", stepId: "turn-1:step:1" };
    expect(resolveTurnScopedSelectedStepId(selection, "turn-1")).toBe("turn-1:step:1");
    expect(resolveTurnScopedSelectedStepId(selection, "turn-2")).toBeNull();
    expect(resolveTurnScopedSelectedStepId(null, "turn-1")).toBeNull();
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

  it("appends the last tool to worker metrics when present", () => {
    expect(
      deriveWorkerMetricSegments({
        usage: { totalTokens: 950 },
        lastToolName: "Bash",
      }),
    ).toEqual([
      { id: "tokens", text: "950 tokens" },
      { id: "lastTool", text: "Last: Bash" },
    ]);
    expect(deriveWorkerMetricSegments({})).toEqual([]);
  });
});

describe("deriveWorkflowCardTitle", () => {
  it("renders Activity without a plan and Workflow with one", () => {
    expect(deriveWorkflowCardTitle(makeModel({ workers: [makeWorker()] }))).toBe("Activity");
    expect(deriveWorkflowCardTitle(makePlanModel())).toBe("Workflow");
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

  it("supports closed, collapsed, and expanded activity states", () => {
    const model = makeModel({
      workers: [makeWorker({ description: "Background investigation" })],
      totalUsage: { totalTokens: 1_500, toolUses: 2 },
    });

    const collapsedMarkup = renderToStaticMarkup(<WorkflowActivityCardComponent model={model} />);
    expect(collapsedMarkup).toContain('data-workflow-activity-state="collapsed"');
    expect(collapsedMarkup).toContain('data-slot="workflow-activity-toggle"');
    expect(collapsedMarkup).toContain('data-slot="workflow-activity-close"');
    expect(collapsedMarkup).toContain('aria-expanded="false"');
    expect(collapsedMarkup).toContain(">Open</span>");
    expect(collapsedMarkup).not.toContain('data-slot="workflow-activity-details"');
    expect(collapsedMarkup).toContain("1.5k tokens");
    expect(collapsedMarkup).toContain("2 tools");

    const expandedMarkup = renderToStaticMarkup(
      <WorkflowActivityCardComponent model={model} defaultOpen />,
    );
    expect(expandedMarkup).toContain('data-workflow-activity-state="expanded"');
    expect(expandedMarkup).toContain('aria-expanded="true"');
    expect(expandedMarkup).toContain(">Collapse</span>");
    expect(expandedMarkup).toMatch(/data-slot="workflow-activity-details">/);

    const closedMarkup = renderToStaticMarkup(
      <WorkflowActivityCardComponent model={model} defaultViewState="closed" />,
    );
    expect(closedMarkup).toContain('data-workflow-activity-state="closed"');
    expect(closedMarkup).toContain('data-slot="workflow-activity-launcher"');
    expect(closedMarkup).toContain('aria-label="Open task activity for this response"');
    expect(closedMarkup).not.toContain('data-slot="workflow-activity-toggle"');
    expect(closedMarkup).not.toContain('data-slot="workflow-activity-details"');
  });

  it("uses inline spacing and a viewport-bounded detail region in timeline placement", () => {
    const markup = renderToStaticMarkup(
      <WorkflowActivityCardComponent
        model={makeModel({ workers: [makeWorker({ description: "Historical worker" })] })}
        placement="inline"
        defaultViewState="expanded"
      />,
    );

    expect(markup).toContain('data-workflow-activity-placement="inline"');
    expect(markup).toContain('data-workflow-activity-turn-id="turn-1"');
    expect(markup).toContain("max-height:min(26rem, 55vh)");
    expect(markup).toContain("Historical worker");
  });

  it("caps the entire pinned surface and scrolls overflowing activity internally", () => {
    const markup = renderToStaticMarkup(
      <WorkflowActivityCardComponent
        model={makeModel({ workers: [makeWorker({ description: "Tall worker" })] })}
        defaultViewState="expanded"
        pinnedMaxHeight={280}
      />,
    );

    expect(markup).toContain("max-height:268px");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("overscroll-contain");
    expect(markup).toContain("max-height:none");
  });

  it("renders plan steps in order with counter, segmented strip, and collapsed selection", () => {
    const markup = renderToStaticMarkup(<WorkflowActivityCard model={makePlanModel()} />);

    expect(markup).toContain('aria-label="Workflow activity"');
    expect(markup.indexOf("Alpha")).toBeLessThan(markup.indexOf("Beta"));
    expect(markup.indexOf("Beta")).toBeLessThan(markup.indexOf("Gamma"));
    expect(markup).toContain("Step 2 of 3");
    expect(markup.match(/data-slot="workflow-step-strip-segment"/g)).toHaveLength(3);
    // All step disclosures start collapsed and no inline worker region is mounted.
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("No workers for this step yet.");
    expect(markup).not.toContain("Map the codebase");
    // Screen-reader status labeling rides on the step buttons.
    expect(markup).toContain("(In progress)");
  });

  it("renders task activity without a plan under an Activity heading", () => {
    const model = makeModel({
      workers: [makeWorker({ description: "Unplanned investigation", status: "completed" })],
    });
    const markup = renderToStaticMarkup(<WorkflowActivityCard model={model} />);

    expect(markup).toContain('aria-label="Task activity"');
    expect(markup).toContain(">Activity</p>");
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

  it("keeps complete results in collapsed disclosures by default", () => {
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
            makeWorker({ id: "task-2", taskId: "task-2", description: "Plain worker" }),
          ],
        })}
      />,
    );
    expect(markup).toContain('data-slot="workflow-worker-result-toggle"');
    expect(markup).toContain(">Result</span>");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Found 3 issues");
    expect(markup).toContain("Output:");
    expect(markup).toContain("/tmp/review-output.md");

    const bare = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({ workers: [makeWorker({ description: "Plain worker" })] })}
      />,
    );
    expect(bare).not.toContain('data-slot="workflow-worker-result-toggle"');
    expect(bare).not.toContain("Output:");
  });

  it("keeps completed progress visible before the collapsed result", () => {
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

    const progressToggleIndex = markup.indexOf('data-slot="workflow-worker-progress-toggle"');
    const resultToggleIndex = markup.indexOf('data-slot="workflow-worker-result-toggle"');
    expect(progressToggleIndex).toBeGreaterThan(-1);
    expect(resultToggleIndex).toBeGreaterThan(progressToggleIndex);
    expect(markup).not.toContain("Read the relevant source files.");
    expect(markup).not.toContain("Produced the final report.");
  });

  it("renders task errors and both sides of a retry relationship", () => {
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

    expect(markup).toContain("Error:");
    expect(markup).toContain("Worker connection closed unexpectedly.");
    expect(markup).toContain("Retried by");
    expect(markup).toContain("agent task-new");
    expect(markup).toContain("Retry of");
    expect(markup).toContain("agent task-old");
    expect(markup).toContain('data-slot="workflow-worker-result-toggle"');
    expect(markup).not.toContain("Retry completed successfully.");
  });

  it("collapses progress disclosures by default and omits them without a summary", () => {
    const withProgress = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({
          workers: [makeWorker({ description: "Chatty worker", progressSummary: "Halfway there" })],
        })}
      />,
    );
    expect(withProgress).toContain('data-slot="workflow-worker-progress-toggle"');
    expect(withProgress).toContain(">Progress</span>");
    expect(withProgress).toContain('aria-expanded="false"');
    expect(withProgress).not.toContain("Halfway there");

    const withoutProgress = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({ workers: [makeWorker({ description: "Quiet worker" })] })}
      />,
    );
    expect(withoutProgress).not.toContain(">Progress</span>");
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

  it("bounds expanded content with a max-height for scroll-safe layout", () => {
    const markup = renderToStaticMarkup(
      <WorkflowActivityCard
        model={makeModel({ workers: [makeWorker({ description: "Tall worker" })] })}
      />,
    );
    expect(markup).toContain("max-height:");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain('data-slot="workflow-worker-list"');
    expect(markup).toContain("overscroll-contain");
  });

  it("renders identical markup when an onHeightChange observer is attached", () => {
    // Height reporting is effect-only (ResizeObserver after mount), so the
    // server-rendered output must not change when ChatView attaches its
    // scroll-compensation callback.
    const model = makePlanModel();
    const bare = renderToStaticMarkup(<WorkflowActivityCard model={model} />);
    const observed = renderToStaticMarkup(
      <WorkflowActivityCard model={model} onHeightChange={() => undefined} />,
    );
    expect(observed).toBe(bare);
    expect(observed).toContain('data-slot="workflow-activity-card"');
  });
});
