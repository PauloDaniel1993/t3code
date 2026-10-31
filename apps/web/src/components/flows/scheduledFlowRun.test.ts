import { expect, it } from "vite-plus/test";
import {
  FlowId,
  FlowRunId,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  type FlowRunSummary,
} from "@t3tools/contracts";
import { findScheduledFlowRun } from "./scheduledFlowRun";

const taskId = ScheduledTaskId.make("schedule");
const run: FlowRunSummary = {
  id: FlowRunId.make("run"),
  flowId: FlowId.make("test"),
  projectId: ProjectId.make("project"),
  flowRunThreadId: ThreadId.make("thread"),
  flowTitle: "Test",
  runNumber: 1,
  status: "succeeded",
  activeStepRunIds: [],
  error: null,
  createdAt: "2026-10-01T00:00:00Z",
  startedAt: null,
  finishedAt: null,
  scheduledTaskId: taskId,
};

it.each([true, false])(
  "finds the latest schedule's flow run across history pages: %s",
  async (includeMatch) => {
    const cursor = { id: FlowRunId.make("cursor"), createdAt: run.createdAt };
    const result = await findScheduledFlowRun(
      { runs: [], nextCursor: cursor },
      taskId,
      async () => ({
        runs: includeMatch
          ? [run, { ...run, id: FlowRunId.make("newer"), createdAt: "2026-10-02T00:00:00Z" }]
          : [],
        nextCursor: cursor,
      }),
    );
    expect(result?.id ?? null).toBe(includeMatch ? "newer" : null);
  },
);
