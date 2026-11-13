import type { FlowDefinition, FlowEdge, FlowStep, FlowCondition } from "@t3tools/contracts";
import { parseFlowReference } from "@t3tools/shared/flow";
import { MarkerType, type Edge, type Node } from "@xyflow/react";

export type FlowNode = Node<
  { step: FlowStep; errors?: ReadonlyArray<string>; dropTarget?: boolean },
  "step"
>;
// Geometry is in rem, like the cards it sizes, so the layout follows the interface font size.
export const FLOW_CARD = { width: 14, height: 5 };
/** Loop and map steps keep their title and summary above their steps. */
export const CONTAINER_HEADER = 3.5;
const PAD = 1;
const GAP = 2;
/** Closer than this, an edge between two stacked steps has no room for its arrow. */
const MARGIN = 1.5;
type Rect = { x: number; y: number; width: number; height: number };

const geometry = (rem: number) => {
  const card = { width: FLOW_CARD.width * rem, height: FLOW_CARD.height * rem };
  const pad = PAD * rem;
  const top = (CONTAINER_HEADER + PAD) * rem;
  return {
    card,
    pad,
    top,
    gap: GAP * rem,
    margin: MARGIN * rem,
    frame: (right: number, bottom: number) => ({
      width: Math.max(card.width + pad * 2, right + pad),
      height: Math.max(top + card.height + pad, bottom + pad),
    }),
  };
};

export function flowGraph(
  definition: FlowDefinition,
  previous: ReadonlyArray<FlowNode> = [],
  rem = 16,
) {
  const { card, pad, top, gap, margin, frame } = geometry(rem);
  const crowds = (a: Rect, b: Rect) =>
    a.x < b.x + b.width + margin &&
    b.x < a.x + a.width + margin &&
    a.y < b.y + b.height + margin &&
    b.y < a.y + a.height + margin;
  const nodes: FlowNode[] = [];
  const oldNodes = new Map(previous.map((node) => [node.id, node]));
  const edges: Edge[] = [];
  // Saved positions are hints: steps inside a loop or map stay below its header, and a step that
  // would crowd one placed before it moves down, so dragged or hand-edited layouts stay legible.
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
    const measured: Array<{
      step: FlowStep;
      size: { width: number; height: number };
      position: { x: number; y: number };
    }> = [];
    for (const step of steps) {
      const container = step.kind === "loop" || step.kind === "map";
      const size = container ? measure(step.steps, true).size : card;
      const saved = definition.layout?.[step.id];
      const below = measured.length
        ? Math.max(...measured.map((placed) => placed.position.y + placed.size.height)) + gap
        : nested
          ? top
          : 80;
      const rect = saved
        ? nested
          ? { x: Math.max(pad, saved.x), y: Math.max(top, saved.y), ...size }
          : { ...saved, ...size }
        : { x: nested ? pad : 200, y: below, ...size };
      for (let moved = true; moved;) {
        moved = false;
        for (const placed of measured)
          if (crowds(rect, { ...placed.position, ...placed.size })) {
            rect.y = placed.position.y + placed.size.height + gap;
            moved = true;
          }
      }
      measured.push({ step, size, position: { x: rect.x, y: rect.y } });
    }
    const right = Math.max(0, ...measured.map(({ position, size }) => position.x + size.width));
    const bottom = Math.max(0, ...measured.map(({ position, size }) => position.y + size.height));
    return { measured, size: frame(right, bottom) };
  };
  const visit = (
    steps: ReadonlyArray<FlowStep>,
    links: ReadonlyArray<FlowEdge>,
    parentId?: string,
  ) => {
    for (const { step, size, position } of measure(steps, parentId !== undefined).measured) {
      const container = step.kind === "loop" || step.kind === "map";
      const old = oldNodes.get(step.id);
      const node: FlowNode = {
        id: step.id,
        type: "step",
        data: { step },
        position,
        // No parent extent: a dragged step may leave the frame, and the frame regrows around it.
        ...(parentId ? { parentId } : {}),
        ...(container ? { style: size } : {}),
        ...(old?.measured ? { measured: old.measured } : {}),
      };
      nodes.push(
        old &&
          old.data.step === step &&
          old.parentId === parentId &&
          old.position.x === position.x &&
          old.position.y === position.y &&
          old.style?.width === node.style?.width &&
          old.style?.height === node.style?.height
          ? old
          : node,
      );
      if (container) visit(step.steps, step.edges, step.id);
    }
    links.forEach((edge, index) =>
      edges.push({
        id: `${parentId ?? "$"}:${index}`,
        type: "smoothstep",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: edge.on === "failure" ? "var(--destructive)" : "var(--muted-foreground)",
          width: 14,
          height: 14,
        },
        ...(edge.on === "failure"
          ? { style: { stroke: "var(--destructive)", strokeDasharray: "4 4" } }
          : {}),
        source: edge.from,
        target: edge.to,
        label:
          edge.on === "failure" ? "on failure" : edge.when ? conditionLabel(edge.when) : undefined,
      }),
    );
  };
  visit(definition.steps, definition.edges);
  return { nodes, edges };
}

