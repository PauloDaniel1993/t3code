import { hash32, type StarMapGraph } from "./starMapGraph";

/**
 * Rank-biased force relaxation in a panel-independent virtual space of radius
 * `STAR_MAP_VIRTUAL_RADIUS`. The solver is a one-shot fixed-point iteration —
 * no velocity, no animation loop — cooling linearly to exactly zero. Panel
 * pixels enter only through the camera module, so resizing never re-runs this.
 *
 * Every node is pulled toward a seeded anchor point on its rank ring: the
 * angle comes from hash32(ticketNumber) ALONE — never a rank-sorted index or
 * a golden-angle spiral — and the radius from its rank. A purely radial pull
 * leaves angles free and relaxation is then chaotic: adding one leaf
 * re-arranges the whole map (measured ~35% of the bounding radius), breaking
 * spatial memory. The anchor must also dominate the other forces, or
 * repulsion interleaves the rings into soup and rank ordering is lost. With
 * the anchor pinning positions, the remaining forces only smooth the
 * constellation locally — and that is what makes "tickets keep their position
 * as the map grows" true.
 *
 * Determinism is a hard requirement: node order comes from the sorted graph,
 * all pair and edge loops are indexed, coincident-pair directions come from a
 * hash of the two node ids, and nothing reads the clock or a random source.
 */

export const STAR_MAP_VIRTUAL_RADIUS = 1000;
export const STAR_MAP_RELAXATION_ITERATIONS = 300;
export const STAR_MAP_SEPARATION_ITERATIONS = 10;
export const STAR_MAP_MIN_SEPARATION = 48;

const RANK_SPACING = 170;
const ANCHOR_STRENGTH = 0.4;
const ANCHOR_MIN_RADIUS = 60;
const REPULSION_CUTOFF = 90;
const REPULSION_STRENGTH = 25;
const SPRING_REST_BASE = 90;
const SPRING_RANK_GAP_FACTOR = 0.5;
const SPRING_STRENGTH = 0.008;
const MAX_STEP = 24;
const INITIAL_RADIUS_JITTER = 50;
/** Over-relaxation factor for the separation pass; speeds ring diffusion. */
const SEPARATION_OVERSHOOT = 1.6;
const TAU = Math.PI * 2;

export interface StarMapPosition {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export interface StarMapLayoutResult {
  /** One entry per node, in the graph's (ordinal, id) order. */
  readonly positions: ReadonlyArray<StarMapPosition>;
  readonly positionById: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  /** Distance from the origin of the farthest node; the camera fits to this. */
  readonly boundingRadius: number;
  /** Relaxation iterations executed (0 for an empty map). */
  readonly iterations: number;
  /** Total pairwise distance checks across relaxation and the separation pass. */
  readonly pairChecks: number;
}

/**
 * Rank spacing is absolute, never normalised by the map's max rank: adding a
 * deep leaf must not rescale every existing ring, or tickets would lose their
 * spatial memory. Deep maps simply grow past the nominal virtual radius and
 * the camera fits to the result.
 */
export function targetRankRadius(rank: number): number {
  return rank * RANK_SPACING;
}

/** Rank-0 nodes anchor to a small ring around the origin rather than a point. */
function anchorRadius(rank: number): number {
  return Math.max(targetRankRadius(rank), ANCHOR_MIN_RADIUS);
}

/** Deterministic direction for a coincident pair, derived only from the ids. */
function coincidentPairAngle(idA: string, idB: string): number {
  return (hash32(`${idA}\n${idB}`) / 0x1_0000_0000) * TAU;
}

export function layoutStarMap(graph: StarMapGraph): StarMapLayoutResult {
  const nodes = graph.nodes;
  const count = nodes.length;
  if (count === 0) {
    return {
      positions: [],
      positionById: new Map(),
      boundingRadius: 0,
      iterations: 0,
      pairChecks: 0,
    };
  }

  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const anchorX = new Float64Array(count);
  const anchorY = new Float64Array(count);
  const indexById = new Map<string, number>();

  for (let index = 0; index < count; index += 1) {
    const node = nodes[index]!;
    indexById.set(node.id, index);
    // The anchor angle seeds from hash32(ticketNumber) ALONE, so inserting a
    // ticket cannot shift where any other ticket starts.
    const seed = hash32(String(node.ordinal));
    const angle = ((seed & 0xffff) / 0x10000) * TAU;
    const jitter = (seed >>> 16) / 0x10000;
    anchorX[index] = Math.cos(angle) * anchorRadius(node.rank);
    anchorY[index] = Math.sin(angle) * anchorRadius(node.rank);
    const initialRadius = anchorRadius(node.rank) + jitter * INITIAL_RADIUS_JITTER;
    xs[index] = Math.cos(angle) * initialRadius;
    ys[index] = Math.sin(angle) * initialRadius;
  }

  const edgeFrom: Array<number> = [];
  const edgeTo: Array<number> = [];
  const edgeRest: Array<number> = [];
  for (const edge of graph.edges) {
    const from = indexById.get(edge.from);
    const to = indexById.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    edgeFrom.push(from);
    edgeTo.push(to);
    const rankGap = Math.abs(nodes[from]!.rank - nodes[to]!.rank);
    edgeRest.push(SPRING_REST_BASE * (1 + SPRING_RANK_GAP_FACTOR * rankGap));
  }

  const deltaX = new Float64Array(count);
  const deltaY = new Float64Array(count);
  let pairChecks = 0;

  for (let iteration = 0; iteration < STAR_MAP_RELAXATION_ITERATIONS; iteration += 1) {
    // Linear cooling to exactly zero over the iteration count.
    const temperature = 1 - iteration / (STAR_MAP_RELAXATION_ITERATIONS - 1);
    deltaX.fill(0);
    deltaY.fill(0);

    // Repulsion: linear falloff with a hard cutoff, so the force is bounded
    // and cannot explode however dense the map gets.
    for (let a = 0; a < count - 1; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        pairChecks += 1;
        let apartX = xs[a]! - xs[b]!;
        let apartY = ys[a]! - ys[b]!;
        let distance = Math.hypot(apartX, apartY);
        if (distance >= REPULSION_CUTOFF) continue;
        if (distance < 1e-9) {
          const angle = coincidentPairAngle(nodes[a]!.id, nodes[b]!.id);
          apartX = Math.cos(angle);
          apartY = Math.sin(angle);
          distance = 1;
        }
        const force = (REPULSION_STRENGTH * (1 - distance / REPULSION_CUTOFF)) / distance;
        const forceX = apartX * force;
        const forceY = apartY * force;
        deltaX[a]! += forceX;
        deltaY[a]! += forceY;
        deltaX[b]! -= forceX;
        deltaY[b]! -= forceY;
      }
    }

    // Edge springs: rest length scales with the rank gap between endpoints.
    for (let edge = 0; edge < edgeFrom.length; edge += 1) {
      const from = edgeFrom[edge]!;
      const to = edgeTo[edge]!;
      const apartX = xs[to]! - xs[from]!;
      const apartY = ys[to]! - ys[from]!;
      const distance = Math.hypot(apartX, apartY);
      if (distance < 1e-9) continue;
      const force = (SPRING_STRENGTH * (distance - edgeRest[edge]!)) / distance;
      const forceX = apartX * force;
      const forceY = apartY * force;
      deltaX[from]! += forceX;
      deltaY[from]! += forceY;
      deltaX[to]! -= forceX;
      deltaY[to]! -= forceY;
    }

    // Anchor pull toward the seeded point on the node's rank ring.
    for (let index = 0; index < count; index += 1) {
      deltaX[index]! += ANCHOR_STRENGTH * (anchorX[index]! - xs[index]!);
      deltaY[index]! += ANCHOR_STRENGTH * (anchorY[index]! - ys[index]!);
    }

    // No gravity term and no mean-delta subtraction: the anchors pin every
    // node in absolute space, and broadcasting the mean force would couple a
    // new node's transient into every other node (measured: a uniform ~20
    // unit sweep when one leaf is added).
    for (let index = 0; index < count; index += 1) {
      let stepX = deltaX[index]! * temperature;
      let stepY = deltaY[index]! * temperature;
      const stepLength = Math.hypot(stepX, stepY);
      if (stepLength > MAX_STEP) {
        const shrink = MAX_STEP / stepLength;
        stepX *= shrink;
        stepY *= shrink;
      }
      xs[index]! += stepX;
      ys[index]! += stepY;
    }
  }

