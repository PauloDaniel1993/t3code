import {
  FlowStepRunId,
  type FlowApproval,
  type FlowDefinition,
  type FlowInputs,
  type FlowModel,
  type RuntimeMode,
  type ProviderInteractionMode,
  type FlowRunSummary,
  type FlowStep,
  type FlowStepOutput,
  type FlowStepRun,
  type ThreadId,
} from "@t3tools/contracts";
import {
  evaluateFlowCondition,
  renderFlowTemplate,
  resolveFlowReference,
  validateFlowReport,
  type FlowReferenceContext,
} from "@t3tools/shared/flow";

export interface StepRun extends FlowStepRun {
  readonly parentId: FlowStepRunId | null;
  readonly scope: string;
  readonly superseded?: boolean | undefined;
  readonly reportReceived?: boolean | undefined;
  readonly reminderSent?: boolean | undefined;
  readonly lastSettledTurnId?: string | undefined;
  readonly takenEdges?: ReadonlyArray<number> | undefined;
  readonly items?: ReadonlyArray<string> | undefined;
}

export interface State {
  readonly run: FlowRunSummary;
  readonly definition: FlowDefinition;
  readonly inputs: FlowInputs;
  readonly workspace: string;
  readonly baseRef: string | null;
  readonly stepRuns: ReadonlyArray<StepRun>;
  readonly approvals: ReadonlyArray<FlowApproval>;
}

type ErrorInfo = NonNullable<FlowStepRun["error"]>;
export type Trigger = { readonly at: string } & (
  | { readonly type: "start" }
  | { readonly type: "stop" }
  | { readonly type: "resume" }
  | { readonly type: "retry_step"; readonly stepRunId: FlowStepRunId }
  | {
      readonly type: "thread_started";
      readonly stepRunId: FlowStepRunId;
      readonly threadId: ThreadId;
    }
  | {
      readonly type: "step_thread_settled";
      readonly stepRunId: FlowStepRunId;
      readonly text: string;
      readonly turnId: string;
      readonly error?: ErrorInfo;
    }
  | {
      readonly type: "report_received";
      readonly stepRunId: FlowStepRunId;
      readonly fields: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "command_finished";
      readonly stepRunId: FlowStepRunId;
      readonly output?: FlowStepOutput;
      readonly error?: ErrorInfo;
    }
  | {
      readonly type: "approval_answered";
      readonly stepRunId: FlowStepRunId;
      readonly decision: "approve" | "reject";
      readonly comment?: string;
      readonly answeredBy: string;
    }
  | { readonly type: "recovered"; readonly continuingThreadIds: ReadonlyArray<ThreadId> }
);

export type Action =
  | {
      readonly type: "launch_step_thread" | "continue_thread";
      readonly stepRunId: FlowStepRunId;
      readonly threadId: ThreadId | null;
      readonly prompt: string;
      readonly model?: FlowModel | undefined;
      readonly runtimeMode?: RuntimeMode | undefined;
      readonly interactionMode?: ProviderInteractionMode | undefined;
    }
  | {
      readonly type: "send_reminder";
      readonly stepRunId: FlowStepRunId;
      readonly threadId: ThreadId | null;
    }
  | {
      readonly type: "start_command";
      readonly stepRunId: FlowStepRunId;
      readonly command: string;
      readonly cwd?: string;
      readonly timeoutMs: number;
    }
  | {
      readonly type: "kill_command" | "interrupt_turn";
      readonly stepRunId: FlowStepRunId;
      readonly threadId: ThreadId | null;
    }
  | {
      readonly type: "update_flow_run_thread" | "finish";
      readonly status: FlowRunSummary["status"];
    };

export type Transition =
  | { readonly type: "run"; readonly run: FlowRunSummary }
  | { readonly type: "step"; readonly step: StepRun }
  | { readonly type: "approval"; readonly approval: FlowApproval };