/** Applies the layout's frame rules to live positions, so a frame follows a step being dragged. */
export function fitFrames(nodes: ReadonlyArray<FlowNode>, rem = 16): FlowNode[] {
  const { card, pad, top, frame } = geometry(rem);
  const extents = new Map<string, { right: number; bottom: number }>();
  const result = [...nodes];
  // Steps follow their frame in the list, so walking backwards sizes inner frames first.
  for (let index = result.length - 1; index >= 0; index--) {
    let node = result[index]!;
    const position = node.parentId
      ? { x: Math.max(pad, node.position.x), y: Math.max(top, node.position.y) }
      : node.position;
    let size = card;
    if (node.data.step.kind === "loop" || node.data.step.kind === "map") {
      const extent = extents.get(node.id);
      size = frame(extent?.right ?? 0, extent?.bottom ?? 0);
    }
    if (
      position.x !== node.position.x ||
      position.y !== node.position.y ||
      (size !== card && (node.style?.width !== size.width || node.style?.height !== size.height))
    ) {
      node = { ...node, position, ...(size !== card ? { style: { ...node.style, ...size } } : {}) };
      result[index] = node;
    }
    if (node.parentId) {
      const extent = extents.get(node.parentId);
      extents.set(node.parentId, {
        right: Math.max(extent?.right ?? 0, position.x + size.width),
        bottom: Math.max(extent?.bottom ?? 0, position.y + size.height),
      });
    }
  }
  return result;
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
  let found = false;
  const visit = (level: ReadonlyArray<FlowStep>): ReadonlyArray<FlowStep> => {
    const next = level.map((step) => {
      if (found) return step;
      if (step.id === id) {
        found = true;
        return update(step);
      }
      if (step.kind === "loop" || step.kind === "map") {
        const children = visit(step.steps);
        return children === step.steps ? step : { ...step, steps: children };
      }
      return step;
    });
    return next.every((step, i) => step === level[i]) ? level : next;
  };
  return visit(steps);
}
export function renameStep(definition: FlowDefinition, from: string, to: string): FlowDefinition {
  if (from === to) return definition;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(to))
    throw new Error("Use a step id with lowercase letters, numbers and hyphens.");
  if (findStep(definition.steps, to)) throw new Error("A step with that id already exists.");
  const reference = (value: string) => {
    try {
      const parsed = parseFlowReference(value);
      if (parsed.kind !== "step") return value;
      let current = findStep(definition.steps, parsed.stepId);
      let childField = false;
      const fields = parsed.fields.map((field) => {
        if (current?.kind !== "loop") return field;
        if (!childField) {
          childField = field === "steps";
          return field;
        }
        childField = false;
        current = current.steps.find((child) => child.id === field);
        return current && field === from ? to : field;
      });
      return `steps.${parsed.stepId === from ? to : parsed.stepId}.${parsed.previous ? "previous." : ""}output.${fields.join(".")}`;
    } catch {
      return value;
    }
  };
  const template = (value: string) =>
    value.replace(
      /\{\{([^{}]+)\}\}/g,
      (_match: string, ref: string) => `{{${reference(ref.trim())}}}`,
    );
  const condition = (
    value: import("@t3tools/contracts").FlowCondition,
  ): import("@t3tools/contracts").FlowCondition => {
    if ("all" in value) return { all: value.all.map(condition) };
    if ("any" in value) return { any: value.any.map(condition) };
    if ("not" in value) return { not: condition(value.not) };
    return { ...value, ref: reference(value.ref) };
  };
  const level = (
    graph: Pick<FlowDefinition, "steps" | "edges">,
  ): Pick<FlowDefinition, "steps" | "edges"> => ({
    steps: graph.steps.map((step) => {
      const base = { ...step, id: step.id === from ? to : step.id };
      switch (base.kind) {
        case "agent":
          return {
            ...base,
            prompt: template(base.prompt),
            ...(typeof base.thread === "object" && base.thread.sameAs === from
              ? { thread: { sameAs: to } }
              : {}),
          };
        case "approval":
          return { ...base, prompt: template(base.prompt) };
        case "command":
          return {
            ...base,
            ...(base.env
              ? {
                  env: Object.fromEntries(
                    Object.entries(base.env).map(([key, value]) => [key, template(value)]),
                  ),
                }
              : {}),
          };
        case "loop":
          return { ...base, ...level(base), until: condition(base.until) };
        case "map":
          return { ...base, ...level(base), over: reference(base.over) };
      }
    }),
    edges: graph.edges.map((edge) => ({
      ...edge,
      from: edge.from === from ? to : edge.from,
      to: edge.to === from ? to : edge.to,
      ...(edge.when ? { when: condition(edge.when) } : {}),
    })),
  });
  const layout = { ...definition.layout };
  if (layout[from]) {
    layout[to] = layout[from];
    delete layout[from];
  }
  return { ...definition, ...level(definition), ...(definition.layout ? { layout } : {}) };
}
export function dropTarget(nodes: ReadonlyArray<FlowNode>, point: { x: number; y: number }) {
  const positions = new Map<string, { x: number; y: number; depth: number }>();
  let target: { parentId: string | null; position: { x: number; y: number }; depth: number } = {
    parentId: null,
    position: point,
    depth: -1,
  };
  for (const node of nodes) {
    const parent = node.parentId ? positions.get(node.parentId) : undefined;
    const absolute = {
      x: node.position.x + (parent?.x ?? 0),
      y: node.position.y + (parent?.y ?? 0),
      depth: (parent?.depth ?? -1) + 1,
    };
    positions.set(node.id, absolute);
    if (
      (node.data.step.kind === "loop" || node.data.step.kind === "map") &&
      absolute.depth > target.depth &&
      point.x >= absolute.x &&
      point.y >= absolute.y &&
      point.x <= absolute.x + Number(node.style?.width ?? 0) &&
      point.y <= absolute.y + Number(node.style?.height ?? 0)
    ) {
      target = {
        parentId: node.id,
        position: { x: point.x - absolute.x, y: point.y - absolute.y },
        depth: absolute.depth,
      };
    }
  }
  return { parentId: target.parentId, position: target.position };
}

