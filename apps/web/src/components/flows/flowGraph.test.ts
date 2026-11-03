import { expect, it } from "vite-plus/test";
import type { FlowDefinition } from "@t3tools/contracts";
import { flowGraph, renameStep, removeStep, dropTarget, findStep, updateStep } from "./flowGraph";
const definition: FlowDefinition = {
  version: 1,
  title: "Test",
  steps: [
    { id: "source", kind: "agent", prompt: "source" },
    {
      id: "loop",
      kind: "loop",
      maxIterations: 3,
      until: { ref: "steps.source.output.text", op: "isEmpty" },
      steps: [
        {
          id: "child",
          kind: "agent",
          prompt: "{{steps.source.output.text}}",
          thread: { sameAs: "source" },
        },
        {
          id: "cmd",
          kind: "command",
          command: "echo source",
          env: { V: "{{steps.source.output.text}}" },
        },
        { id: "map", kind: "map", over: "steps.source.output.items", steps: [], edges: [] },
      ],
      edges: [],
    },
  ],
  edges: [{ from: "source", to: "loop", when: { ref: "steps.source.output.text", op: "isEmpty" } }],
  layout: { source: { x: 0, y: 0 }, loop: { x: 300, y: 100 }, child: { x: 30, y: 70 } },
};
it.each(["source", "child", "loop"])("renames %s without dangling layout or edges", (id) => {
  const renamed = renameStep(definition, id, "new-id");
  expect(findStep(renamed.steps, id)).toBeUndefined();
  expect(renamed.layout?.["new-id"]).toEqual(definition.layout?.[id]);
});
it("rewrites references and sameAs, leaving shell commands literal", () => {
  const renamed = renameStep(definition, "source", "renamed");
  expect(JSON.stringify(renamed)).not.toContain("steps.source.");
  expect(JSON.stringify(renamed)).toContain('"sameAs":"renamed"');
  expect(JSON.stringify(renamed)).toContain("echo source");
  expect(() => renameStep(definition, "source", "child")).toThrow();
  expect(() => renameStep(definition, "source", "")).toThrow();
});
it.each([
  { id: "source", keys: ["loop", "child"] },
  { id: "child", keys: ["source", "loop"] },
  { id: "loop", keys: ["source"] },
])("removes $id and subtree layout", ({ id, keys }) => {
  const removed = removeStep(definition, id);
  expect(Object.keys(removed.layout ?? {})).toEqual(keys);
  if (id !== "child") expect(removed.edges).toEqual([]);
});
it("updates only first duplicate and preserves unrelated objects", () => {
  const first = definition.steps[0]!;
  const updated = updateStep([first, first, definition.steps[1]!], "source", (s) => ({
    ...s,
    id: "changed",
  }));
  expect(updated.map((s) => s.id)).toEqual(["changed", "source", "loop"]);
  expect(updated[2]).toBe(definition.steps[1]);
});
it.each([
  { point: { x: 5, y: 5 }, parentId: null, position: { x: 5, y: 5 } },
  { point: { x: 310, y: 110 }, parentId: "loop", position: { x: 10, y: 10 } },
  { point: { x: 340, y: 200 }, parentId: "loop", position: { x: 40, y: 100 } },
])("finds drop container at $point", ({ point, parentId, position }) => {
  expect(dropTarget(flowGraph(definition).nodes, point)).toEqual({ parentId, position });
});
it("reuses unchanged nodes", () => {
  const first = flowGraph(definition);
  const next = flowGraph({ ...definition, title: "Edited" }, first.nodes);
  expect(next.nodes.every((node, i) => node === first.nodes[i])).toBe(true);
});

it("chooses the deepest container and converts to its local position", () => {
  const nested = { ...definition, layout: { ...definition.layout, map: { x: 280, y: 80 } } };
  expect(dropTarget(flowGraph(nested).nodes, { x: 600, y: 200 })).toEqual({
    parentId: "map",
    position: { x: 20, y: 20 },
  });
});
it("keeps loop steps below the header and apart, and grows the frame around them", () => {
  const { nodes } = flowGraph({
    version: 1,
    title: "Layout",
    steps: [
      {
        id: "fix",
        kind: "loop",
        maxIterations: 3,
        until: { ref: "steps.test.output.exitCode", op: "eq", value: 0 },
        steps: [
          { id: "implement", kind: "agent", prompt: "" },
          { id: "test", kind: "command", command: "" },
        ],
        edges: [{ from: "implement", to: "test" }],
      },
      { id: "review", kind: "agent", prompt: "" },
    ],
    edges: [{ from: "fix", to: "review" }],
    layout: {
      fix: { x: 0, y: 0 },
      implement: { x: -8, y: 40 },
      test: { x: -8, y: 99 },
      review: { x: 0, y: 250 },
    },
  });
  const at = (id: string) => nodes.find((node) => node.id === id);
  expect(at("implement")?.position).toEqual({ x: 16, y: 56 });
  expect(at("test")?.position).toEqual({ x: 16, y: 168 });
  expect(at("fix")?.style).toEqual({ width: 256, height: 264 });
  expect(at("review")?.position).toEqual({ x: 0, y: 296 });
});
it("rewrites previous outputs and inner loop output paths without changing similar ids", () => {
  const input: FlowDefinition = {
    ...definition,
    steps: [
      ...definition.steps,
      {
        kind: "approval",
        id: "consumer",
        prompt:
          "{{steps.loop.output.steps.child.text}} {{steps.source.previous.output.text}} {{steps.source-other.output.text}}",
      },
    ],
  };
  const result = renameStep(renameStep(input, "child", "renamed"), "source", "new-source");
  expect(findStep(result.steps, "consumer")).toMatchObject({
    prompt:
      "{{steps.loop.output.steps.renamed.text}} {{steps.new-source.previous.output.text}} {{steps.source-other.output.text}}",
  });
});
