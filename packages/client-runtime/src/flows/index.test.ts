import { describe, expect, it } from "vite-plus/test";
import {
  FlowId,
  FlowRunId,
  FlowStepRunId,
  ProjectId,
  ThreadId,
  type FlowRunSnapshot,
  type FlowStepRunState,
} from "@t3tools/contracts";
import {
  FLOW_RUN_METADATA_KEY,
  flowRunIdFromMetadata,
  flowStepRunList,
  flowStepStatusById,
  latestFlowRuns,
} from "./index.ts";

const summary = {
  id: FlowRunId.make("run"),
  flowId: FlowId.make("test"),
  projectId: ProjectId.make("project"),
  flowRunThreadId: ThreadId.make("thread"),
  status: "running",
  activeStepRunIds: [],
  error: null,
  createdAt: "2026-01-01T00:00:00Z",
  startedAt: null,
  finishedAt: null,
} satisfies FlowRunSnapshot["summary"];
const step = (id: string, overrides: Partial<FlowStepRunState> = {}): FlowStepRunState => ({
  id: FlowStepRunId.make(id),
  flowRunId: summary.id,
  stepPath: [id],
  attempt: 1,
  status: "pending",
  threadId: null,
  outputFields: null,
  error: null,
  createdAt: summary.createdAt,
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

describe("flow views", () => {
  it.each([
    {
      name: "loop iteration",
      run: step("review", { stepPath: ["loop", "review"], iteration: 1 }),
      iteration: "iteration 2",
      item: null,
      depth: 1,
    },
    {
      name: "map item",
      run: step("review", { stepPath: ["map", "review"], itemIndex: 2 }),
      iteration: null,
      item: "item 3",
      depth: 1,
    },
    {
      name: "nested step",
      run: step("review", { stepPath: ["loop", "map", "review"], iteration: 0, itemIndex: 0 }),
      iteration: "iteration 1",
      item: "item 1",
      depth: 2,
    },
  ])("labels $name", ({ run, iteration, item, depth }) => {
    const [row] = flowStepRunList({ summary, approvals: [], stepRuns: [run] });
    expect(row).toMatchObject({ iterationLabel: iteration, itemLabel: item, depth });
  });
  it("sorts execution order, preserves attempts, and maps the latest attempt per step", () => {
    const first = step("first", { stepPath: ["review"], status: "failed" });
    const retry = step("retry", {
      stepPath: ["review"],
      attempt: 2,
      status: "running",
      createdAt: "2026-01-01T00:00:01Z",
    });
    const snapshot = { summary, approvals: [], stepRuns: [retry, first] };
    expect(flowStepRunList(snapshot).map((step) => step.id)).toEqual([first.id, retry.id]);
    expect(flowStepStatusById(snapshot).get("review")).toBe("running");
    expect(snapshot.stepRuns).toEqual([retry, first]);
  });
  it("labels a map item with the container's final item count", () => {
    const parent = step("map", {
      outputFields: {
        kind: "map",
        items: [
          { status: "succeeded", outputs: {} },
          { status: "succeeded", outputs: {} },
        ],
      },
    });
    const child = step("child", { stepPath: ["map", "child"], itemIndex: 1 });
    expect(
      flowStepRunList({ summary, approvals: [], stepRuns: [parent, child] }).find(
        (row) => row.id === child.id,
      )?.itemLabel,
    ).toBe("item 2 of 2");
  });
  it("finds the latest flow run independently of stream order", () => {
    const newer = { ...summary, id: FlowRunId.make("newer"), createdAt: "2026-02-01T00:00:00Z" };
    expect(latestFlowRuns([newer, summary]).get(summary.flowId)).toBe(newer);
  });
  it.each([undefined, null, {}, { flowRunId: 1 }, { flowRunId: " " }])(
    "ignores invalid metadata %j",
    (metadata) => expect(flowRunIdFromMetadata(metadata)).toBeNull(),
  );
  it("reads the shared metadata link", () =>
    expect(flowRunIdFromMetadata({ [FLOW_RUN_METADATA_KEY]: "run" })).toBe("run"));
});
