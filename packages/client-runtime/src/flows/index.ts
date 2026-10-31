import {
  FLOW_WS_METHODS,
  FlowRunId,
  type FlowRunSnapshot,
  type FlowRunSummary,
  type FlowRunEvent,
  type FlowRunsEvent,
  type FlowRunsPage,
  type FlowStepRunState,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
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

function upsertById<A>(
  current: ReadonlyArray<A>,
  updates: ReadonlyArray<A>,
  id: (row: A) => string,
) {
  const rows = new Map(current.map((row) => [id(row), row]));
  for (const row of updates) rows.set(id(row), row);
  return [...rows.values()];
}

export function applyFlowRunEvent(
  state: FlowRunSnapshot | null,
  event: FlowRunEvent,
): FlowRunSnapshot | null {
  if (event.type === "snapshot") {
    const { type: _type, ...snapshot } = event;
    return snapshot;
  }
  if (!state) return null;
  return {
    ...state,
    summary: event.summary ?? state.summary,
    stepRuns: upsertById(state.stepRuns, event.stepRuns, (row) => row.id),
    approvals: upsertById(state.approvals, event.approvals, (row) => row.stepRunId),
  };
}

export function applyFlowRunsEvent(state: FlowRunsPage, event: FlowRunsEvent): FlowRunsPage {
  if (event.type === "snapshot") return { runs: event.runs, nextCursor: event.nextCursor };
  return { ...state, runs: upsertById(state.runs, event.runs, (row) => row.id) };
}

export function flowStepRunList(snapshot: FlowRunSnapshot) {
  const byId = new Map(snapshot.stepRuns.map((row) => [row.id, row]));
  return [...snapshot.stepRuns]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((stepRun) => {
      const chain = [stepRun];
      const seen = new Set([stepRun.id]);
      let parent = stepRun.parentStepRunId ? byId.get(stepRun.parentStepRunId) : undefined;
      while (parent && !seen.has(parent.id)) {
        chain.unshift(parent);
        seen.add(parent.id);
        parent = parent.parentStepRunId ? byId.get(parent.parentStepRunId) : undefined;
      }
      const coordinates = chain.flatMap((row) => {
        const container = row.parentStepRunId ? byId.get(row.parentStepRunId) : undefined;
        const count =
          container?.outputFields?.kind === "map" ? container.outputFields.items.length : undefined;
        return [
          ...(row.iteration === undefined ? [] : [`iteration ${row.iteration + 1}`]),
          ...(row.itemIndex === undefined
            ? []
            : [`item ${row.itemIndex + 1}${count === undefined ? "" : ` of ${count}`}`]),
        ];
      });
      return {
        ...stepRun,
        stepId: stepRun.stepPath.at(-1) ?? "",
        depth: chain.length - 1,
        iterationLabel:
          coordinates.filter((label) => label.startsWith("iteration")).join(" / ") || null,
        itemLabel: coordinates.filter((label) => label.startsWith("item")).join(" / ") || null,
        scopeLabel: coordinates.join(" / ") || null,
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
      transform: (stream) =>
        stream.pipe(
          Stream.scan((): FlowRunsPage => ({ runs: [], nextCursor: null }), applyFlowRunsEvent),
          Stream.drop(1),
        ),
    }),
    run: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "flows:run",
      tag: FLOW_WS_METHODS.flowRun,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(
          Stream.scan((): FlowRunSnapshot | null => null, applyFlowRunEvent),
          Stream.filter((snapshot): snapshot is FlowRunSnapshot => snapshot !== null),
        ),
    }),
    runsPage: createEnvironmentRpcCommand(runtime, {
      label: "flows:runs-page",
      tag: FLOW_WS_METHODS.flowRunsPage,
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
