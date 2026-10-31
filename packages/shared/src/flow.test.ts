import { expect, it } from "vite-plus/test";
import {
  capFlowCommandOutput,
  capFlowText,
  coerceFlowInputs,
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
])("renders %s", (template, expected) =>
  expect(renderFlowTemplate(template, context, () => "Review thread")).toBe(expected),
);
it.each([
  "inputs.nope",
  "steps.review.output.missing",
  "steps.review.output.__proto__",
  "steps.review.output.issues.join()",
])("rejects unresolved reference %s", (reference) => {
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
  expect(() => renderFlowTemplate("{{item", context, () => "Review")).toThrow("Unclosed");
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
  { values: { count: "1", files: "[oops" }, path: "$.inputs.files" },
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
  expect(output.lines.slice(0, 2)).toEqual([" a", " b"]);
});
