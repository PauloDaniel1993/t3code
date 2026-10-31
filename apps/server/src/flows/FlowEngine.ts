// @effect-diagnostics nodeBuiltinImport:off -- Synchronous hashing keeps engine decisions pure and deterministic.
import * as NodeCrypto from "node:crypto";
import {
  FlowStepRunId,
  type FlowApproval,
  type FlowDefinition,
  type FlowCommandOutput,
  type FlowInputs,
  type FlowModel,
  type RuntimeMode,
  type ProviderInteractionMode,
  type FlowRunSummary,
  type FlowStep,
  type FlowStepOutput,
  type FlowStepRun,
  ThreadId,
  type FlowValidationError,
} from "@t3tools/contracts";
import {
  FlowValueError,
  evaluateFlowCondition,
  renderFlowTemplate,
  renderFlowCommandEnv,
  resolveFlowMapItems,
  validateFlowReport,
  type FlowReferenceContext,
} from "@t3tools/shared/flow";

export interface StepRun extends FlowStepRun {
  readonly scope: string;
  readonly cancelledBy?: FlowStepRunId | undefined;
  readonly expectedMessageId?: string | undefined;
  readonly superseded?: boolean | undefined;
  readonly cancelReason?: "stopped" | "flow_failed" | "retry_dependency" | undefined;
  readonly reportReceived?: boolean | undefined;
  readonly reminderSent?: boolean | undefined;
  readonly lastSettledTurnId?: string | undefined;
  readonly takenEdges?: ReadonlyArray<number> | undefined;
  readonly items?: ReadonlyArray<string> | undefined;
}

export interface State {
  readonly version: number;
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
  | { readonly type: "action_failed"; readonly stepRunId: FlowStepRunId; readonly error: ErrorInfo }
  | {
      readonly type: "step_thread_settled";
      readonly stepRunId: FlowStepRunId;
      readonly text: string;
      readonly messageId: string;
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
      readonly output?: typeof FlowCommandOutput.Type;
      readonly error?: ErrorInfo;
    }
  | {
      readonly type: "approval_answered";
      readonly stepRunId: FlowStepRunId;
      readonly decision: "approve" | "reject";
      readonly comment?: string;
      readonly answeredBy: string;
    }
  | {
      readonly type: "recovered";
      readonly continuingThreadIds: ReadonlyArray<ThreadId>;
      readonly continuingMessageIds?: Readonly<Record<string, string>>;
    }
);

