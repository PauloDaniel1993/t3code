import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { FlowDefinition, FlowCondition } from "./flowDefinition.ts";
import { FlowOutputFields, FlowStepOutput } from "./flowRun.ts";

const decodeDefinition = Schema.decodeUnknownSync(FlowDefinition);
const decodeCondition = Schema.decodeUnknownSync(FlowCondition);
const decodeFields = Schema.decodeUnknownSync(FlowOutputFields, { onExcessProperty: "error" });
const decodeOutput = Schema.decodeUnknownSync(FlowStepOutput);
const encodeOutput = Schema.encodeSync(FlowStepOutput);

it("decodes nested loop and map steps and condition combinators", () => {
  const value = {
    version: 1,
    title: "Nested",
    steps: [
      {
        id: "repeat",
        kind: "loop",
        maxIterations: 2,
        until: { all: [{ not: { any: [{ ref: "iteration", op: "lt", value: 2 }] } }] },
        steps: [
          {
            id: "each",
            kind: "map",
            over: "inputs.files",
            steps: [{ id: "approve", kind: "approval", prompt: "Okay?" }],
            edges: [],
          },
        ],
        edges: [],
      },
    ],
    edges: [],
  };
  expect(decodeDefinition(value)).toEqual(value);
  expect(() => decodeCondition({ not: { ref: "iteration", op: "eq" } })).toThrow();
  expect(() =>
    decodeDefinition({
      ...value,
      steps: [{ ...value.steps[0], steps: [{ id: "bad", kind: "unknown" }] }],
    }),
  ).toThrow();
});
it.each([
  { kind: "agent", text: "done", exitCode: 0, timedOut: false, lines: ["retained"] },
  { kind: "agent", text: "done", decision: "approve", verdict: "approve", issues: ["one"] },
  {
    kind: "command",
    lineCount: 1,
    exitCode: 1,
    timedOut: false,
    text: "failure",
    lines: ["failure"],
  },
  { kind: "approval", decision: "approve", comment: "okay" },
  {
    kind: "loop",
    iterations: 2,
    exitReason: "condition",
    inner: {
      kind: "map",
      items: [{ status: "succeeded", outputs: { agent: { kind: "agent", text: "done" } } }],
    },
  },
])("decodes step outputs $", (value) => expect(encodeOutput(decodeOutput(value))).toEqual(value));

it("streams output metadata without duplicating container children or text", () => {
  for (const value of [
    { kind: "loop", iterations: 1, exitReason: "condition" },
    { kind: "map", items: [{ status: "succeeded" }] },
    { kind: "command", exitCode: 1, timedOut: false, lineCount: 300 },
  ])
    expect(decodeFields(value)).toEqual(value);
  expect(() => decodeFields({ kind: "agent", fields: { text: "large message" } })).toThrow();
  expect(() =>
    decodeFields({ kind: "loop", iterations: 1, exitReason: "condition", steps: {} }),
  ).toThrow();
  expect(() =>
    decodeOutput({ kind: "loop", iterations: 1, exitReason: "condition", inner: 12 }),
  ).toThrow();
});
