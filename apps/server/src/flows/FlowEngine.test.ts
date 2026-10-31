import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type FlowDefinition, type FlowStep, type FlowInputs } from "@t3tools/contracts";
import { applyTransitions, decide, type Trigger, type Action } from "./FlowEngine.ts";

import { initialState } from "./flowTestUtils.ts";

const at = "2026-10-31T00:00:00.000Z";
const agent = (id: string): FlowStep => ({ id, kind: "agent", prompt: id });
const command = (id: string): FlowStep => ({ id, kind: "command", command: id });

function trace(definition: FlowDefinition, inputs: FlowInputs = {}) {
  let state = initialState(definition, inputs);
  let actions: ReadonlyArray<Action> = [];
  const send = (trigger: Trigger) => {
    const decision = decide(state, trigger);
    state = applyTransitions(state, decision.transitions);
    actions = decision.actions;
    return decision;
  };
  const row = (id: string) =>
    state.stepRuns.findLast((s) => !s.superseded && s.stepPath.at(-1) === id)!;
  let turn = 0;
  const settle = (id: string, error?: "turn_failed") =>
    send({
      type: "step_thread_settled",
      turnId: `turn-${turn++}`,
      at,
      stepRunId: row(id).id,
      text: `${id} result`,
      ...(error ? { error: { code: error, message: error } } : {}),
    });
  const finishCommand = (id: string, code = 0, timedOut = false) =>
    send({
      type: "command_finished",
      at,
      stepRunId: row(id).id,
      output: { kind: "command", lineCount: 1, text: id, exitCode: code, timedOut, lines: [id] },
    });
  send({ type: "start", at });
  return {
    get state() {
      return state;
    },
    get actions() {
      return actions;
    },
    send,
    row,
    settle,
    finishCommand,
  };
}
const graph = (
  steps: ReadonlyArray<FlowStep>,
  edges: FlowDefinition["edges"] = [],
): FlowDefinition => ({ version: 1, title: "Test", steps, edges });