export type Action =
  | {
      readonly type: "launch_step_thread" | "continue_thread";
      readonly stepRunId: FlowStepRunId;
      readonly threadId: ThreadId;
      readonly messageId: string;
      readonly prompt: string;
      readonly model?: FlowModel | undefined;
      readonly runtimeMode?: RuntimeMode | undefined;
      readonly interactionMode?: ProviderInteractionMode | undefined;
    }
  | {
      readonly type: "send_reminder";
      readonly messageId: string;
      readonly stepRunId: FlowStepRunId;
      readonly threadId: ThreadId | null;
    }
  | {
      readonly type: "start_command";
      readonly stepRunId: FlowStepRunId;
      readonly command: string;
      readonly env: Readonly<Record<string, string>>;
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
const inFlight = (s: StepRun) => active(s) && s.status !== "pending";
const terminal = (s: StepRun) => !active(s);
const opaqueId = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const failed = (s: StepRun) => s.status === "failed" || s.status === "interrupted";
const fault = (code: ErrorInfo["code"], message = code.replaceAll("_", " ")): ErrorInfo => ({
  code,
  message,
});

export function decide(
  initial: State,
  trigger: Trigger,
): {
  transitions: ReadonlyArray<Transition>;
  actions: ReadonlyArray<Action>;
  rejected?: {
    reason: "not_applicable" | "invalid_report";
    errors?: ReadonlyArray<FlowValidationError>;
  };
} {
  let state = initial;
  const transitions: Transition[] = [];
  const actions: Action[] = [];
  const reject = (
    reason: "not_applicable" | "invalid_report" = "not_applicable",
    errors?: ReadonlyArray<FlowValidationError>,
  ) => ({ transitions: [], actions: [], rejected: { reason, ...(errors ? { errors } : {}) } });
  const finishDecision = () => {
    const before = new Map(initial.stepRuns.map((s) => [s.id, s]));
    const after = byId;
    const starts = actions.filter((a) => {
      if (!("stepRunId" in a)) return true;
      const next = after.get(a.stepRunId);
      if (a.type === "send_reminder") return next?.status === "waiting_report" && !next.superseded;
      return (
        next?.status === "running" &&
        !next.superseded &&
        before.get(a.stepRunId)?.status !== "running"
      );
    });
    const stops: Action[] = [];
    for (const old of initial.stepRuns) {
      const next = after.get(old.id);
      if (!inFlight(old) || (next && inFlight(next))) continue;
      if (next?.status !== "cancelled" && !next?.superseded) continue;
      const kind = definition(old).kind;
      if (kind === "agent" || kind === "command")
        stops.push({
          type: kind === "agent" ? "interrupt_turn" : "kill_command",
          stepRunId: old.id,
          threadId: old.threadId,
        });
    }
    const finalSteps = new Map<FlowStepRunId, Transition>();
    const finalApprovals = new Map<FlowStepRunId, Transition>();
    for (const t of transitions) {
      if (t.type === "step") finalSteps.set(t.step.id, t);
      if (t.type === "approval") finalApprovals.set(t.approval.stepRunId, t);
    }
    return {
      transitions: [
        ...finalSteps.values(),
        ...finalApprovals.values(),
        ...transitions.filter((t) => t.type === "run").slice(-1),
      ],
      actions: [
        ...starts.filter((a) => "stepRunId" in a),
        ...stops,
        ...starts.filter((a) => !("stepRunId" in a)),
      ],
    };
  };
  const byId = new Map(initial.stepRuns.map((s) => [s.id, s]));
  const byScope = new Map<string, Map<FlowStepRunId, StepRun>>();
  const byPath = new Map<string, Map<FlowStepRunId, StepRun>>();
  const children = new Map<FlowStepRunId | null, Map<FlowStepRunId, StepRun>>();
  for (const step of initial.stepRuns) {
    const rows = byScope.get(step.scope) ?? new Map();
    rows.set(step.id, step);
    byScope.set(step.scope, rows);
    const pathRows = byPath.get(step.stepPath.join("/")) ?? new Map();
    pathRows.set(step.id, step);
    byPath.set(step.stepPath.join("/"), pathRows);
    const childRows = children.get(step.parentStepRunId) ?? new Map();
    childRows.set(step.id, step);
    children.set(step.parentStepRunId, childRows);
  }
  const emit = (transition: Transition) => {
    transitions.push(transition);
    if (transition.type === "step") {
      const step = transition.step;
      byId.set(step.id, step);
      const rows = byScope.get(step.scope) ?? new Map();
      rows.set(step.id, step);
      byScope.set(step.scope, rows);
      const pathRows = byPath.get(step.stepPath.join("/")) ?? new Map();
      pathRows.set(step.id, step);
      byPath.set(step.stepPath.join("/"), pathRows);
      const childRows = children.get(step.parentStepRunId) ?? new Map();
      childRows.set(step.id, step);
      children.set(step.parentStepRunId, childRows);
    } else if (transition.type === "run") state = { ...state, run: transition.run };
    else
      state = {
        ...state,
        approvals: [
          ...state.approvals.filter((a) => a.stepRunId !== transition.approval.stepRunId),
          transition.approval,
        ],
      };
  };
  const put = (step: StepRun) => emit({ type: "step", step });
  const get = (id: FlowStepRunId) => byId.get(id)!;
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
    while (chain.at(-1)!.parentStepRunId) chain.push(get(chain.at(-1)!.parentStepRunId!));
    return chain;
  };
  const previousRun = (s: StepRun) => {
    const chain = ancestors(s);
    const loopIndex = chain.findIndex((r, index) => index > 0 && definition(r).kind === "loop");
    if (loopIndex < 0) return undefined;
    const loop = chain[loopIndex]!;
    const iteration = chain[loopIndex - 1]!.iteration ?? 0;
    const mapIndexes = chain.slice(0, loopIndex).map((r) => r.itemIndex);
    return [...(byPath.get(s.stepPath.join("/"))?.values() ?? [])].findLast((r) => {
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
      ? context(parent.scope, parent.parentStepRunId ? get(parent.parentStepRunId) : null)
      : { inputs: state.inputs };
    const steps = { ...inherited.steps };
    for (const s of [...(byScope.get(scope)?.values() ?? [])].filter((r) => !r.superseded)) {
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
      error: error ?? s.error,
      finishedAt: trigger.at,
    });
  const cancel = (
    s: StepRun,
    reason: NonNullable<StepRun["cancelReason"]>,
    cancelledBy?: FlowStepRunId,
  ) => {
    put({
      ...s,
      status: "cancelled",
      error: fault("turn_cancelled", reason),
      cancelReason: reason,
      cancelledBy,
      finishedAt: trigger.at,
    });
  };
  const supersede = (s: StepRun) => {
    for (const child of [...(children.get(s.id)?.values() ?? [])].filter((r) => !r.superseded))
      supersede(child);
    if (active(s)) cancel(s, "retry_dependency");
    put({ ...get(s.id), superseded: true });
  };
  const retry = (s: StepRun) => {
    supersede(s);
    const next = {
      ...s,
      id: FlowStepRunId.make(opaqueId(`${s.id}:retry:${s.attempt + 1}`)),
      attempt: s.attempt + 1,
      status: "pending" as const,
      output: null,
      error: null,
      createdAt: trigger.at,
      startedAt: null,
      finishedAt: null,
      threadId: null,
      reportReceived: false,
      cancelReason: undefined,
      cancelledBy: undefined,
      expectedMessageId: undefined,
      reminderSent: false,
      lastSettledTurnId: undefined,
      takenEdges: undefined,
      items: undefined,
    };
    put(next);
  };

  if (trigger.type === "stop") {
    if (!["starting", "running", "waiting_approval"].includes(state.run.status)) return reject();
    for (const s of [...byId.values()].filter(active)) cancel(s, "stopped");
    emit({
      type: "run",
      run: { ...state.run, status: "cancelled", activeStepRunIds: [], finishedAt: trigger.at },
    });
    actions.push({ type: "finish", status: "cancelled" });
    return finishDecision();
  }
  if (trigger.type === "resume") {
    if (state.run.status !== "cancelled") return reject();
    for (const s of [...byId.values()].filter(
      (s) => !s.superseded && s.cancelReason === "stopped",
    )) {
      const kind = definition(s).kind;
      if (kind === "loop" || kind === "map")
        put({ ...s, status: "running", error: null, finishedAt: null });
      else if (s.startedAt === null)
        put({ ...s, status: "pending", error: null, cancelReason: undefined, finishedAt: null });
      else retry(s);
    }
  } else if (trigger.type === "retry_step") {
    const s = [...byId.values()].find((s) => s.id === trigger.stepRunId && !s.superseded);
    if (!s || !failed(s) || !["failed", "running"].includes(state.run.status)) return reject();
    const chain = new Set(ancestors(s).map((r) => r.id));
    if (
      [...byId.values()].some(
        (r) =>
          !r.superseded &&
          failed(r) &&
          !chain.has(r.id) &&
          (() => {
            const parent = r.parentStepRunId ? get(r.parentStepRunId) : null;
            const graph = parent ? definition(parent) : state.definition;
            return (
              "edges" in graph &&
              !r.takenEdges?.some((i) => graph.edges[i]?.on === "failure") &&
              (!parent || active(parent))
            );
          })(),
      )
    )
      return reject();
    // Invalidate only dependent work; independent completed branches remain durable.
    const invalidate = (source: StepRun) => {
      const parent = source.parentStepRunId ? get(source.parentStepRunId) : null;
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
      for (const r of [...byId.values()].filter(
        (r) =>
          !r.superseded &&
          r.scope === source.scope &&
          r.id !== source.id &&
          ids.has(r.stepPath.at(-1)!),
      )) {
        supersede(r);
      }
      if (parent) {
        if (definition(parent).kind === "loop") {
          for (const later of [...byId.values()].filter(
            (r) =>
              !r.superseded &&
              r.parentStepRunId === parent.id &&
              (r.iteration ?? 0) > (source.iteration ?? 0),
          ))
            supersede(later);
        }
        put({ ...parent, status: "running", error: null, finishedAt: null, takenEdges: undefined });
        invalidate(parent);
      }
    };
    invalidate(s);
    retry(s);
    for (const cancelled of [...byId.values()].filter(
      (r) =>
        !r.superseded &&
        r.cancelReason === "flow_failed" &&
        r.cancelledBy !== undefined &&
        chain.has(r.cancelledBy) &&
        ancestors(r).slice(1).every(active),
    )) {
      const kind = definition(cancelled).kind;
      if (kind === "map" || kind === "loop")
        put({ ...cancelled, status: "running", error: null, finishedAt: null });
      else retry(cancelled);
    }
  } else if (trigger.type === "recovered") {
    if (!["starting", "running", "waiting_approval"].includes(state.run.status)) return reject();
    for (const s of [...byId.values()].filter(inFlight)) {
      const kind = definition(s).kind;
      if (
        kind === "command" ||
        (kind === "agent" && (!s.threadId || !trigger.continuingThreadIds.includes(s.threadId)))
      )
        put({ ...s, status: "interrupted", error: fault("interrupted"), finishedAt: trigger.at });
      else if (kind === "agent" && s.threadId && trigger.continuingMessageIds?.[s.threadId])
        put({ ...s, expectedMessageId: trigger.continuingMessageIds[s.threadId] });
    }
  } else if (trigger.type !== "start") {
    if (!["starting", "running", "waiting_approval"].includes(state.run.status)) return reject();
    const s = [...byId.values()].find((s) => s.id === trigger.stepRunId && active(s));
    if (!s) return reject();
    const step = definition(s);
    const applicable =
      trigger.type === "approval_answered"
        ? step.kind === "approval" &&
          s.status === "waiting_approval" &&
          state.approvals.some((a) => a.stepRunId === s.id)
        : trigger.type === "command_finished"
          ? step.kind === "command" && s.status === "running"
          : trigger.type === "action_failed"
            ? inFlight(s)
            : step.kind === "agent" && (s.status === "running" || s.status === "waiting_report");
    if (!applicable) return reject();
    if (trigger.type === "action_failed") complete(s, s.output, trigger.error);
    if (trigger.type === "report_received" && step.kind === "agent") {
      const result = validateFlowReport(step.outputs ?? [], trigger.fields);
      if (!result.valid) return reject("invalid_report", result.errors);
      const output = {
        kind: "agent",
        text: s.output?.kind === "agent" ? s.output.text : "",
        ...trigger.fields,
      } as FlowStepOutput;
      put({ ...s, output, reportReceived: true });
    }
    if (trigger.type === "step_thread_settled" && step.kind === "agent") {
      if (s.lastSettledTurnId === trigger.turnId || s.expectedMessageId !== trigger.messageId)
        return reject();
      put({ ...s, lastSettledTurnId: trigger.turnId });
      const output: FlowStepOutput = {
        ...(s.output?.kind === "agent" ? s.output : {}),
        kind: "agent",
        text: trigger.text,
      };
      if (trigger.error) complete(get(s.id), output, trigger.error);
      else if (!step.outputs?.length || s.reportReceived) complete(get(s.id), output);
      else if (s.reminderSent) complete(get(s.id), output, fault("missing_report"));
      else {
        const messageId = `${s.id}:reminder`;
        put({
          ...get(s.id),
          output,
          status: "waiting_report",
          reminderSent: true,
          expectedMessageId: messageId,
        });
        actions.push({ type: "send_reminder", stepRunId: s.id, threadId: s.threadId, messageId });
      }
    }
    if (trigger.type === "command_finished" && step.kind === "command")
      complete(
        s,
        trigger.output ?? null,
        trigger.error ?? (trigger.output?.timedOut ? fault("command_timeout") : undefined),
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
        kind: "approval",
        decision: trigger.decision,
        ...(trigger.comment === undefined ? {} : { comment: trigger.comment }),
      });
    }
  } else if (state.run.status !== "starting") return reject();

  const runScope = (
    steps: ReadonlyArray<FlowStep>,
    edges: FlowDefinition["edges"],
    scope: string,
    parent: StepRun | null,
    index?: number,
  ): "active" | "done" | "failed" => {
    const rows = () => [...(byScope.get(scope)?.values() ?? [])].filter((s) => !s.superseded);
    for (const step of steps)
      if (!rows().some((r) => r.stepPath.at(-1) === step.id)) {
        const path = [...(parent?.stepPath ?? []), step.id];
        const attempts = [...byId.values()].filter(
          (r) => r.scope === scope && r.stepPath.at(-1) === step.id,
        ).length;
        put({
          id: FlowStepRunId.make(opaqueId(`${state.run.id}/${scope}/${step.id}/${attempts + 1}`)),
          flowRunId: state.run.id,
          stepPath: path,
          scope,
          parentStepRunId: parent?.id ?? null,
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
            {
              const ctx = context(scope, parent);
              const render = (text: string) =>
                renderFlowTemplate(
                  text,
                  ctx,
                  (id) =>
                    [...byId.values()].findLast((r) => r.stepPath.at(-1) === id && r.threadId)
                      ?.threadId ?? id,
                );
              if (step.kind === "agent") {
                const previous = step.thread === "continue" ? previousRun(s) : undefined;
                const sameAs = typeof step.thread === "object" ? step.thread.sameAs : undefined;
                const same = sameAs
                  ? [...byId.values()].findLast(
                      (r) =>
                        !r.superseded &&
                        r.stepPath.at(-1) === sameAs &&
                        r.threadId &&
                        (r.scope === scope || ctx.steps?.[sameAs]?.output === r.output),
                    )
                  : undefined;
                const candidateThreadId = (previous ?? same)?.threadId ?? null;
                const wasCancelled =
                  candidateThreadId &&
                  initial.stepRuns.some(
                    (old) =>
                      old.threadId === candidateThreadId &&
                      inFlight(old) &&
                      (get(old.id).status === "cancelled" || get(old.id).superseded),
                  );
                const reusedThreadId = wasCancelled ? null : candidateThreadId;
                const threadId = reusedThreadId ?? ThreadId.make(`flow-${opaqueId(s.id)}`);
                if (
                  reusedThreadId &&
                  [...byId.values()].some(
                    (r) => r.id !== s.id && active(r) && r.threadId === threadId,
                  )
                ) {
                  complete(s, null, fault("other", "Thread already has an active flow step"));
                  continue;
                }
                put({
                  ...s,
                  threadId,
                  expectedMessageId: s.id,
                  ...(sameAs && !reusedThreadId
                    ? { error: fault("other", `sameAs target ${sameAs} had no thread`) }
                    : {}),
                });
                actions.push({
                  type: reusedThreadId ? "continue_thread" : "launch_step_thread",
                  stepRunId: s.id,
                  threadId,
                  messageId: s.id,
                  prompt: render(step.prompt),
                  model:
                    step.model ?? (reusedThreadId ? undefined : state.definition.defaults?.model),
                  runtimeMode: step.runtimeMode ?? state.definition.defaults?.runtimeMode,
                  interactionMode:
                    step.interactionMode ?? state.definition.defaults?.interactionMode,
                });
              } else if (step.kind === "command")
                actions.push({
                  type: "start_command",
                  stepRunId: s.id,
                  command: step.command,
                  env: renderFlowCommandEnv(
                    step.env ?? {},
                    ctx,
                    (id) =>
                      [...byId.values()].findLast((r) => r.stepPath.at(-1) === id && r.threadId)
                        ?.threadId ?? id,
                  ),
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
                try {
                  put({ ...s, items: resolveFlowMapItems(step.over, ctx, step.maxItems) });
                } catch (error) {
                  if (!(error instanceof FlowValueError)) throw error;
                  complete(s, null, fault("max_items"));
                }
              }
            }
          }
          changed = true;
          s = get(s.id);
        }
        if (s.status === "running" && (step.kind === "loop" || step.kind === "map")) {
          const outputs = (childScope: string) =>
            Object.fromEntries(
              [...byId.values()]
                .filter((r) => r.scope === childScope && !r.superseded && r.output)
                .map((r) => [r.stepPath.at(-1)!, r.output!]),
            );
          if (step.kind === "loop") {
            let iteration = Math.max(
              0,
              ...[...(children.get(s.id)?.values() ?? [])]
                .filter((r) => !r.superseded)
                .map((r) => r.iteration ?? 0),
            );
            while (true) {
              const childScope = `${s.id}:${iteration}`;
              const result = runScope(step.steps, step.edges, childScope, s, iteration);
              if (result === "active") break;
              if (result === "failed") {
                complete(s, null, fault("other", "child failed"));
                break;
              }
              {
                const condition = evaluateFlowCondition(step.until, context(childScope, s));
                if (condition || iteration + 1 >= step.maxIterations) {
                  complete(s, {
                    steps: outputs(childScope),
                    kind: "loop",
                    iterations: iteration + 1,
                    exitReason: condition ? "condition" : "maxIterations",
                  });
                  break;
                }
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
              const exists = [...byId.values()].some(
                (r) => r.scope === childScope && !r.superseded,
              );
              if (!exists && running >= (step.concurrency ?? 1)) break;
              const result = runScope(step.steps, step.edges, childScope, s, i);
              if (result === "active") running++;
              else
                results.push({
                  status: result === "failed" ? "failed" : "succeeded",
                  outputs: outputs(childScope),
                });
              if (result === "failed" && step.onItemFailure !== "continue") {
                complete(s, null, fault("other", "child failed"));
                break;
              }
            }
            if (get(s.id).status === "running" && results.length === s.items?.length)
              complete(s, { kind: "map", items: results });
          }
          s = get(s.id);
        }
        if (terminal(s) && s.status !== "cancelled" && s.takenEdges === undefined) {
          const taken: number[] = [];
          {
            for (const [i, edge] of edges.entries())
              if (
                edge.from === step.id &&
                (edge.on === "failure" ? failed(s) : s.status === "succeeded") &&
                (!edge.when || evaluateFlowCondition(edge.when, context(scope, parent)))
              )
                taken.push(i);
          }
          put({ ...s, takenEdges: taken });
          changed = true;
        }
      }
    }
    const unhandled = rows().find(
      (s) => failed(s) && !s.takenEdges?.some((i) => edges[i]?.on === "failure"),
    );
    if (unhandled) {
      for (const running of [...byId.values()].filter(active)) {
        let owner = running.parentStepRunId ? get(running.parentStepRunId) : null;
        while (owner && owner.scope !== scope)
          owner = owner.parentStepRunId ? get(owner.parentStepRunId) : null;
        if (running.scope === scope || owner) cancel(running, "flow_failed", unhandled.id);
      }
      return "failed";
    }
    return rows().some(active) ? "active" : "done";
  };
  const result = runScope(state.definition.steps, state.definition.edges, "root", null);
  // A failed container cannot leave commands or agent turns running in its descendants.
  for (const s of [...byId.values()].filter(active)) {
    let parent = s.parentStepRunId ? get(s.parentStepRunId) : null;
    while (parent && !failed(parent))
      parent = parent.parentStepRunId ? get(parent.parentStepRunId) : null;
    if (parent) cancel(s, "flow_failed", parent.id);
  }
  const activeStepRunIds = [...byId.values()].filter(inFlight).map((s) => s.id);
  const status =
    result === "failed"
      ? "failed"
      : result === "done"
        ? "succeeded"
        : [...byId.values()].some((s) => !s.superseded && s.status === "waiting_approval")
          ? "waiting_approval"
          : "running";
  const run = {
    ...state.run,
    status,
    activeStepRunIds,
    startedAt: state.run.startedAt ?? trigger.at,
    finishedAt: result === "active" ? null : trigger.at,
    error: result === "failed" ? fault("other", "step failed") : null,
  } satisfies FlowRunSummary;
  if (JSON.stringify(run) !== JSON.stringify(state.run)) {
    emit({ type: "run", run });
    actions.push({ type: result === "active" ? "update_flow_run_thread" : "finish", status });
  }
  return finishDecision();
}
