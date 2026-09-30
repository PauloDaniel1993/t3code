import type { StarMapGraph, StarMapGraphNode } from "./starMapGraph";

/**
 * Deterministic layered layout for a dependency map.
 *
 * Ticket rank is the primary visual fact: blockers sit above the work they
 * unlock, and every node with the same rank shares a row. Repeated downward
 * and upward barycentric sweeps order nodes inside those rows so related
 * branches stay together and obvious edge crossings disappear. The layout is
 * a one-shot O(nodes + edges) pass with no animation or viewport dependency.
 */

export const STAR_MAP_MIN_SEPARATION = 48;
export const STAR_MAP_LAYER_SPACING = 84;
export const STAR_MAP_MAX_NODE_SPACING = 440;
export const STAR_MAP_MAX_LAYER_SPAN = 12_000;
export const STAR_MAP_ORDERING_SWEEPS = 6;

export interface StarMapPosition {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export interface StarMapLayoutResult {
  /** One entry per node, in the graph's (ordinal, id) order. */
  readonly positions: ReadonlyArray<StarMapPosition>;
  readonly positionById: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  /** Distance from the origin of the farthest node; retained for interaction metrics. */
  readonly boundingRadius: number;
  /** Complete downward/upward ordering sweeps (0 for an empty map). */
  readonly iterations: number;
  /** Neighbor positions read while calculating barycenters. */
  readonly pairChecks: number;
}

function compareNodes(left: StarMapGraphNode, right: StarMapGraphNode): number {
  return left.ordinal - right.ordinal || left.id.localeCompare(right.id);
}

function buildLayers(nodes: ReadonlyArray<StarMapGraphNode>): Array<Array<StarMapGraphNode>> {
  const nodesByRank = new Map<number, Array<StarMapGraphNode>>();
  for (const node of nodes) {
    const layer = nodesByRank.get(node.rank) ?? [];
    layer.push(node);
    nodesByRank.set(node.rank, layer);
  }
  return [...nodesByRank.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, layer]) => layer.toSorted(compareNodes));
}

function normalizedSlots(
  layers: ReadonlyArray<ReadonlyArray<StarMapGraphNode>>,
): Map<string, number> {
  const slots = new Map<string, number>();
  for (const layer of layers) {
    const denominator = Math.max(layer.length - 1, 1);
    for (let index = 0; index < layer.length; index += 1) {
      slots.set(layer[index]!.id, layer.length === 1 ? 0 : index / denominator - 0.5);
    }
  }
  return slots;
}

function orderLayer(
  layer: ReadonlyArray<StarMapGraphNode>,
  neighborsById: ReadonlyMap<string, ReadonlyArray<string>>,
  slotById: ReadonlyMap<string, number>,
): { readonly nodes: Array<StarMapGraphNode>; readonly neighborReads: number } {
  let neighborReads = 0;
  const scored = layer.map((node, previousIndex) => {
    const neighbors = neighborsById.get(node.id) ?? [];
    let total = 0;
    let count = 0;
    for (const neighborId of neighbors) {
      const slot = slotById.get(neighborId);
      if (slot === undefined) continue;
      total += slot;
      count += 1;
    }
    neighborReads += count;
    return {
      node,
      previousIndex,
      score: count > 0 ? total / count : (slotById.get(node.id) ?? 0),
    };
  });
  scored.sort(
    (left, right) =>
      left.score - right.score ||
      left.previousIndex - right.previousIndex ||
      compareNodes(left.node, right.node),
  );
  return { nodes: scored.map(({ node }) => node), neighborReads };
}

function layerNodeSpacing(count: number): number {
  if (count <= 1) return STAR_MAP_MAX_NODE_SPACING;
  return Math.max(
    STAR_MAP_MIN_SEPARATION,
    Math.min(STAR_MAP_MAX_NODE_SPACING, STAR_MAP_MAX_LAYER_SPAN / (count - 1)),
  );
}

export function layoutStarMap(graph: StarMapGraph): StarMapLayoutResult {
  if (graph.nodes.length === 0) {
    return {
      positions: [],
      positionById: new Map(),
      boundingRadius: 0,
      iterations: 0,
      pairChecks: 0,
    };
  }

  const layers = buildLayers(graph.nodes);
  const layerIndexById = new Map<string, number>();
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
    for (const node of layers[layerIndex]!) {
      layerIndexById.set(node.id, layerIndex);
    }
  }

  const incoming = new Map<string, Array<string>>();
  const outgoing = new Map<string, Array<string>>();
  for (const edge of graph.backboneEdges) {
    if (edge.kind !== "blocks") continue;
    const fromLayer = layerIndexById.get(edge.from);
    const toLayer = layerIndexById.get(edge.to);
    if (fromLayer === undefined || toLayer === undefined || fromLayer >= toLayer) continue;
    const incomingNeighbors = incoming.get(edge.to) ?? [];
    incomingNeighbors.push(edge.from);
    incoming.set(edge.to, incomingNeighbors);
    const outgoingNeighbors = outgoing.get(edge.from) ?? [];
    outgoingNeighbors.push(edge.to);
    outgoing.set(edge.from, outgoingNeighbors);
  }

  let pairChecks = 0;
  for (let sweep = 0; sweep < STAR_MAP_ORDERING_SWEEPS; sweep += 1) {
    let slots = normalizedSlots(layers);
    for (let layerIndex = 1; layerIndex < layers.length; layerIndex += 1) {
      const ordered = orderLayer(layers[layerIndex]!, incoming, slots);
      layers[layerIndex] = ordered.nodes;
      pairChecks += ordered.neighborReads;
      slots = normalizedSlots(layers);
    }

    slots = normalizedSlots(layers);
    for (let layerIndex = layers.length - 2; layerIndex >= 0; layerIndex -= 1) {
      const ordered = orderLayer(layers[layerIndex]!, outgoing, slots);
      layers[layerIndex] = ordered.nodes;
      pairChecks += ordered.neighborReads;
      slots = normalizedSlots(layers);
    }
  }

  const coordinatesById = new Map<string, { readonly x: number; readonly y: number }>();
  const verticalCenter = (layers.length - 1) / 2;
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
    const layer = layers[layerIndex]!;
    const spacing = layerNodeSpacing(layer.length);
    const horizontalCenter = (layer.length - 1) / 2;
    for (let index = 0; index < layer.length; index += 1) {
      coordinatesById.set(layer[index]!.id, {
        x: (index - horizontalCenter) * spacing,
        y: (layerIndex - verticalCenter) * STAR_MAP_LAYER_SPACING,
      });
    }
  }

  const positions: Array<StarMapPosition> = [];
  let boundingRadius = 0;
  for (const node of graph.nodes) {
    const position = coordinatesById.get(node.id)!;
    positions.push({ id: node.id, ...position });
    boundingRadius = Math.max(boundingRadius, Math.hypot(position.x, position.y));
  }

  return {
    positions,
    positionById: coordinatesById,
    boundingRadius,
    iterations: STAR_MAP_ORDERING_SWEEPS,
    pairChecks,
  };
}
