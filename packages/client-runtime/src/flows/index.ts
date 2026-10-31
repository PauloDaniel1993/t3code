import {
  FLOW_WS_METHODS,
  FlowRunId,
  type FlowRunSnapshot,
  type FlowRunSummary,
  type FlowStepRunState,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";

export const FLOW_RUN_METADATA_KEY = "flowRunId";

export function flowRunIdFromMetadata(metadata: unknown) {
  if (typeof metadata !== "object" || metadata === null || !(FLOW_RUN_METADATA_KEY in metadata))
    return null;
  const value = metadata[FLOW_RUN_METADATA_KEY];
  return typeof value === "string" && value.trim() ? FlowRunId.make(value) : null;
}

export function flowStepRunList(snapshot: FlowRunSnapshot) {
  return [...snapshot.stepRuns]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((stepRun) => {
      const parentPath = stepRun.stepPath.slice(0, -1);
      const parent = snapshot.stepRuns.findLast(
        (candidate) =>
          candidate.stepPath.join("/") === parentPath.join("/") &&
          candidate.createdAt <= stepRun.createdAt,
      );
      const itemCount =
        parent?.outputFields?.kind === "map" ? parent.outputFields.items.length : undefined;
      return {
        ...stepRun,
        stepId: stepRun.stepPath.at(-1) ?? "",
        depth: Math.max(0, stepRun.stepPath.length - 1),
        iterationLabel:
          stepRun.iteration === undefined ? null : `iteration ${stepRun.iteration + 1}`,
        itemLabel:
          stepRun.itemIndex === undefined
            ? null
            : `item ${stepRun.itemIndex + 1}${itemCount === undefined ? "" : ` of ${itemCount}`}`,
      };
    });
}

export function flowStepStatusById(snapshot: FlowRunSnapshot) {
  const latest = new Map<string, FlowStepRunState>();
  for (const step of flowStepRunList(snapshot)) latest.set(step.stepId, step);
  return new Map([...latest].map(([id, step]) => [id, step.status]));
}

export function latestFlowRuns(runs: ReadonlyArray<FlowRunSummary>) {
  const latest = new Map<string, FlowRunSummary>();
  for (const run of runs) {
    const previous = latest.get(run.flowId);
    if (!previous || previous.createdAt < run.createdAt) latest.set(run.flowId, run);
  }
  return latest;
}

export function createFlowEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "flows:list",
      tag: FLOW_WS_METHODS.flowList,
      idleTtlMs: 0,
    }),
    runs: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "flows:runs",
      tag: FLOW_WS_METHODS.flowRuns,
      idleTtlMs: 0,
    }),
    run: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "flows:run",
      tag: FLOW_WS_METHODS.flowRun,
      idleTtlMs: 0,
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "flows:save",
      tag: FLOW_WS_METHODS.flowSave,
    }),
    rename: createEnvironmentRpcCommand(runtime, {
      label: "flows:rename",
      tag: FLOW_WS_METHODS.flowRename,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "flows:delete",
      tag: FLOW_WS_METHODS.flowDelete,
    }),
    validate: createEnvironmentRpcCommand(runtime, {
      label: "flows:validate",
      tag: FLOW_WS_METHODS.flowValidate,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "flows:start",
      tag: FLOW_WS_METHODS.flowStart,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "flows:stop",
      tag: FLOW_WS_METHODS.flowStop,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "flows:resume",
      tag: FLOW_WS_METHODS.flowResume,
    }),
    retryStep: createEnvironmentRpcCommand(runtime, {
      label: "flows:retry-step",
      tag: FLOW_WS_METHODS.flowRetryStep,
    }),
    answerApproval: createEnvironmentRpcCommand(runtime, {
      label: "flows:answer-approval",
      tag: FLOW_WS_METHODS.flowAnswerApproval,
    }),
    stepRunOutput: createEnvironmentRpcCommand(runtime, {
      label: "flows:step-output",
      tag: FLOW_WS_METHODS.flowStepRunOutput,
    }),
  };
}
