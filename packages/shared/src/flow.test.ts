import { flowDefinitionRevision, serializeFlowDefinition } from "./flow.ts";
import { expect, it } from "vite-plus/test";
import {
  capFlowCommandOutput,
  capFlowText,
  coerceFlowInputs,
  resolveFlowInputs,
  resolveFlowMapItems,
  renderFlowCommandEnv,
  evaluateFlowCondition,
  FlowValueError,
  parseFlowReference,
  renderFlowTemplate,
  resolveFlowReference,
  validateFlowReport,
} from "./flow.ts";
import type { FlowCondition, FlowInput } from "@t3tools/contracts";

const context = {
  inputs: { count: 3, enabled: true, files: ["a", "b"], empty: [] },
  steps: {
    review: {
      output: { text: "Done", verdict: "approve", issues: ["one", "two"] },
      previous: { output: { text: "Before" } },
    },
  },
  item: "a",
  index: 0,
  iteration: 2,
};
it.each<{ condition: FlowCondition; expected: boolean }>([
  { condition: { ref: "inputs.count", op: "eq", value: 3 }, expected: true },
  { condition: { ref: "inputs.count", op: "eq", value: "3" }, expected: false },
  { condition: { ref: "inputs.count", op: "neq", value: 4 }, expected: true },
  { condition: { ref: "inputs.files", op: "eq", value: ["a", "b"] }, expected: true },
  { condition: { ref: "inputs.count", op: "lt", value: 4 }, expected: true },
  { condition: { ref: "inputs.count", op: "lte", value: 3 }, expected: true },
  { condition: { ref: "inputs.count", op: "gt", value: 2 }, expected: true },
  { condition: { ref: "inputs.count", op: "gte", value: 3 }, expected: true },
  { condition: { ref: "inputs.count", op: "gte", value: "3" }, expected: false },
  { condition: { ref: "inputs.files", op: "contains", value: "a" }, expected: true },
  { condition: { ref: "steps.review.output.text", op: "contains", value: "on" }, expected: true },
  { condition: { ref: "inputs.empty", op: "isEmpty" }, expected: true },
  ...(["eq", "neq", "lt", "lte", "gt", "gte", "contains"] as const).map((op) => ({
    condition: { ref: "steps.skipped.output.text", op, value: "" },
    expected: false,
  })),
  { condition: { ref: "inputs.unset", op: "isEmpty" }, expected: true },
  { condition: { ref: "steps.gate.output.comment", op: "isEmpty" }, expected: true },
  {
    condition: {
      all: [
        { ref: "inputs.enabled", op: "eq", value: true },
        {
          not: {
            any: [
              { ref: "inputs.count", op: "lt", value: 0 },
              { ref: "inputs.files", op: "isEmpty" },
            ],
          },
        },
      ],
    },
    expected: true,
  },
])("evaluates $condition", ({ condition, expected }) =>
  expect(evaluateFlowCondition(condition, context)).toBe(expected),
);

