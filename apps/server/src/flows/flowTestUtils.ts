import {
  FlowId,
  FlowRunId,
  ProjectId,
  ThreadId,
  type FlowDefinition,
  type FlowInputs,
} from "@t3tools/contracts";
import type { State } from "./FlowEngine.ts";
const at = "2026-10-31T00:00:00.000Z";
export function initialState(definition: FlowDefinition, inputs: FlowInputs = {}): State {
  return {
    definition,
    inputs,
    workspace: ".",
    baseRef: "main",
    stepRuns: [],
    approvals: [],
    run: {
      id: FlowRunId.make("flow-run-1"),
      projectId: ProjectId.make("project-1"),
      flowId: FlowId.make("flow"),
      runNumber: 1,
      flowTitle: definition.title,
      flowRunThreadId: ThreadId.make("parent"),
      status: "starting",
      activeStepRunIds: [],
      error: null,
      createdAt: at,
      startedAt: null,
      finishedAt: null,
    },
  };
}