describe("FlowEngine decision traces", () => {
  it.each([false, true])("sameAs falls back when target has no thread, skipped=%s", (skipped) => {
    const t = trace(
      graph(
        [
          agent("entry"),
          agent("target"),
          {
            id: "reuse",
            kind: "agent",
            thread: { sameAs: "target" },
            prompt: "{{steps.target.output.text}}",
          },
        ],
        [
          { from: "entry", to: "target", when: { ref: "inputs.take", op: "eq", value: true } },
          { from: "target", to: "reuse" },
          { from: "entry", to: "reuse" },
        ],
      ),
      { take: !skipped },
    );
    t.settle("entry");
    if (!skipped) t.settle("target");
    expect(t.row("reuse")).toMatchObject({
      status: "running",
      threadId: null,
      error: { code: "other", message: "sameAs target target had no thread" },
    });
    expect(t.actions.find((a) => a.type === "launch_step_thread")).toMatchObject({
      prompt: skipped ? "" : "target result",
    });
  });

  it("keeps commands literal and renders environment values", () => {
    const t = trace(
      graph([
        {
          id: "cmd",
          kind: "command",
          command: "echo $INPUT",
          env: { INPUT: "{{inputs.value}}", LINES: "{{inputs.lines}}" },
        },
      ]),
      { value: "$(touch surprise)", lines: ["one", "two"] },
    );
    expect(t.actions[0]).toMatchObject({
      type: "start_command",
      command: "echo $INPUT",
      env: { INPUT: "$(touch surprise)", LINES: "one\ntwo" },
    });
  });

  it("never starts concurrent steps on the same existing thread", () => {
    const t = trace(
      graph(
        [
          agent("entry"),
          { id: "left", kind: "agent", prompt: "left", thread: { sameAs: "entry" } },
          { id: "right", kind: "agent", prompt: "right", thread: { sameAs: "entry" } },
        ],
        [
          { from: "entry", to: "left" },
          { from: "entry", to: "right" },
        ],
      ),
    );
    t.send({
      type: "thread_started",
      at,
      stepRunId: t.row("entry").id,
      threadId: ThreadId.make("shared"),
    });
    t.settle("entry");
    expect(t.actions.filter((action) => action.type === "continue_thread")).toHaveLength(1);
    expect(t.row("right").error?.message).toBe("Thread already has an active flow step");
    expect(t.state.run.status).toBe("failed");
  });

  it("rejects a truncated command list before starting map children", () => {
    const t = trace(
      graph(
        [
          command("cmd"),
          {
            id: "map",
            kind: "map",
            over: "steps.cmd.output.lines",
            maxItems: 500,
            steps: [agent("child")],
            edges: [],
          },
        ],
        [{ from: "cmd", to: "map" }],
      ),
    );
    t.send({
      type: "command_finished",
      at,
      stepRunId: t.row("cmd").id,
      output: {
        kind: "command",
        lineCount: 300,
        lines: ["one"],
        text: "",
        exitCode: 0,
        timedOut: false,
      },
    });
    expect(t.row("map").status).toBe("failed");
    expect(t.row("map").error?.code).toBe("max_items");
    expect(t.state.stepRuns.some((s) => s.stepPath.at(-1) === "child")).toBe(false);
  });

  it("nested children carry only their own coordinates and their exact parent", () => {
    const t = trace(
      graph([
        {
          id: "outer",
          kind: "loop",
          maxIterations: 2,
          until: { ref: "iteration", op: "eq", value: 1 },
          steps: [
            { id: "map", kind: "map", over: "inputs.items", steps: [agent("child")], edges: [] },
          ],
          edges: [],
        },
      ]),
      { items: ["one"] },
    );
    const first = t.row("child");
    expect(first).toMatchObject({ parentStepRunId: t.row("map").id, itemIndex: 0 });
    expect(first.iteration).toBeUndefined();
    t.settle("child");
    const second = t.row("child");
    expect(second.parentStepRunId).not.toBe(first.parentStepRunId);
    expect(t.row("map")).toMatchObject({ parentStepRunId: t.row("outer").id, iteration: 1 });
  });
  it("retry invalidates later loop iterations before continuing from the failed iteration", () => {
    const t = trace(
      graph([
        {
          id: "loop",
          kind: "loop",
          maxIterations: 2,
          until: { ref: "iteration", op: "eq", value: 1 },
          steps: [agent("a"), agent("recovery")],
          edges: [{ from: "a", to: "recovery", on: "failure" }],
        },
      ]),
    );
    t.settle("a", "turn_failed");
    const failedId = t.row("a").id;
    t.settle("recovery");
    t.settle("a");
    expect(t.state.run.status).toBe("succeeded");
    t.send({ type: "retry_step", at, stepRunId: failedId });
    expect(t.state.run.status).toBe("running");
    expect(t.row("a")).toMatchObject({ attempt: 2, iteration: 0, status: "running" });
    t.settle("a");
    t.settle("a");
    expect(t.state.run.status).toBe("succeeded");
    expect(t.state.run.activeStepRunIds).toEqual([]);
  });

  it("retry cancels and supersedes descendants of invalidated dependent containers", () => {
    const t = trace(
      graph(
        [
          agent("a"),
          {
            id: "loop",
            kind: "loop",
            maxIterations: 1,
            until: { ref: "iteration", op: "eq", value: 0 },
            steps: [agent("b")],
            edges: [],
          },
        ],
        [{ from: "a", to: "loop", on: "failure" }],
      ),
    );
    t.settle("a", "turn_failed");
    expect(t.row("b").status).toBe("running");
    t.send({ type: "retry_step", at, stepRunId: t.row("a").id });
    expect(
      t.state.stepRuns
        .filter((s) => !s.superseded && s.status === "running")
        .map((s) => s.stepPath.at(-1)),
    ).toEqual(["a"]);
    t.settle("a");
    expect(t.state.run.status).toBe("succeeded");
    expect(t.state.run.activeStepRunIds).toEqual([]);
  });

  it("does not mistake a replayed turn completion for the reminder's completion", () => {
    const t = trace(
      graph([
        { id: "a", kind: "agent", prompt: "work", outputs: [{ name: "ok", type: "boolean" }] },
      ]),
    );
    const settled: Trigger = {
      type: "step_thread_settled",
      at,
      turnId: "original",
      stepRunId: t.row("a").id,
      text: "done",
    };
    t.send(settled);
    expect(t.send(settled)).toEqual({ transitions: [], actions: [] });
    expect(t.row("a").status).toBe("waiting_report");
    t.send({ ...settled, turnId: "reminder" });
    expect(t.row("a").error?.code).toBe("missing_report");
  });

  it("nested map and loop scopes retain outer item bindings and outputs", () => {
    const t = trace(
      graph([
        {
          id: "map",
          kind: "map",
          over: "inputs.items",
          steps: [
            {
              id: "loop",
              kind: "loop",
              maxIterations: 1,
              until: { ref: "iteration", op: "eq", value: 0 },
              steps: [{ id: "a", kind: "agent", prompt: "{{item}}/{{index}}/{{iteration}}" }],
              edges: [],
            },
          ],
          edges: [],
        },
      ]),
      { items: ["first", "second"] },
    );
    expect(t.actions.find((a) => a.type === "launch_step_thread")).toMatchObject({
      prompt: "first/0/0",
    });
    t.settle("a");
    expect(t.actions.find((a) => a.type === "launch_step_thread")).toMatchObject({
      prompt: "second/1/0",
    });
    t.settle("a");
    expect(t.state.run.status).toBe("succeeded");
    expect(t.row("map").output).toMatchObject({
      items: [{ outputs: { loop: { iterations: 1 } } }, { outputs: { loop: { iterations: 1 } } }],
    });
  });

  it("renders previous iteration outputs only in the current loop scope", () => {
    const t = trace(
      graph([
        {
          id: "loop",
          kind: "loop",
          maxIterations: 2,
          until: { ref: "iteration", op: "eq", value: 1 },
          steps: [
            agent("a"),
            { id: "read-previous", kind: "agent", prompt: "{{steps.a.previous.output.text}}" },
          ],
          edges: [
            { from: "a", to: "read-previous", when: { ref: "iteration", op: "gt", value: 0 } },
          ],
        },
      ]),
    );
    t.settle("a");
    expect(t.row("read-previous").status).toBe("pending");
    t.settle("a");
    expect(t.actions.find((a) => a.type === "launch_step_thread")).toMatchObject({
      prompt: "a result",
    });
    t.settle("read-previous");
    expect(t.state.run.status).toBe("succeeded");
  });

  it("failed map items cancel their parallel work even when other items continue", () => {
    const t = trace(
      graph([
        {
          id: "map",
          kind: "map",
          over: "inputs.items",
          onItemFailure: "continue",
          steps: [agent("a"), command("cmd")],
          edges: [],
        },
      ]),
      { items: ["one"] },
    );
    t.settle("a", "turn_failed");
    expect(t.row("cmd").status).toBe("cancelled");
    expect(t.actions.map((a) => a.type)).toContain("kill_command");
    expect(t.state.run.status).toBe("succeeded");
    expect(t.state.run.activeStepRunIds).toEqual([]);
  });

  it("retry restores cancelled independent work and a failed container's parents", () => {
    const t = trace(
      graph([
        {
          id: "loop",
          kind: "loop",
          maxIterations: 1,
          until: { ref: "iteration", op: "eq", value: 0 },
          steps: [agent("a")],
          edges: [],
        },
        agent("parallel"),
      ]),
    );
    t.settle("a", "turn_failed");
    expect(t.row("parallel").status).toBe("cancelled");
    t.send({ type: "retry_step", at, stepRunId: t.row("a").id });
    expect(t.row("parallel").status).toBe("running");
    t.settle("a");
    t.settle("parallel");
    expect(t.state.run.status).toBe("succeeded");
  });

  it.each([
    {
      name: "sequence",
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
      start: ["running", "pending", "pending"],
      afterA: ["succeeded", "running", "pending"],
    },
    {
      name: "fan-out",
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ],
      start: ["running", "pending", "pending"],
      afterA: ["succeeded", "running", "running"],
    },
    {
      name: "parallel entries",
      edges: [],
      start: ["running", "running", "running"],
      afterA: ["succeeded", "running", "running"],
    },
  ])("$name", ({ edges, start, afterA }) => {
    const t = trace(graph([agent("a"), agent("b"), agent("c")], edges));
    expect(["a", "b", "c"].map((id) => t.row(id).status)).toEqual(start);
    t.settle("a");
    expect(["a", "b", "c"].map((id) => t.row(id).status)).toEqual(afterA);
    t.settle("b");
    t.settle("c");
    expect(t.state.run.status).toBe("succeeded");
    expect(t.send({ type: "start", at }).actions).toEqual([]);
    expect(t.settle("a").transitions).toEqual([]);
  });

  it.each([true, false])("join waits for every edge, taken=%s", (taken) => {
    const t = trace(
      graph(
        [agent("a"), agent("b"), agent("c"), agent("join")],
        [
          { from: "a", to: "b", when: { ref: "inputs.take", op: "eq", value: true } },
          { from: "b", to: "join" },
          { from: "c", to: "join" },
        ],
      ),
      { take: taken },
    );
    t.settle("a");
    expect(t.row("b").status).toBe(taken ? "running" : "skipped");
    expect(t.row("join").status).toBe("pending");
    t.settle("c");
    expect(t.row("join").status).toBe(taken ? "pending" : "running");
    if (taken) t.settle("b");
    t.settle("join");
    expect(t.state.run.status).toBe("succeeded");
  });

  it("propagates skipped branches to their leaves", () => {
    const t = trace(
      graph(
        [agent("a"), agent("b"), agent("c")],
        [
          { from: "a", to: "b", when: { ref: "inputs.take", op: "eq", value: true } },
          { from: "b", to: "c" },
        ],
      ),
      { take: false },
    );
    t.settle("a");
    expect([t.row("b").status, t.row("c").status, t.state.run.status]).toEqual([
      "skipped",
      "skipped",
      "succeeded",
    ]);
  });

  it.each([0, 7])("nonzero command exit remains successful: %i", (code) => {
    const t = trace(
      graph(
        [command("cmd"), agent("ok"), agent("bad")],
        [
          { from: "cmd", to: "ok", when: { ref: "steps.cmd.output.exitCode", op: "eq", value: 0 } },
          {
            from: "cmd",
            to: "bad",
            when: { ref: "steps.cmd.output.exitCode", op: "neq", value: 0 },
          },
        ],
      ),
    );
    t.finishCommand("cmd", code);
    expect(t.row("cmd").status).toBe("succeeded");
    expect(t.row(code ? "bad" : "ok").status).toBe("running");
  });

  it.each([true, false])("failure edge routing: handled=%s", (handled) => {
    const t = trace(
      graph(
        [agent("a"), agent("handler"), agent("success")],
        [
          ...(handled
            ? [{ from: "a", to: "handler", on: "failure" as const }]
            : [{ from: "a", to: "handler" }]),
          { from: "a", to: "success" },
        ],
      ),
    );
    t.settle("a", "turn_failed");
    expect(t.state.run.status).toBe(handled ? "running" : "failed");
    expect(t.row("success").status).toBe("skipped");
    if (handled) {
      t.settle("handler");
      expect(t.state.run.status).toBe("succeeded");
    }
  });

  it("one reminder, valid reports, and duplicate completion guards", () => {
    const step: FlowStep = {
      ...agent("a"),
      kind: "agent",
      prompt: "report",
      outputs: [{ name: "ok", type: "boolean" }],
    };
    const t = trace(graph([step]));
    expect(() =>
      t.send({ type: "report_received", at, stepRunId: t.row("a").id, fields: { ok: "wrong" } }),
    ).toThrow();
    t.settle("a");
    expect(t.row("a").status).toBe("waiting_report");
    expect(t.actions.filter((a) => a.type === "send_reminder")).toHaveLength(1);
    t.send({ type: "report_received", at, stepRunId: t.row("a").id, fields: { ok: true } });
    t.settle("a");
    expect(t.row("a").output).toEqual({ kind: "agent", text: "a result", ok: true });
    expect(t.state.run.status).toBe("succeeded");
    const missing = trace(graph([step]));
    missing.settle("a");
    missing.settle("a");
    expect(missing.row("a").error?.code).toBe("missing_report");
    expect(missing.state.run.status).toBe("failed");
  });

  it.each([1, 3])("loop exits at maxIterations=%i and continues its thread", (maxIterations) => {
    const t = trace(
      graph([
        {
          id: "loop",
          kind: "loop",
          maxIterations,
          until: { ref: "inputs.done", op: "eq", value: true },
          steps: [
            { id: "a", kind: "agent", prompt: "iteration {{iteration}}", thread: "continue" },
          ],
          edges: [],
        },
      ]),
      { done: false },
    );
    for (let i = 0; i < maxIterations; i++) {
      const action = t.actions.find(
        (a) => a.type === "launch_step_thread" || a.type === "continue_thread",
      );
      expect(action?.type).toBe(i === 0 ? "launch_step_thread" : "continue_thread");
      expect(action && "prompt" in action ? action.prompt : null).toBe(`iteration ${i}`);
      t.send({
        type: "thread_started",
        at,
        stepRunId: t.row("a").id,
        threadId: ThreadId.make("same-thread"),
      });
      t.settle("a");
    }
    expect(t.row("loop").output).toEqual({
      kind: "loop",
      iterations: maxIterations,
      exitReason: "maxIterations",
      a: { kind: "agent", text: "a result" },
    });
  });

  it("loop condition uses inner output and previous output is rendered", () => {
    const t = trace(
      graph([
        {
          id: "loop",
          kind: "loop",
          maxIterations: 5,
          until: { ref: "steps.a.output.done", op: "eq", value: true },
          steps: [
            {
              id: "a",
              kind: "agent",
              prompt: "work",
              outputs: [{ name: "done", type: "boolean" }],
            },
          ],
          edges: [],
        },
      ]),
    );
    t.send({ type: "report_received", at, stepRunId: t.row("a").id, fields: { done: true } });
    t.settle("a");
    expect(t.row("loop").output).toMatchObject({ iterations: 1, exitReason: "condition" });
  });

  it("sameAs reuses an ancestor's thread without replacing its model with defaults", () => {
    const definition = graph(
      [
        agent("a"),
        {
          id: "loop",
          kind: "loop",
          maxIterations: 1,
          until: { ref: "inputs.done", op: "eq", value: true },
          steps: [
            {
              id: "fix",
              kind: "agent",
              thread: { sameAs: "a" },
              prompt: "{{steps.a.output.text}}",
            },
          ],
          edges: [],
        },
      ],
      [{ from: "a", to: "loop" }],
    );
    const t = trace(
      { ...definition, defaults: { model: { providerInstanceId: "codex", model: "default" } } },
      { done: true },
    );
    t.send({
      type: "thread_started",
      at,
      stepRunId: t.row("a").id,
      threadId: ThreadId.make("reuse"),
    });
    t.settle("a");
    expect(t.actions.find((a) => a.type === "continue_thread")).toMatchObject({
      threadId: "reuse",
      model: undefined,
      prompt: "a result",
    });
  });

  it.each(["fail", "continue"] as const)(
    "map concurrency, input order, and onItemFailure=%s",
    (onItemFailure) => {
      const t = trace(
        graph([
          {
            id: "map",
            kind: "map",
            over: "inputs.items",
            concurrency: 2,
            onItemFailure,
            steps: [{ id: "a", kind: "agent", prompt: "{{index}}: {{item}}" }],
            edges: [],
          },
        ]),
        { items: ["first", "second", "third"] },
      );
      const leaves = () => t.state.stepRuns.filter((s) => s.stepPath.at(-1) === "a");
      expect(leaves().filter((s) => s.status === "running")).toHaveLength(2);
      t.send({
        type: "step_thread_settled",
        turnId: "turn",
        at,
        stepRunId: leaves()[1]!.id,
        text: "second",
        error: { code: "turn_failed", message: "failed" },
      });
      if (onItemFailure === "fail") {
        expect(t.state.run.status).toBe("failed");
        expect(leaves()[0]!.status).toBe("cancelled");
      } else {
        expect(leaves().filter((s) => s.status === "running")).toHaveLength(2);
        t.send({
          type: "step_thread_settled",
          turnId: "turn",
          at,
          stepRunId: leaves()[2]!.id,
          text: "third",
        });
        t.send({
          type: "step_thread_settled",
          turnId: "turn",
          at,
          stepRunId: leaves()[0]!.id,
          text: "first",
        });
        expect(t.row("map").output).toEqual({
          kind: "map",
          items: [
            { status: "succeeded", outputs: { a: { kind: "agent", text: "first" } } },
            { status: "failed", outputs: { a: { kind: "agent", text: "second" } } },
            { status: "succeeded", outputs: { a: { kind: "agent", text: "third" } } },
          ],
        });
      }
    },
  );

  it.each([{ items: [] }, { items: ["a", "b"] }])(
    "empty maps succeed and oversized maps fail: $items",
    ({ items }) => {
      const t = trace(
        graph([
          {
            id: "map",
            kind: "map",
            maxItems: 1,
            over: "inputs.items",
            steps: [agent("a")],
            edges: [],
          },
        ]),
        { items },
      );
      expect(t.state.run.status).toBe(items.length ? "failed" : "succeeded");
    },
  );

  it("approvals wait durably and rejection is an output", () => {
    const t = trace(graph([{ id: "gate", kind: "approval", prompt: "Review {{inputs.title}}" }]), {
      title: "change",
    });
    expect(t.state.run.status).toBe("waiting_approval");
    t.send({ type: "recovered", at, continuingThreadIds: [] });
    expect(t.state.approvals[0]?.prompt).toBe("Review change");
    t.send({
      type: "approval_answered",
      at,
      stepRunId: t.row("gate").id,
      decision: "reject",
      comment: "revise",
      answeredBy: "user",
    });
    expect(t.state.run.status).toBe("succeeded");
    expect(t.state.approvals[0]).toMatchObject({
      decision: "reject",
      comment: "revise",
      answeredBy: "user",
    });
  });

  it("stop interrupts agents, kills commands, cancels approvals; resume retries all", () => {
    const t = trace(
      graph([agent("a"), command("cmd"), { id: "gate", kind: "approval", prompt: "ok?" }]),
    );
    t.send({ type: "stop", at });
    expect(t.state.run.status).toBe("cancelled");
    expect(t.actions.map((a) => a.type)).toEqual(["interrupt_turn", "kill_command", "finish"]);
    t.send({ type: "resume", at });
    expect(["a", "cmd", "gate"].map((id) => t.row(id).attempt)).toEqual([2, 2, 2]);
    expect(t.state.run.status).toBe("waiting_approval");
  });

  it("retry invalidates dependent skips while keeping independent successes", () => {
    const t = trace(
      graph([agent("a"), agent("b"), agent("independent")], [{ from: "a", to: "b" }]),
    );
    t.settle("independent");
    t.settle("a", "turn_failed");
    t.send({ type: "retry_step", at, stepRunId: t.row("a").id });
    expect(t.row("a").attempt).toBe(2);
    expect(t.row("independent").attempt).toBe(1);
    t.settle("a");
    expect(t.row("b").status).toBe("running");
    t.settle("b");
    expect(t.state.run.status).toBe("succeeded");
  });

  it.each([true, false])("restart agent auto-continuation=%s", (continuing) => {
    const t = trace(graph([agent("a")]));
    t.send({
      type: "thread_started",
      at,
      stepRunId: t.row("a").id,
      threadId: ThreadId.make("child"),
    });
    t.send({
      type: "recovered",
      at,
      continuingThreadIds: continuing ? [ThreadId.make("child")] : [],
    });
    expect(t.row("a").status).toBe(continuing ? "running" : "interrupted");
  });

  it("restart interrupts commands and timeout is failure", () => {
    const t = trace(graph([command("cmd")]));
    t.send({ type: "recovered", at, continuingThreadIds: [] });
    expect(t.row("cmd").error?.code).toBe("interrupted");
    t.send({ type: "retry_step", at, stepRunId: t.row("cmd").id });
    t.finishCommand("cmd", 0, true);
    expect(t.row("cmd").error?.code).toBe("command_timeout");
  });
});