it.each([
  ["{{steps.review.output.issues}}", "- one\n- two"],
  ["{{item}}: {{index}} / {{iteration}} / {{inputs.enabled}}", "a: 0 / 2 / true"],
  ["{{ steps.review.previous.output.text }} {{steps.review.output.verdict}}", "Before approve"],
  ["{{inputs.empty}}", ""],
  ["{{inputs.unset}}/{{steps.skipped.output.text}}", "/"],
  ["{{steps.review.output.comment}}", ""],
  [String.raw`\{{literal}}`, "{{literal}}"],
  [String.raw`\{{`, "{{"],
])("renders %s", (template, expected) =>
  expect(renderFlowTemplate(template, context, () => "Review thread")).toBe(expected),
);
it.each(["steps.review.output.issues.join()"])("rejects unresolved reference %s", (reference) => {
  expect(() => resolveFlowReference(reference, context, "$.prompt")).toThrow(FlowValueError);
  try {
    resolveFlowReference(reference, context, "$.prompt");
  } catch (error) {
    expect(error).toHaveProperty("path", "$.prompt");
  }
});
it("parses references and refuses incomplete templates", () => {
  expect(parseFlowReference("steps.review.previous.output.text")).toEqual({
    kind: "step",
    stepId: "review",
    previous: true,
    fields: ["text"],
  });
  expect(renderFlowTemplate("{{item", context, () => "Review")).toBe("{{item");
  expect(renderFlowTemplate("{{bad()}}", context, () => "Review")).toBe("");
  expect(evaluateFlowCondition({ ref: "bad()", op: "isEmpty" }, context)).toBe(true);
  expect(renderFlowTemplate("{{steps.review.previous.output.text}}", {}, () => "Review")).toBe("");
});
it("caps UTF-8 text with its source thread and preserves bounded output", () => {
  const text = "😀".repeat(5000);
  const capped = capFlowText(text, "Review thread");
  expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(16_000);
  expect(capped).toContain("[Truncated; full output in Review thread]");
  expect(capped).not.toContain("�");
  expect(capFlowText("ok", "Review")).toBe("ok");
  expect(
    renderFlowTemplate(
      "{{steps.review.output.text}}",
      { steps: { review: { output: { text } } } },
      () => "Review thread",
    ),
  ).toBe(capped);
});
const inputs: ReadonlyArray<FlowInput> = [
  { name: "count", type: "number", required: true },
  { name: "enabled", type: "boolean", default: false },
  { name: "files", type: "string[]" },
  { name: "title", type: "string" },
];
it.each([
  {
    values: { count: " 2.5 ", enabled: "true", files: '["a","b"]', title: " hi " },
    expected: { count: 2.5, enabled: true, files: ["a", "b"], title: " hi " },
  },
  {
    values: { count: "0", files: "a\r\n\n b\n" },
    expected: { count: 0, enabled: false, files: ["a", "b"] },
  },
  {
    values: { count: "1", files: "[WIP] fix\nsecond" },
    expected: { count: 1, enabled: false, files: ["[WIP] fix", "second"] },
  },
  { values: { count: "1e2", files: "" }, expected: { count: 100, enabled: false, files: [] } },
])("coerces $values", ({ values, expected }) =>
  expect(coerceFlowInputs(inputs, values)).toEqual(expected),
);
it.each([
  { values: {}, path: "$.inputs.count" },
  { values: { count: "" }, path: "$.inputs.count" },
  { values: { count: "Infinity" }, path: "$.inputs.count" },
  { values: { count: "1", enabled: "yes" }, path: "$.inputs.enabled" },
  { values: { count: "1", files: "[1]" }, path: "$.inputs.files" },

  { values: { count: "1", extra: "x" }, path: "$.inputs.extra" },
])("rejects input at $path", ({ values, path }) => {
  try {
    coerceFlowInputs(inputs, values);
    throw new Error("Expected coercion error");
  } catch (error) {
    expect(error).toHaveProperty("path", path);
  }
});
it.each([
  { fields: [{ name: "x", type: "string" }], value: { x: "é".repeat(2048) }, valid: true },
  { fields: [{ name: "x", type: "string" }], value: { x: "é".repeat(2049) }, valid: false },
  { fields: [{ name: "x", type: "string[]" }], value: { x: Array(200).fill("ok") }, valid: true },
  { fields: [{ name: "x", type: "string[]" }], value: { x: Array(201).fill("ok") }, valid: false },
  { fields: [{ name: "x", type: "string[]" }], value: { x: ["x".repeat(4097)] }, valid: false },
  { fields: [{ name: "x", type: "enum", values: ["yes"] }], value: { x: "no" }, valid: false },
  { fields: [{ name: "x", type: "number" }], value: { x: NaN }, valid: false },
  { fields: [{ name: "x", type: "boolean" }], value: { x: true, extra: "no" }, valid: false },
  { fields: [{ name: "x", type: "boolean" }], value: {}, valid: false },
] satisfies ReadonlyArray<{
  fields: ReadonlyArray<import("@t3tools/contracts").FlowOutputField>;
  value: unknown;
  valid: boolean;
}>)("validates output limits $valid", ({ fields, value, valid }) =>
  expect(validateFlowReport(fields, value).valid).toBe(valid),
);
it("retains the bounded UTF-8 command tail and nonempty stdout lines", () => {
  const output = capFlowCommandOutput(
    "prefix" + "😀".repeat(5000) + "end",
    "\n a\n\n b\n" + "c\n".repeat(300),
  );
  expect(output.text.endsWith("end")).toBe(true);
  expect(output.text).not.toContain("�");
  expect(new TextEncoder().encode(output.text).length).toBeLessThanOrEqual(16_384);
  expect(output.lines).toHaveLength(200);
  expect(output.lineCount).toBe(302);
  expect(output.lines.slice(0, 2)).toEqual([" a", " b"]);
});

