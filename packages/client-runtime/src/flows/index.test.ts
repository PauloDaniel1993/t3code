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
  applyFlowRunEvent,
  applyFlowRunsEvent,
} from "./index.ts";

const summary = {
  id: FlowRunId.make("run"),
  flowId: FlowId.make("test"),
  runNumber: 7,
  flowTitle: "Test",
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
  parentStepRunId: null,
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

const base = {
  definition: { version: 1, title: "Test", steps: [], edges: [] },
  inputs: {},
} as const;

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
    const parents = run.stepPath.slice(0, -1).map((id, i) =>
      step(id, {
        parentStepRunId: i === 0 ? null : FlowStepRunId.make(run.stepPath[i - 1]!),
        ...(i === 1 ? { iteration: 0 } : {}),
      }),
    );
    const child = {
      ...run,
      parentStepRunId: parents.at(-1)?.id ?? null,
      ...(parents.length > 1 ? { iteration: undefined } : {}),
    };
    const row = flowStepRunList({
      ...base,
      summary,
      approvals: [],
      stepRuns: [...parents, child],
    }).find((r) => r.id === child.id);
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
    const snapshot = { ...base, summary, approvals: [], stepRuns: [retry, first] };
    expect(flowStepRunList(snapshot).map((step) => step.id)).toEqual([first.id, retry.id]);
    expect(flowStepStatusById(snapshot).get("review")).toBe("running");
    expect(snapshot.stepRuns).toEqual([retry, first]);
  });
  it("labels a map item with the container's final item count", () => {
    const parent = step("map", {
      outputFields: {
        kind: "map",
        items: [{ status: "succeeded" }, { status: "succeeded" }],
      },
    });
    const child = step("child", {
      stepPath: ["map", "child"],
      parentStepRunId: parent.id,
      itemIndex: 1,
    });
    expect(
      flowStepRunList({ ...base, summary, approvals: [], stepRuns: [parent, child] }).find(
        (row) => row.id === child.id,
      )?.itemLabel,
    ).toBe("item 2 of 2");
  });
  it("replaces reconnect snapshots and merges repeated detail deltas by id", () => {
    const original: FlowRunSnapshot = {
      ...base,
      summary,
      approvals: [],
      stepRuns: [step("a"), step("b")],
    };
    const changed = { ...step("a"), status: "succeeded" as const };
    const approval = {
      stepRunId: changed.id,
      prompt: "Approve?",
      decision: null,
      answeredBy: null,
      answeredAt: null,
    };
    let state = applyFlowRunEvent(null, { type: "snapshot", ...original });
    state = applyFlowRunEvent(state, {
      type: "upsert",
      stepRuns: [changed],
      approvals: [approval],
    });
    state = applyFlowRunEvent(state, {
      type: "upsert",
      stepRuns: [changed],
      approvals: [approval],
    });
    expect(state?.stepRuns).toEqual([changed, step("b")]);
    expect(state?.approvals).toEqual([approval]);
    expect(state?.definition).toBe(original.definition);
    expect(applyFlowRunEvent(state, { type: "snapshot", ...original })).toEqual(original);
  });
  it("merges summary deltas and resets rows and cursor on a new snapshot", () => {
    const cursor = { createdAt: summary.createdAt, id: summary.id };
    let state = applyFlowRunsEvent(
      { runs: [], nextCursor: null },
      { type: "snapshot", runs: [summary], nextCursor: cursor },
    );
    const changed = { ...summary, status: "succeeded" as const };
    state = applyFlowRunsEvent(state, { type: "upsert", runs: [changed] });
    expect(state).toEqual({ runs: [changed], nextCursor: cursor });
    expect(applyFlowRunsEvent(state, { type: "snapshot", runs: [], nextCursor: null })).toEqual({
      runs: [],
      nextCursor: null,
    });
  });
  it("follows exact container identities when nested paths repeat", () => {
    const outer = step("outer", {
      outputFields: { kind: "loop", iterations: 3, exitReason: "maxIterations" },
    });
    const oldMap = step("old-map", {
      stepPath: ["outer", "map"],
      parentStepRunId: outer.id,
      iteration: 0,
      outputFields: { kind: "map", items: [{ status: "succeeded" }] },
    });
    const map = step("map", {
      stepPath: ["outer", "map"],
      parentStepRunId: outer.id,
      iteration: 2,
      outputFields: { kind: "map", items: [{ status: "succeeded" }, { status: "succeeded" }] },
    });
    const child = step("child", {
      stepPath: ["outer", "map", "child"],
      parentStepRunId: map.id,
      itemIndex: 1,
    });
    const row = flowStepRunList({
      ...base,
      summary,
      approvals: [],
      stepRuns: [outer, oldMap, map, child],
    }).find((r) => r.id === child.id);
    expect(row).toMatchObject({ depth: 2, scopeLabel: "iteration 3 / item 2 of 2" });
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
