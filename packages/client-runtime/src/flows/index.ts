import {
  FLOW_WS_METHODS,
  type FlowDefinition,
  type FlowModel,
  type FlowStep,
  type FlowDefinitionEntry,
  type FlowSaveInput,
  type FlowRunSnapshot,
  type FlowRunSummary,
  type FlowRunEvent,
  type FlowRunsEvent,
  type FlowRunsPage,
  type FlowStepRunState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";
import { reuseUnchanged } from "../state/serverConfigProjection.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type AtomCommandResult,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";

function upsertById<A>(
  current: ReadonlyArray<A>,
  updates: ReadonlyArray<A>,
  id: (row: A) => string,
) {
  if (updates.length === 0) return current;
  const rows = new Map(current.map((row) => [id(row), row]));
  for (const row of updates) rows.set(id(row), reuseUnchanged(rows.get(id(row)), row));
  const next = [...rows.values()];
  return next.length === current.length && next.every((row, index) => row === current[index])
    ? current
    : next;
}

export function applyFlowRunEvent(
  state: FlowRunSnapshot | null,
  event: FlowRunEvent,
): FlowRunSnapshot | null {
  if (event.type === "snapshot") {
    const { type: _type, ...snapshot } = event;
    return reuseUnchanged(state, snapshot);
  }
  if (!state) return null;
  return {
    ...state,
    summary: reuseUnchanged(state.summary, event.summary ?? state.summary),
    stepRuns: upsertById(state.stepRuns, event.stepRuns, (row) => row.id),
    approvals: upsertById(state.approvals, event.approvals, (row) => row.stepRunId),
  };
}

export function applyFlowRunsEvent(state: FlowRunsPage, event: FlowRunsEvent): FlowRunsPage {
  if (event.type === "snapshot") return { runs: event.runs, nextCursor: event.nextCursor };
  return { ...state, runs: upsertById(state.runs, event.runs, (row) => row.id) };
}

function compareStepRuns(a: FlowStepRunState, b: FlowStepRunState) {
  return (
    a.createdAt.localeCompare(b.createdAt) || a.attempt - b.attempt || a.id.localeCompare(b.id)
  );
}
export function flowStepInstanceKey(step: FlowStepRunState) {
  return JSON.stringify([step.parentStepRunId, step.stepPath, step.iteration, step.itemIndex]);
}
export function latestStepAttempts(snapshot: FlowRunSnapshot) {
  const latest = new Map<string, FlowStepRunState>();
  for (const step of snapshot.stepRuns) {
    const key = flowStepInstanceKey(step);
    const previous = latest.get(key);
    if (
      !previous ||
      step.attempt > previous.attempt ||
      (step.attempt === previous.attempt && compareStepRuns(previous, step) < 0)
    )
      latest.set(key, step);
  }
  return latest;
}
export function latestStepRunById(snapshot: FlowRunSnapshot) {
  const latest = new Map<string, FlowStepRunState>();
  for (const step of latestStepAttempts(snapshot).values()) {
    const id = step.stepPath.at(-1) ?? "";
    const previous = latest.get(id);
    if (!previous || compareStepRuns(previous, step) < 0) latest.set(id, step);
  }
  return latest;
}
export function flowStepRunList(snapshot: FlowRunSnapshot) {
  const byId = new Map(snapshot.stepRuns.map((row) => [row.id, row]));
  const children = new Map<string | null, FlowStepRunState[]>();
  for (const step of snapshot.stepRuns) {
    const parent =
      step.parentStepRunId && byId.has(step.parentStepRunId) ? step.parentStepRunId : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(step);
    children.set(parent, siblings);
  }
  const rows: Array<
    FlowStepRunState & {
      stepId: string;
      depth: number;
      iterationLabel: string | null;
      itemLabel: string | null;
      scopeLabel: string | null;
    }
  > = [];
  const seen = new Set<string>();
  const visit = (parent: string | null, depth: number, iterations: string[], items: string[]) => {
    for (const step of (children.get(parent) ?? []).sort(compareStepRuns)) {
      if (seen.has(step.id)) continue;
      seen.add(step.id);
      const container = step.parentStepRunId ? byId.get(step.parentStepRunId) : undefined;
      const count =
        container?.itemCount ??
        (container?.outputFields?.kind === "map" ? container.outputFields.items.length : undefined);
      const nextIterations =
        step.iteration === undefined
          ? iterations
          : [...iterations, `iteration ${step.iteration + 1}`];
      const nextItems =
        step.itemIndex === undefined
          ? items
          : [...items, `item ${step.itemIndex + 1}${count === undefined ? "" : ` of ${count}`}`];
      rows.push({
        ...step,
        stepId: step.stepPath.at(-1) ?? "",
        depth,
        iterationLabel: nextIterations.join(" / ") || null,
        itemLabel: nextItems.join(" / ") || null,
        scopeLabel: [...nextIterations, ...nextItems].join(" / ") || null,
      });
      visit(step.id, depth + 1, nextIterations, nextItems);
    }
  };
  visit(null, 0, [], []);
  return rows;
}
export function flowStepStatusById(snapshot: FlowRunSnapshot) {
  return new Map([...latestStepRunById(snapshot)].map(([id, step]) => [id, step.status]));
}
export function flowStepCountsById(snapshot: FlowRunSnapshot) {
  const counts = new Map<string, { total: number; succeeded: number; failed: number }>();
  for (const step of latestStepAttempts(snapshot).values()) {
    const id = step.stepPath.at(-1) ?? "";
    const count = counts.get(id) ?? { total: 0, succeeded: 0, failed: 0 };
    count.total++;
    if (step.status === "succeeded") count.succeeded++;
    if (step.status === "failed" || step.status === "interrupted") count.failed++;
    counts.set(id, count);
  }
  return counts;
}

function incompleteModel(model: FlowModel | undefined) {
  return model !== undefined && (!model.providerInstanceId.trim() || !model.model.trim());
}

function hasIncompleteStepModel(steps: ReadonlyArray<FlowStep>): boolean {
  return steps.some((step) =>
    step.kind === "agent"
      ? incompleteModel(step.model)
      : (step.kind === "loop" || step.kind === "map") && hasIncompleteStepModel(step.steps),
  );
}

export function createFlowDraft(
  entry: Pick<typeof FlowDefinitionEntry.Type, "definition" | "revision"> & {
    definition: FlowDefinition;
  },
) {
  let state = {
    definition: entry.definition,
    saved: entry.definition,
    revision: entry.revision as string | null,
    saving: false,
    error: null as string | null,
    conflict: false,
    conflictRevision: null as string | null,
  };
  const listeners = new Set<() => void>();
  const update = (next: typeof state) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  let pending: Promise<void> | undefined;
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    change: (definition: FlowDefinition) => update({ ...state, definition, error: null }),
    reload: (next: typeof entry) =>
      update({
        definition: next.definition,
        saved: next.definition,
        revision: next.revision,
        saving: false,
        error: null,
        conflict: false,
        conflictRevision: null,
      }),
    save: async (
      execute: (
        input: Pick<typeof FlowSaveInput.Type, "definition" | "baseRevision">,
      ) => Promise<AtomCommandResult<typeof FlowDefinitionEntry.Type, unknown>>,
      overwriteRevision?: string | null,
    ) => {
      if (pending) await pending;
      if (overwriteRevision !== undefined)
        update({ ...state, revision: overwriteRevision, conflict: false, error: null });
      if (state.definition === state.saved || state.conflict) return;
      pending = (async () => {
        while (state.definition !== state.saved && !state.conflict) {
          const definition = state.definition;
          if (
            incompleteModel(definition.defaults?.model) ||
            hasIncompleteStepModel(definition.steps)
          )
            break;
          update({ ...state, saving: true, error: null });
          const result = await execute({ definition, baseRevision: state.revision });
          if (result._tag === "Success")
            update({ ...state, saved: definition, revision: result.value.revision, saving: false });
          else {
            const error = Cause.squash(result.cause);
            update({
              ...state,
              saving: false,
              conflict:
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "revision_conflict",
              conflictRevision:
                typeof error === "object" &&
                error !== null &&
                "currentRevision" in error &&
                typeof error.currentRevision === "string"
                  ? error.currentRevision
                  : null,
              error: error instanceof Error ? error.message : String(error),
            });
            break;
          }
        }
      })();
      try {
        await pending;
      } finally {
        pending = undefined;
      }
    },
  };
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
    runForThread: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "flows:run-for-thread",
      tag: FLOW_WS_METHODS.flowRunForThread,
      staleTimeMs: Number.POSITIVE_INFINITY,
      idleTtlMs: 30 * 60_000,
    }),
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