it.each([
  { values: {}, path: "$.inputs.count" },
  { values: { count: "3" }, path: "$.inputs.count" },
  { values: { count: Infinity }, path: "$.inputs.count" },
  { values: { count: 1, enabled: "true" }, path: "$.inputs.enabled" },
  { values: { count: 1, files: [1] }, path: "$.inputs.files" },
  { values: { count: 1, title: false }, path: "$.inputs.title" },
  { values: { count: 1, extra: "x" }, path: "$.inputs.extra" },
])("checks typed inputs at $path", ({ values, path }) => {
  expect(() => resolveFlowInputs(inputs, values)).toThrow(expect.objectContaining({ path }));
});
it("resolves typed input defaults and optional values", () => {
  expect(resolveFlowInputs(inputs, { count: 3, files: ["a"] })).toEqual({
    count: 3,
    enabled: false,
    files: ["a"],
  });
});
it("renders command environment values without prompt bullets or shell quoting", () => {
  expect(
    renderFlowCommandEnv(
      { FILES: "{{inputs.files}}", VALUE: "{{inputs.value}}", UNSET: "{{inputs.unset}}" },
      {
        inputs: { files: ["a", "b"], value: '1; echo "$x"' },
      },
      () => "thread",
    ),
  ).toEqual({ FILES: "a\nb", VALUE: '1; echo "$x"', UNSET: "" });
});
it("names the innermost source thread in a nested truncation marker", () => {
  const output = renderFlowTemplate(
    "{{steps.outer.output.inner.review.text}}",
    {
      steps: { outer: { output: { inner: { review: { text: "x".repeat(17000) } } } } },
    },
    (id) => `${id} thread`,
  );
  expect(output).toContain("full output in review thread");
});

it.each([
  { count: 49, maxItems: 50, valid: true },
  { count: 50, maxItems: 50, valid: true },
  { count: 51, maxItems: 50, valid: false },
  { count: 200, maxItems: 500, valid: true },
  { count: 300, maxItems: 500, valid: false },
])(
  "checks command map size $count against $maxItems without silent truncation",
  ({ count, maxItems, valid }) => {
    const output = { kind: "command", ...capFlowCommandOutput("", "line\n".repeat(count)) };
    const context = { steps: { loop: { output: { steps: { command: output } } } } };
    const read = () =>
      resolveFlowMapItems("steps.loop.output.steps.command.lines", context, maxItems);
    if (valid) expect(read()).toHaveLength(count);
    else expect(read).toThrow(FlowValueError);
  },
);
it("checks map inputs and missing lists", () => {
  expect(resolveFlowMapItems("inputs.files", context)).toEqual(["a", "b"]);
  expect(() => resolveFlowMapItems("inputs.files", context, 1)).toThrow("maxItems");
  expect(() => resolveFlowMapItems("inputs.missing", context)).toThrow("available string[]");
});

it("hashes the canonical flow file independently of object key order", () => {
  const left = { version: 1, title: "Flow", steps: [], edges: [], layout: { a: { x: 1, y: 2 } } };
  const right = { layout: { a: { y: 2, x: 1 } }, edges: [], steps: [], title: "Flow", version: 1 };
  expect(flowDefinitionRevision(left)).toBe(flowDefinitionRevision(right));
  expect(flowDefinitionRevision({ ...left, title: "Changed" })).not.toBe(
    flowDefinitionRevision(left),
  );
  expect(serializeFlowDefinition(left)).toBe(
    `${JSON.stringify({ edges: [], layout: { a: { x: 1, y: 2 } }, steps: [], title: "Flow", version: 1 }, null, 2)}\n`,
  );
});
