import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { FlowDefinition, FlowCondition } from "./flowDefinition.ts";
import { FlowOutputFields, FlowStepOutput } from "./flowRun.ts";

const decodeDefinition = Schema.decodeUnknownSync(FlowDefinition);
const decodeCondition = Schema.decodeUnknownSync(FlowCondition);
const decodeFields = Schema.decodeUnknownSync(FlowOutputFields, { onExcessProperty: "error" });
const decodeOutput = Schema.decodeUnknownSync(FlowStepOutput);

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
  { text: "done", verdict: "approve", issues: ["one"] },
  { exitCode: 1, timedOut: false, text: "failure", lines: ["failure"] },
  { decision: "approve", comment: "okay" },
  {
    iterations: 2,
    exitReason: "condition",
    inner: { items: [{ status: "succeeded", outputs: { agent: { text: "done" } } }] },
  },
])("decodes step outputs $", (value) => expect(decodeOutput(value)).toEqual(value));

it("keeps nested streamed output fields separate from full output", () => {
  const value = {
    kind: "loop",
    iterations: 1,
    exitReason: "condition",
    steps: {
      review: { kind: "agent", fields: { verdict: "approve" } },
      test: { kind: "command" },
    },
  };
  expect(decodeFields(value)).toEqual(value);
  expect(() =>
    decodeFields({ ...value, steps: { test: { kind: "command", text: "large log" } } }),
  ).toThrow();
  expect(() => decodeFields({ kind: "agent", fields: { text: "large message" } })).toThrow();
  expect(() => decodeOutput({ iterations: 1, exitReason: "condition", inner: 12 })).toThrow();
});