  // Separation post-pass. The forces do not guarantee non-overlap; this does.
  // Each correction moves both endpoints symmetrically, so the centroid is
  // preserved pair by pair and the pass is fully deterministic.
  for (let pass = 0; pass < STAR_MAP_SEPARATION_ITERATIONS; pass += 1) {
    for (let a = 0; a < count - 1; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        pairChecks += 1;
        let apartX = xs[b]! - xs[a]!;
        let apartY = ys[b]! - ys[a]!;
        let distance = Math.hypot(apartX, apartY);
        if (distance >= STAR_MAP_MIN_SEPARATION) continue;
        if (distance < 1e-9) {
          const angle = coincidentPairAngle(nodes[a]!.id, nodes[b]!.id);
          apartX = Math.cos(angle);
          apartY = Math.sin(angle);
          distance = 1;
        }
        const push = ((STAR_MAP_MIN_SEPARATION - distance) / (2 * distance)) * SEPARATION_OVERSHOOT;
        const pushX = apartX * push;
        const pushY = apartY * push;
        xs[a]! -= pushX;
        ys[a]! -= pushY;
        xs[b]! += pushX;
        ys[b]! += pushY;
      }
    }
  }

  // No centroid subtraction. It is the design's stand-in for a gravity term,
  // but the seeded anchors already pin every node in absolute space, and the
  // rank rings are concentric around this frame's origin by construction.
  // Subtracting the sample-noisy centroid (an outer-ring leaf can drag it
  // ~20 units, measured) shifts every existing node's coordinates and
  // de-centers the rings, scrambling rank ordering — the exact spatial-memory
  // failure it was meant to prevent.
  const positions: Array<StarMapPosition> = [];
  const positionById = new Map<string, { x: number; y: number }>();
  let boundingRadius = 0;
  for (let index = 0; index < count; index += 1) {
    const x = xs[index]!;
    const y = ys[index]!;
    positions.push({ id: nodes[index]!.id, x, y });
    positionById.set(nodes[index]!.id, { x, y });
    boundingRadius = Math.max(boundingRadius, Math.hypot(x, y));
  }

  return {
    positions,
    positionById,
    boundingRadius,
    iterations: STAR_MAP_RELAXATION_ITERATIONS,
    pairChecks,
  };
}
