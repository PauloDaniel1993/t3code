import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { FlowRevisionConflict, type FlowDefinitionEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  FlowId,
  FlowRunId,
  FlowStepRunId,
  ProjectId,
  ThreadId,
  type FlowDefinition,
  type FlowModel,
  type FlowRunSnapshot,
  type FlowStepRunState,
} from "@t3tools/contracts";
import {
  flowResultStepRuns,
  flowStepRunList,
  flowStepStatusById,
  latestFlowRuns,
  applyFlowRunEvent,
  applyFlowRunsEvent,
  createFlowDraft,
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
  it("reports the latest succeeded attempt of each step the flow ends on", () => {
    const command = (id: string) => ({ id, kind: "command" as const, command: "true" });
    const definition = {
      ...base.definition,
      steps: [command("plan"), command("build"), command("recover"), command("lint")],
      edges: [
        { from: "plan", to: "build" },
        { from: "build", to: "recover", on: "failure" as const },
      ],
    };
    const stepRuns = [
      step("plan-1", { stepPath: ["plan"], status: "succeeded" }),
      step("build-1", { stepPath: ["build"], status: "failed" }),
      step("build-2", {
        stepPath: ["build"],
        attempt: 2,
        status: "succeeded",
        createdAt: "2026-01-01T00:00:01Z",
      }),
      step("recover-1", { stepPath: ["recover"], status: "skipped" }),
      step("lint-1", { stepPath: ["lint"], status: "failed" }),
    ];
    const result = flowResultStepRuns({ ...base, definition, summary, approvals: [], stepRuns });
    expect(result.map(({ step, stepRun }) => [step.id, stepRun.id])).toEqual([
      ["build", "build-2"],
    ]);
  });
  it.each(["running", "succeeded"] as const)(
    "labels a map item with its total while %s",
    (status) => {
      const parent = step("map", {
        status,
        ...(status === "running"
          ? { itemCount: 2 }
          : {
              outputFields: {
                kind: "map",
                items: [{ status: "succeeded" }, { status: "succeeded" }],
              },
            }),
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
    },
  );
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
    expect(
      applyFlowRunEvent(state, { type: "snapshot", ...structuredClone(original) })?.definition,
    ).toBe(original.definition);
    expect(state?.definition).toBe(original.definition);
    expect(state?.stepRuns[1]).toBe(original.stepRuns[1]);
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
});

it("keeps parallel branches outside the container's subtree", () => {
  const parent = step("loop");
  const branch = step("branch", { createdAt: "2026-01-01T00:00:01Z" });
  const child = step("child", {
    parentStepRunId: parent.id,
    stepPath: ["loop", "child"],
    createdAt: "2026-01-01T00:00:02Z",
  });
  expect(
    flowStepRunList({ ...base, summary, approvals: [], stepRuns: [child, branch, parent] }).map(
      (row) => row.id,
    ),
  ).toEqual([parent.id, child.id, branch.id]);
});
it("retains a conflicting draft until explicit overwrite or reload", async () => {
  const draft = createFlowDraft({ definition: base.definition, revision: "old" });
  const edited = { ...base.definition, title: "Edited" };
  draft.change(edited);
  const conflict = AsyncResult.failure<typeof FlowDefinitionEntry.Type, FlowRevisionConflict>(
    Cause.fail(
      new FlowRevisionConflict({
        code: "revision_conflict",
        currentRevision: "external",
        message: "Changed on disk",
      }),
    ),
  );
  const inputs: unknown[] = [];
  await draft.save(async (input) => {
    inputs.push(input);
    return conflict;
  });
  expect(inputs).toEqual([{ definition: edited, baseRevision: "old" }]);
  expect(draft.getSnapshot()).toMatchObject({
    definition: edited,
    conflict: true,
    revision: "old",
  });
  await draft.save(async (input) => {
    inputs.push(input);
    return conflict;
  });
  expect(inputs).toHaveLength(1);
  await draft.save(async (input) => {
    inputs.push(input);
    return AsyncResult.success({
      flowId: summary.flowId,
      definition: edited,
      revision: "saved",
      validation: { valid: true, errors: [] },
    });
  }, "external");
  expect(inputs[1]).toEqual({ definition: edited, baseRevision: "external" });
  expect(draft.getSnapshot()).toMatchObject({ saved: edited, conflict: false, revision: "saved" });
  draft.change(base.definition);
  draft.reload({ definition: edited, revision: "new" });
  expect(draft.getSnapshot().definition).toBe(draft.getSnapshot().saved);
});
it.each(
  [
    undefined,
    { providerInstanceId: "", model: "" },
    { providerInstanceId: "devReplay", model: "" },
    { providerInstanceId: "", model: "showcase" },
  ].flatMap((model) => ["default", "agent", "nested"].map((location) => ({ model, location }))),
)("flushes only complete $location model overrides: $model", async ({ model, location }) => {
  const draft = createFlowDraft({ definition: base.definition, revision: "old" });
  const first = { ...base.definition, title: "First" };
  const second = { ...base.definition, title: "Second" };
  const withModel = (value: FlowModel): FlowDefinition => {
    const agent = { id: "agent", kind: "agent" as const, prompt: "Test", model: value };
    return {
      ...second,
      ...(location === "default"
        ? { defaults: { model: value } }
        : {
            steps:
              location === "agent"
                ? [agent]
                : [{ id: "map", kind: "map", over: "inputs.items", steps: [agent], edges: [] }],
          }),
    };
  };
  draft.change(first);
  const inputs: unknown[] = [];
  await draft.save(async (input) => {
    inputs.push(input);
    if (inputs.length === 1) draft.change(model ? withModel(model) : second);
    return AsyncResult.success({
      flowId: summary.flowId,
      definition: input.definition,
      revision: `r${inputs.length}`,
      validation: { valid: true, errors: [] },
    });
  });
  const completed = model
    ? withModel({ providerInstanceId: "devReplay", model: "showcase", options: { effort: "high" } })
    : second;
  if (model) {
    expect(inputs).toEqual([{ definition: first, baseRevision: "old" }]);
    expect(draft.getSnapshot()).toMatchObject({ saving: false, error: null, saved: first });
    await draft.save(async () => {
      throw new Error("Incomplete override must not reach the save transport");
    });
    draft.change(completed);
    await draft.save(async (input) => {
      inputs.push(input);
      return AsyncResult.success({
        flowId: summary.flowId,
        definition: input.definition,
        revision: "r2",
        validation: { valid: true, errors: [] },
      });
    });
  }
  expect(inputs).toEqual([
    { definition: first, baseRevision: "old" },
    { definition: completed, baseRevision: "r1" },
  ]);
  expect(draft.getSnapshot().saved).toBe(completed);
});

it("saves an invalid draft and retains its validation errors", async () => {
  const draft = createFlowDraft({ definition: base.definition, revision: "old" });
  const definition = {
    ...base.definition,
    steps: [{ id: "a", kind: "agent" as const, prompt: "{{inputs.missing}}" }],
  };
  draft.change(definition);
  const inputs: unknown[] = [];
  await draft.save(async (input) => {
    inputs.push(input);
    return AsyncResult.success({
      flowId: summary.flowId,
      definition,
      revision: "invalid",
      validation: {
        valid: false,
        errors: [{ path: "$.steps[0].prompt", message: "Unknown flow input" }],
      },
    });
  });
  expect(inputs).toEqual([{ definition, baseRevision: "old" }]);
  expect(draft.getSnapshot()).toMatchObject({
    saved: definition,
    revision: "invalid",
    saving: false,
  });
});