export function applyTransitions(state: State, transitions: ReadonlyArray<Transition>): State {
  let run = state.run;
  const steps = new Map(state.stepRuns.map((step) => [step.id, step]));
  const approvals = new Map(state.approvals.map((approval) => [approval.stepRunId, approval]));
  for (const transition of transitions) {
    if (transition.type === "run") run = transition.run;
    else if (transition.type === "step") steps.set(transition.step.id, transition.step);
    else approvals.set(transition.approval.stepRunId, transition.approval);
  }
  return { ...state, run, stepRuns: [...steps.values()], approvals: [...approvals.values()] };
}

const active = (s: StepRun) =>
  !s.superseded && ["pending", "running", "waiting_report", "waiting_approval"].includes(s.status);
const terminal = (s: StepRun) => !active(s);
const failed = (s: StepRun) => s.status === "failed" || s.status === "interrupted";
const fault = (code: string): ErrorInfo => ({ code, message: code.replaceAll("_", " ") });

export function decide(
  initial: State,
  trigger: Trigger,
): { transitions: ReadonlyArray<Transition>; actions: ReadonlyArray<Action> } {
  let state = initial;
  const transitions: Transition[] = [];
  const actions: Action[] = [];
  const emit = (transition: Transition) => {
    transitions.push(transition);
    state = applyTransitions(state, [transition]);
  };
  const put = (step: StepRun) => emit({ type: "step", step });
  const get = (id: FlowStepRunId) => state.stepRuns.find((s) => s.id === id)!;
  const definition = (s: StepRun): FlowStep => {
    let steps = state.definition.steps;
    let found: FlowStep | undefined;
    for (const id of s.stepPath) {
      found = steps.find((step) => step.id === id);
      steps = found && (found.kind === "loop" || found.kind === "map") ? found.steps : [];
    }
    if (!found) throw new Error("Unknown step path");
    return found;
  };
  const ancestors = (s: StepRun) => {
    const chain = [s];
    while (chain.at(-1)!.parentId) chain.push(get(chain.at(-1)!.parentId!));
    return chain;
  };
  const previousRun = (s: StepRun) => {
    const chain = ancestors(s);
    const loopIndex = chain.findIndex((r, index) => index > 0 && definition(r).kind === "loop");
    if (loopIndex < 0) return undefined;
    const loop = chain[loopIndex]!;
    const iteration = chain[loopIndex - 1]!.iteration ?? 0;
    const mapIndexes = chain.slice(0, loopIndex).map((r) => r.itemIndex);
    return state.stepRuns.findLast((r) => {
      if (r.superseded || r.stepPath.join("/") !== s.stepPath.join("/")) return false;
      const candidate = ancestors(r);
      const index = candidate.findIndex((r) => r.id === loop.id);
      return (
        index === loopIndex &&
        candidate[index - 1]?.iteration === iteration - 1 &&
        candidate.slice(0, index).every((r, i) => r.itemIndex === mapIndexes[i])
      );
    });
  };
  const context = (scope: string, parent: StepRun | null): FlowReferenceContext => {
    const inherited = parent
      ? context(parent.scope, parent.parentId ? get(parent.parentId) : null)
      : { inputs: state.inputs };
    const steps = { ...inherited.steps };
    for (const s of state.stepRuns.filter((r) => r.scope === scope && !r.superseded)) {
      const previous = previousRun(s);
      steps[s.stepPath.at(-1)!] = {
        ...(s.output ? { output: s.output } : {}),
        ...(previous?.output ? { previous: { output: previous.output } } : {}),
      };
    }
    if (!parent) return { ...inherited, steps };
    const index = Number(scope.slice(scope.lastIndexOf(":") + 1));
    return {
      ...inherited,
      steps,
      ...(definition(parent).kind === "loop"
        ? { iteration: index }
        : { index, ...(parent.items?.[index] === undefined ? {} : { item: parent.items[index] }) }),
    };
  };
  const complete = (s: StepRun, output: FlowStepOutput | null, error?: ErrorInfo) =>
    put({
      ...s,
      output,
      status: error ? "failed" : "succeeded",
      error: error ?? null,
      finishedAt: trigger.at,
    });
  const cancel = (s: StepRun, code: string) => {
    const step = definition(s);
    if (step.kind === "command")
      actions.push({ type: "kill_command", stepRunId: s.id, threadId: s.threadId });
    if (step.kind === "agent")
      actions.push({ type: "interrupt_turn", stepRunId: s.id, threadId: s.threadId });
    put({ ...s, status: "cancelled", error: fault(code), finishedAt: trigger.at });
  };
  const retry = (s: StepRun) => {
    put({ ...s, superseded: true });
    const next = {
      ...s,
      id: FlowStepRunId.make(`${s.id}:retry:${s.attempt + 1}`),
      attempt: s.attempt + 1,
      status: "pending" as const,
      output: null,
      error: null,
      createdAt: trigger.at,
      startedAt: null,
      finishedAt: null,
      threadId: null,
      reportReceived: false,
      reminderSent: false,
      lastSettledTurnId: undefined,
      takenEdges: undefined,
      items: undefined,
    };
    put(next);
  };

  if (trigger.type === "stop") {
    if (!["starting", "running", "waiting_approval"].includes(state.run.status))
      return { transitions, actions };
    for (const s of state.stepRuns.filter(active)) cancel(s, "stopped");
    emit({
      type: "run",
      run: { ...state.run, status: "cancelled", activeStepRunIds: [], finishedAt: trigger.at },
    });
    actions.push({ type: "finish", status: "cancelled" });
    return { transitions, actions };
  }
  if (trigger.type === "resume") {
    if (state.run.status !== "cancelled") return { transitions, actions };
    for (const s of state.stepRuns.filter((s) => !s.superseded && s.error?.code === "stopped")) {
      const kind = definition(s).kind;
      if (kind === "loop" || kind === "map")
        put({ ...s, status: "running", error: null, finishedAt: null });
      else retry(s);
    }
  } else if (trigger.type === "retry_step") {
    const s = state.stepRuns.find((s) => s.id === trigger.stepRunId && !s.superseded);
    if (!s || !failed(s)) return { transitions, actions };
    // Invalidate only dependent work; independent completed branches remain durable.
    const invalidate = (source: StepRun) => {
      const parent = source.parentId ? get(source.parentId) : null;
      const graph = parent ? definition(parent) : state.definition;
      if (!("edges" in graph)) return;
      const ids = new Set([source.stepPath.at(-1)!]);
      for (let changed = true; changed;) {
        changed = false;
        for (const e of graph.edges)
          if (ids.has(e.from) && !ids.has(e.to)) {
            ids.add(e.to);
            changed = true;
          }
      }
      for (const r of state.stepRuns.filter(
        (r) =>
          !r.superseded &&
          r.scope === source.scope &&
          r.id !== source.id &&
          ids.has(r.stepPath.at(-1)!),
      )) {
        if (active(r)) cancel(r, "retry_dependency");
        put({ ...get(r.id), superseded: true });
      }
      if (parent) {
        put({ ...parent, status: "running", error: null, finishedAt: null, takenEdges: undefined });
        invalidate(parent);
      }
    };
    invalidate(s);
    retry(s);
    for (const cancelled of state.stepRuns.filter(
      (r) => !r.superseded && r.error?.code === "flow_failed",
    )) {
      const kind = definition(cancelled).kind;
      if (kind === "map" || kind === "loop")
        put({ ...cancelled, status: "running", error: null, finishedAt: null });
      else retry(cancelled);
    }
  } else if (trigger.type === "recovered") {
    if (!["starting", "running", "waiting_approval"].includes(state.run.status))
      return { transitions, actions };
    for (const s of state.stepRuns.filter(active)) {
      const kind = definition(s).kind;
      if (
        kind === "command" ||
        (kind === "agent" && (!s.threadId || !trigger.continuingThreadIds.includes(s.threadId)))
      )
        put({ ...s, status: "interrupted", error: fault("interrupted"), finishedAt: trigger.at });
    }
  } else if (trigger.type !== "start") {
    if (!["starting", "running", "waiting_approval"].includes(state.run.status))
      return { transitions, actions };
    const s = state.stepRuns.find((s) => s.id === trigger.stepRunId && active(s));
    if (!s) return { transitions, actions };
    const step = definition(s);
    if (trigger.type === "thread_started" && step.kind === "agent")
      put({ ...s, threadId: trigger.threadId });
    if (trigger.type === "report_received" && step.kind === "agent") {
      const result = validateFlowReport(step.outputs ?? [], trigger.fields);
      if (!result.valid) throw new Error(JSON.stringify(result.errors));
      const output = {
        text: s.output && "text" in s.output ? s.output.text : "",
        ...trigger.fields,
      } as FlowStepOutput;
      put({ ...s, output, reportReceived: true });
    }
    if (trigger.type === "step_thread_settled" && step.kind === "agent") {
      if (s.lastSettledTurnId === trigger.turnId) return { transitions, actions };
      put({ ...s, lastSettledTurnId: trigger.turnId });
      const output = { ...s.output, text: trigger.text };
      if (trigger.error) complete(get(s.id), output, trigger.error);
      else if (!step.outputs?.length || s.reportReceived) complete(get(s.id), output);
      else if (s.reminderSent) complete(get(s.id), output, fault("missing_report"));
      else {
        put({ ...get(s.id), output, status: "waiting_report", reminderSent: true });
        actions.push({ type: "send_reminder", stepRunId: s.id, threadId: s.threadId });
      }
    }
    if (trigger.type === "command_finished" && step.kind === "command")
      complete(
        s,
        trigger.output ?? null,
        trigger.error ??
          (trigger.output && "timedOut" in trigger.output && trigger.output.timedOut
            ? fault("command_timeout")
            : undefined),
      );
    if (trigger.type === "approval_answered" && step.kind === "approval") {
      const approval = state.approvals.find((a) => a.stepRunId === s.id)!;
      emit({
        type: "approval",
        approval: {
          ...approval,
          decision: trigger.decision,
          ...(trigger.comment === undefined ? {} : { comment: trigger.comment }),
          answeredBy: trigger.answeredBy,
          answeredAt: trigger.at,
        },
      });
      complete(s, {
        decision: trigger.decision,
        ...(trigger.comment === undefined ? {} : { comment: trigger.comment }),
      });
    }
  } else if (state.run.status !== "starting") return { transitions, actions };

  const runScope = (
    steps: ReadonlyArray<FlowStep>,
    edges: FlowDefinition["edges"],
    scope: string,
    parent: StepRun | null,
    index?: number,
  ): "active" | "done" | "failed" => {
    const rows = () => state.stepRuns.filter((s) => s.scope === scope && !s.superseded);
    for (const step of steps)
      if (!rows().some((r) => r.stepPath.at(-1) === step.id)) {
        const path = [...(parent?.stepPath ?? []), step.id];
        const attempts = state.stepRuns.filter(
          (r) => r.scope === scope && r.stepPath.at(-1) === step.id,
        ).length;
        put({
          id: FlowStepRunId.make(`${state.run.id}/${scope}/${step.id}/${attempts + 1}`),
          flowRunId: state.run.id,
          stepPath: path,
          scope,
          parentId: parent?.id ?? null,
          ...(parent && definition(parent).kind === "loop" ? { iteration: index } : {}),
          ...(parent && definition(parent).kind === "map" ? { itemIndex: index } : {}),
          attempt: attempts + 1,
          status: "pending",
          threadId: null,
          output: null,
          error: null,
          createdAt: trigger.at,
          startedAt: null,
          finishedAt: null,
        });
      }
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows()) {
        let s = get(row.id);
        const step = definition(s);
        if (s.status === "pending") {
          const incoming = edges
            .map((edge, i) => ({ edge, i }))
            .filter(({ edge }) => edge.to === step.id);
          if (
            incoming.some(
              ({ edge }) => !rows().find((r) => r.stepPath.at(-1) === edge.from)?.takenEdges,
            )
          )
            continue;
          if (
            incoming.length &&
            !incoming.some(({ edge, i }) =>
              rows()
                .find((r) => r.stepPath.at(-1) === edge.from)
                ?.takenEdges?.includes(i),
            )
          )
            put({ ...s, status: "skipped", finishedAt: trigger.at });
          else {
            put({ ...s, status: "running", startedAt: trigger.at });
            s = get(s.id);
            try {
              const ctx = context(scope, parent);
              const render = (text: string) =>
                renderFlowTemplate(
                  text,
                  ctx,
                  (id) =>
                    state.stepRuns.findLast((r) => r.stepPath.at(-1) === id && r.threadId)
                      ?.threadId ?? id,
                );
              if (step.kind === "agent") {
                const previous = step.thread === "continue" ? previousRun(s) : undefined;
                const sameAs = typeof step.thread === "object" ? step.thread.sameAs : undefined;
                const same = sameAs
                  ? state.stepRuns.findLast(
                      (r) =>
                        !r.superseded &&
                        r.stepPath.at(-1) === sameAs &&
                        r.threadId &&
                        (r.scope === scope || ctx.steps?.[sameAs]?.output === r.output),
                    )
                  : undefined;
                const threadId = (previous ?? same)?.threadId ?? null;
                if (sameAs && !threadId) throw new Error("Referenced thread unavailable");
                put({ ...s, threadId });
                actions.push({
                  type: threadId ? "continue_thread" : "launch_step_thread",
                  stepRunId: s.id,
                  threadId,
                  prompt: render(step.prompt),
                  model: step.model ?? (threadId ? undefined : state.definition.defaults?.model),
                  runtimeMode: step.runtimeMode ?? state.definition.defaults?.runtimeMode,
                  interactionMode:
                    step.interactionMode ?? state.definition.defaults?.interactionMode,
                });
              } else if (step.kind === "command")
                actions.push({
                  type: "start_command",
                  stepRunId: s.id,
                  command: render(step.command),
                  ...(step.cwd ? { cwd: step.cwd } : {}),
                  timeoutMs: step.timeoutMs ?? 600_000,
                });
              else if (step.kind === "approval") {
                put({ ...s, status: "waiting_approval" });
                emit({
                  type: "approval",
                  approval: {
                    stepRunId: s.id,
                    prompt: render(step.prompt),
                    decision: null,
                    answeredBy: null,
                    answeredAt: null,
                  },
                });
              } else if (step.kind === "map") {
                const items = resolveFlowReference(step.over, ctx);
                if (
                  !Array.isArray(items) ||
                  !items.every((item): item is string => typeof item === "string")
                )
                  throw new Error("Map reference must be a string array");
                if (items.length > (step.maxItems ?? 50)) complete(s, null, fault("max_items"));
                else put({ ...s, items });
              }
            } catch {
              complete(get(s.id), null, fault("invalid_reference"));
            }
          }
          changed = true;
          s = get(s.id);
        }
        if (s.status === "running" && (step.kind === "loop" || step.kind === "map")) {
          const outputs = (childScope: string) =>
            Object.fromEntries(
              state.stepRuns
                .filter((r) => r.scope === childScope && !r.superseded && r.output)
                .map((r) => [r.stepPath.at(-1)!, r.output!]),
            );
          if (step.kind === "loop") {
            let iteration = Math.max(
              0,
              ...state.stepRuns.filter((r) => r.parentId === s.id).map((r) => r.iteration ?? 0),
            );
            while (true) {
              const childScope = `${s.id}:${iteration}`;
              const result = runScope(step.steps, step.edges, childScope, s, iteration);
              if (result === "active") break;
              if (result === "failed") {
                complete(s, null, fault("child_failed"));
                break;
              }
              try {
                const condition = evaluateFlowCondition(step.until, context(childScope, s));
                if (condition || iteration + 1 >= step.maxIterations) {
                  complete(s, {
                    ...outputs(childScope),
                    iterations: iteration + 1,
                    exitReason: condition ? "condition" : "maxIterations",
                  });
                  break;
                }
              } catch {
                complete(s, null, fault("invalid_reference"));
                break;
              }
              iteration++;
            }
          } else {
            const results: Array<{
              status: "succeeded" | "failed";
              outputs: Readonly<Record<string, FlowStepOutput>>;
            }> = [];
            let running = 0;
            for (let i = 0; i < (s.items?.length ?? 0); i++) {
              const childScope = `${s.id}:${i}`;
              const exists = state.stepRuns.some((r) => r.scope === childScope && !r.superseded);
              if (!exists && running >= (step.concurrency ?? 1)) break;
              const result = runScope(step.steps, step.edges, childScope, s, i);
              if (result === "active") running++;
              else
                results.push({
                  status: result === "failed" ? "failed" : "succeeded",
                  outputs: outputs(childScope),
                });
              if (result === "failed" && step.onItemFailure !== "continue") {
                complete(s, null, fault("child_failed"));
                break;
              }
            }
            if (get(s.id).status === "running" && results.length === s.items?.length)
              complete(s, { items: results });
          }
          s = get(s.id);
        }
        if (terminal(s) && s.takenEdges === undefined) {
          const taken: number[] = [];
          try {
            for (const [i, edge] of edges.entries())
              if (
                edge.from === step.id &&
                (edge.on === "failure" ? failed(s) : s.status === "succeeded") &&
                (!edge.when || evaluateFlowCondition(edge.when, context(scope, parent)))
              )
                taken.push(i);
          } catch {
            s = { ...s, status: "failed", error: fault("invalid_reference") };
          }
          put({ ...s, takenEdges: taken });
          changed = true;
        }
      }
    }
    const unhandled = rows().some(
      (s) => failed(s) && !edges.some((e) => e.from === s.stepPath.at(-1) && e.on === "failure"),
    );
    if (unhandled) {
      for (const running of state.stepRuns.filter(active)) {
        let owner = running.parentId ? get(running.parentId) : null;
        while (owner && owner.scope !== scope) owner = owner.parentId ? get(owner.parentId) : null;
        if (running.scope === scope || owner) cancel(running, "flow_failed");
      }
      return "failed";
    }
    return rows().some(active) ? "active" : "done";
  };
  const result = runScope(state.definition.steps, state.definition.edges, "root", null);
  // A failed container cannot leave commands or agent turns running in its descendants.
  for (const s of state.stepRuns.filter(active)) {
    let parent = s.parentId ? get(s.parentId) : null;
    while (parent && !failed(parent)) parent = parent.parentId ? get(parent.parentId) : null;
    if (result === "failed" || parent) cancel(s, "flow_failed");
  }
  const activeStepRunIds = state.stepRuns.filter(active).map((s) => s.id);
  const status =
    result === "failed"
      ? "failed"
      : result === "done"
        ? "succeeded"
        : state.stepRuns.some((s) => !s.superseded && s.status === "waiting_approval")
          ? "waiting_approval"
          : "running";
  const run = {
    ...state.run,
    status,
    activeStepRunIds,
    startedAt: state.run.startedAt ?? trigger.at,
    finishedAt: result === "active" ? null : trigger.at,
    error: result === "failed" ? fault("step_failed") : null,
  } satisfies FlowRunSummary;
  if (JSON.stringify(run) !== JSON.stringify(state.run)) {
    emit({ type: "run", run });
    actions.push({ type: result === "active" ? "update_flow_run_thread" : "finish", status });
  }
  return { transitions, actions };
}
