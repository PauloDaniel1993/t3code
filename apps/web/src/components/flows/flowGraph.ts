import type { FlowDefinition, FlowEdge, FlowStep } from "@t3tools/contracts";
import type { Edge, Node } from "@xyflow/react";

export type FlowNode = Node<{ step: FlowStep }, "step">;
export function flowGraph(definition: FlowDefinition) {
  const nodes: FlowNode[] = [];
  const edges: Edge[] = [];
  const measure = (
    steps: ReadonlyArray<FlowStep>,
    nested: boolean,
  ): {
    measured: Array<{
      step: FlowStep;
      size: { width: number; height: number };
      position: { x: number; y: number };
    }>;
    size: { width: number; height: number };
  } => {
    let bottom = nested ? 70 : 80;
    let right = 400;
    const measured = steps.map((step) => {
      const container = step.kind === "loop" || step.kind === "map";
      const size = container ? measure(step.steps, true).size : { width: 170, height: 70 };
      const position = definition.layout?.[step.id] ?? { x: nested ? 30 : 200, y: bottom };
      bottom = Math.max(bottom, position.y + size.height + 50);
      right = Math.max(right, position.x + size.width + 30);
      return { step, size, position };
    });
    return { measured, size: { width: right, height: Math.max(240, bottom) } };
  };
  const visit = (
    steps: ReadonlyArray<FlowStep>,
    links: ReadonlyArray<FlowEdge>,
    parentId?: string,
  ) => {
    for (const { step, size, position } of measure(steps, parentId !== undefined).measured) {
      const container = step.kind === "loop" || step.kind === "map";
      nodes.push({
        id: step.id,
        type: "step",
        data: { step },
        position,
        ...(parentId ? { parentId, extent: "parent" as const } : {}),
        ...(container ? { style: size } : {}),
      });
      if (container) visit(step.steps, step.edges, step.id);
    }
    links.forEach((edge, index) =>
      edges.push({
        id: `${parentId ?? "$"}:${index}`,
        source: edge.from,
        target: edge.to,
        label: edge.on === "failure" ? "failure" : edge.when ? "condition" : undefined,
      }),
    );
  };
  visit(definition.steps, definition.edges);
  return { nodes, edges };
}

export function findStep(steps: ReadonlyArray<FlowStep>, id: string): FlowStep | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    if (step.kind === "loop" || step.kind === "map") {
      const found = findStep(step.steps, id);
      if (found) return found;
    }
  }
}

export function editLevel(
  definition: FlowDefinition,
  parentId: string | null,
  edit: (level: Pick<FlowDefinition, "steps" | "edges">) => Pick<FlowDefinition, "steps" | "edges">,
): FlowDefinition {
  if (parentId === null) return { ...definition, ...edit(definition) };
  return {
    ...definition,
    steps: updateStep(definition.steps, parentId, (step) =>
      step.kind === "loop" || step.kind === "map" ? { ...step, ...edit(step) } : step,
    ),
  };
}
export function updateStep(
  steps: ReadonlyArray<FlowStep>,
  id: string,
  update: (step: FlowStep) => FlowStep,
): ReadonlyArray<FlowStep> {
  return steps.map((step) =>
    step.id === id
      ? update(step)
      : step.kind === "loop" || step.kind === "map"
        ? { ...step, steps: updateStep(step.steps, id, update) }
        : step,
  );
}
export function removeStep(definition: FlowDefinition, id: string): FlowDefinition {
  const remove = (
    steps: ReadonlyArray<FlowStep>,
    edges: ReadonlyArray<FlowEdge>,
  ): Pick<FlowDefinition, "steps" | "edges"> => ({
    steps: steps
      .filter((step) => step.id !== id)
      .map((step) =>
        step.kind === "loop" || step.kind === "map"
          ? { ...step, ...remove(step.steps, step.edges) }
          : step,
      ),
    edges: edges.filter((edge) => edge.from !== id && edge.to !== id),
  });
  return { ...definition, ...remove(definition.steps, definition.edges) };
}
export function newStep(kind: FlowStep["kind"], id: string): FlowStep {
  switch (kind) {
    case "agent":
      return { id, kind, prompt: "" };
    case "command":
      return { id, kind, command: "" };
    case "approval":
      return { id, kind, prompt: "Approve this step?" };
    case "loop":
      return {
        id,
        kind,
        maxIterations: 3,
        until: { ref: "iteration", op: "gte", value: 3 },
        steps: [],
        edges: [],
      };
    case "map":
      return { id, kind, over: "inputs.items", steps: [], edges: [] };
  }
}