export function removeStep(definition: FlowDefinition, id: string): FlowDefinition {
  const removed = new Set<string>();
  const collect = (step: FlowStep) => {
    removed.add(step.id);
    if (step.kind === "loop" || step.kind === "map") step.steps.forEach(collect);
  };
  const target = findStep(definition.steps, id);
  if (target) collect(target);
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
    edges: edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to)),
  });
  return {
    ...definition,
    ...remove(definition.steps, definition.edges),
    ...(definition.layout
      ? {
          layout: Object.fromEntries(
            Object.entries(definition.layout).filter(([key]) => !removed.has(key)),
          ),
        }
      : {}),
  };
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
        until: { ref: "", op: "isEmpty" },
        steps: [],
        edges: [],
      };
    case "map":
      return { id, kind, over: "inputs.items", steps: [], edges: [] };
  }
}

export function stepIdAtPath(definition: FlowDefinition, path: string) {
  const indices = [...path.matchAll(/steps\[(\d+)\]/g)].map((match) => Number(match[1]));
  let steps = definition.steps;
  let id: string | undefined;
  for (const index of indices) {
    const step = steps[index];
    if (!step) break;
    id = step.id;
    if (step.kind === "map" || step.kind === "loop") steps = step.steps;
  }
  return id;
}

export function conditionLabel(condition: FlowCondition): string {
  if ("all" in condition) return `all(${condition.all.length})`;
  if ("any" in condition) return `any(${condition.any.length})`;
  if ("not" in condition) return `not ${conditionLabel(condition.not)}`;
  return `${condition.ref.split(".").at(-1)} ${condition.op}${"value" in condition ? ` ${String(condition.value)}` : ""}`;
}
