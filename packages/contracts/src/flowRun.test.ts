import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { FlowRunEvent, FlowRunsEvent } from "./flowRun.ts";
import { FlowMcpOutput } from "./flowMcp.ts";
import {
  OrchestratorMcpSaveScheduledTaskInput,
  OrchestratorMcpScheduledTask,
} from "./orchestratorMcp.ts";

const decodeEvent = Schema.decodeUnknownSync(FlowRunEvent, { onExcessProperty: "error" });
const encodeEvent = Schema.encodeSync(FlowRunEvent);
const decodeRuns = Schema.decodeUnknownSync(FlowRunsEvent);
const decodeMcp = Schema.decodeUnknownSync(FlowMcpOutput);
const decodeSchedule = Schema.decodeUnknownSync(OrchestratorMcpSaveScheduledTaskInput);
const decodeScheduledTask = Schema.decodeUnknownSync(OrchestratorMcpScheduledTask);
const summary = {
  id: "run-1",
  projectId: "project-1",
  flowId: "test",
  runNumber: 3,
  flowTitle: "Original title",
  flowRunThreadId: "thread-1",
  status: "starting",
  activeStepRunIds: [],
  error: null,
  createdAt: "2026-10-30T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
};
const step = {
  id: "step-1",
  flowRunId: "run-1",
  parentStepRunId: null,
  stepPath: ["loop"],
  attempt: 1,
  status: "running",
  threadId: null,
  error: null,
  outputFields: null,
  createdAt: summary.createdAt,
  startedAt: summary.createdAt,
  finishedAt: null,
};
const snapshot = {
  definition: { version: 1, title: "Original title", steps: [], edges: [] },
  inputs: { issue: "123" },
  summary,
  stepRuns: [
    step,
    { ...step, id: "step-2", parentStepRunId: "step-1", stepPath: ["loop", "map"], iteration: 2 },
    {
      ...step,
      id: "step-3",
      parentStepRunId: "step-2",
      stepPath: ["loop", "map", "review"],
      itemIndex: 3,
    },
  ],
  approvals: [],
};
it("preserves the definition, inputs and nested step-run identity in the first stream message", () => {
  const event = { type: "snapshot", ...snapshot };
  expect(encodeEvent(decodeEvent(event))).toEqual(event);
  expect(
    decodeMcp({
      action: "read_run",
      ...snapshot,
      stepOutput: { kind: "agent", text: "done", decision: "approve" },
    }),
  ).toEqual({
    action: "read_run",
    ...snapshot,
    stepOutput: { kind: "agent", text: "done", decision: "approve" },
  });
});
it("streams only changed state after the snapshot, retaining command exit metadata", () => {
  const event = {
    type: "upsert",
    stepRuns: [
      { ...step, outputFields: { kind: "command", exitCode: 1, timedOut: false, lineCount: 300 } },
    ],
    approvals: [],
  };
  expect(encodeEvent(decodeEvent(event))).toEqual(event);
  expect(() => decodeEvent({ ...event, definition: snapshot.definition })).toThrow();
  expect(decodeRuns({ type: "upsert", runs: [summary] })).toEqual({
    type: "upsert",
    runs: [summary],
  });
  expect(() =>
    decodeRuns({
      type: "snapshot",
      runs: Array.from({ length: 51 }, () => ({ ...summary })),
      nextCursor: null,
    }),
  ).toThrow();
});
it("preserves a scheduled flow target through MCP input and output", () => {
  const flow = { flowId: "test", inputs: { issue: "{{body.issue}}" }, baseRef: "main" };
  expect(decodeSchedule({ flow }).flow).toEqual(flow);
  expect(
    decodeScheduledTask({
      scheduledTaskId: "task-1",
      title: "Flow",
      prompt: "Run flow: Flow",
      enabled: true,
      projectId: "project-1",
      boundThreadId: null,
      workspaceStrategy: { type: "root" },
      schedule: { type: "interval", everyMs: 3600000 },
      nextRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      flow,
    }).flow,
  ).toEqual(flow);
});
