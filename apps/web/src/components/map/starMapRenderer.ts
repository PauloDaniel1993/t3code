import {
  boundsFromPoints,
  clampCamera,
  fitCameraToBounds,
  screenToWorld,
  worldToScreen,
  type StarMapCamera,
  type StarMapPoint,
  type StarMapSize,
} from "./starMapCamera";
import { hash32, type StarMapGraph, type StarMapNodeStatus } from "./starMapGraph";
import {
  placeStarMapLabels,
  type StarMapLabelNode,
  type StarMapLabelPlacement,
} from "./starMapLabels";
import type { StarMapLayoutResult } from "./starMapLayout";
import {
  DEFAULT_STAR_MAP_THEME,
  alphaVariantIndex,
  formatCssColor,
  formatCssColorVariants,
  resolveStarMapTheme,
  withAlpha,
  type StarMapColor,
  type StarMapTheme,
} from "./starMapTheme";

/**
 * The star map canvas engine — and a deliberate, named departure from
 * `AGENTS.md` ("No continuously repainting animations; they peg the GPU on
 * high-refresh displays"). The departure is only defensible because the loop
 * is demand-driven; every gate below is load-bearing, not polish:
 *
 * - Hard stops: the loop runs only while the document is visible, the window
 *   is focused, the surface is reported active by the mount, and the canvas
 *   intersects the viewport (`RightPanelSheet` uses `keepMounted`, so hidden
 *   is not unmounted — a `useEffect` cleanup alone would not stop this loop).
 *   Any gate failing cancels the `requestAnimationFrame` chain outright.
 * - `prefers-reduced-motion`: the loop NEVER starts. Exactly one static frame
 *   renders per invalidation (mount, content, theme, or size change).
 * - Dual rate: interaction renders at full display refresh; ambient motion
 *   renders on a ~30 fps accumulator and decays to a 4 fps tick after ~10 s
 *   idle, because full-rate ambient animation on a 240 Hz display is the
 *   precise thing the rule exists to prevent.
 * - Theme tokens are read once per theme change via `resolveStarMapTheme`;
 *   `getComputedStyle` is never called from the frame path.
 *
 * Everything testable without a DOM (gates, rate accumulator, curves,
 * particles, starfield, DPR maths) is an exported pure function below; the
 * class is the only DOM-touching part and is exercised by the documented
 * manual end-to-end pass, not by the Node test harness. `framesRendered` is
 * the observable frame counter that pass uses to prove the loop stops.
 */

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Loop gates
// ---------------------------------------------------------------------------

export interface StarMapLoopGates {
  readonly reducedMotion: boolean;
  readonly documentHidden: boolean;
  readonly windowFocused: boolean;
  readonly surfaceActive: boolean;
  readonly onScreen: boolean;
}

/** The loop runs only when every gate is open. Anything less is a hard stop. */
export function starMapLoopShouldRun(gates: StarMapLoopGates): boolean {
  return (
    !gates.reducedMotion &&
    !gates.documentHidden &&
    gates.windowFocused &&
    gates.surfaceActive &&
    gates.onScreen
  );
}

/**
 * One-shot frames (the reduced-motion static frame and first paint) are
 * allowed whenever the canvas could actually be seen — reduced motion blocks
 * the loop, never the single static frame that replaces it.
 */
export function starMapShouldRenderStaticFrame(gates: StarMapLoopGates): boolean {
  return !gates.documentHidden && gates.windowFocused && gates.surfaceActive && gates.onScreen;
}

// ---------------------------------------------------------------------------
// Dual-rate governor
// ---------------------------------------------------------------------------

/** Ambient motion renders at most this often (~30 fps). */
export const STAR_MAP_AMBIENT_FRAME_MS = 1000 / 30;
/** After `STAR_MAP_IDLE_AFTER_MS` without interaction, ambient drops to this tick (4 fps). */
export const STAR_MAP_IDLE_TICK_MS = 250;
export const STAR_MAP_IDLE_AFTER_MS = 10_000;
/** Full-rate rendering continues briefly after the last interaction signal. */
export const STAR_MAP_INTERACTION_TAIL_MS = 120;
/** One frame never advances ambient motion by more than this, however long the gap. */
export const STAR_MAP_MAX_FRAME_DT_MS = 500;

export interface StarMapRateGovernor {
  /** ms timestamp of the last interaction signal; drives full-rate and idle decay. */
  lastInteractionAt: number;
  /** ms timestamp of the last rendered frame, or null before the first. */
  lastFrameAt: number | null;
  /**
   * Virtual ambient time: advances only by the dt of rendered frames, so
   * pulses, twinkle, and particles freeze exactly when the loop stops and
   * step coarsely at the idle tick instead of teleporting.
   */
  ambientClockMs: number;
}

export function createStarMapRateGovernor(now: number): StarMapRateGovernor {
  return { lastInteractionAt: now, lastFrameAt: null, ambientClockMs: 0 };
}

export function noteStarMapInteraction(governor: StarMapRateGovernor, now: number): void {
  governor.lastInteractionAt = now;
}

export interface StarMapFrameDecision {
  readonly render: boolean;
  readonly dtMs: number;
}

/**
 * Called once per `requestAnimationFrame` tick. Interaction (an in-flight
 * gesture, or the tail just after one) renders every tick at full refresh.
 * Otherwise the accumulator renders only once the ambient interval — 33 ms,
 * or 250 ms past the idle threshold — has elapsed, advancing ambient motion
 * by the real elapsed time.
 */
export function advanceStarMapRateGovernor(
  governor: StarMapRateGovernor,
  now: number,
  interacting: boolean,
): StarMapFrameDecision {
  if (governor.lastFrameAt === null) {
    governor.lastFrameAt = now;
    return { render: true, dtMs: 0 };
  }
  const idleForMs = now - governor.lastInteractionAt;
  const fullRate = interacting || idleForMs < STAR_MAP_INTERACTION_TAIL_MS;
  const intervalMs = fullRate
    ? 0
    : idleForMs >= STAR_MAP_IDLE_AFTER_MS
      ? STAR_MAP_IDLE_TICK_MS
      : STAR_MAP_AMBIENT_FRAME_MS;
  const elapsedMs = now - governor.lastFrameAt;
  if (elapsedMs < intervalMs) return { render: false, dtMs: 0 };
  governor.lastFrameAt = now;
  const dtMs = Math.min(Math.max(elapsedMs, 0), STAR_MAP_MAX_FRAME_DT_MS);
  governor.ambientClockMs += dtMs;
  return { render: true, dtMs };
}

// ---------------------------------------------------------------------------
// Device pixel ratio
// ---------------------------------------------------------------------------

/** Backing-store size for a CSS-pixel viewport at a DPR; 0/0 when hidden. */
export function backingStoreSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): { readonly width: number; readonly height: number } {
  if (!(cssWidth > 0) || !(cssHeight > 0) || !(dpr > 0)) return { width: 0, height: 0 };
  return {
    width: Math.max(1, Math.round(cssWidth * dpr)),
    height: Math.max(1, Math.round(cssHeight * dpr)),
  };
}

/**
 * Media query tracking the current DPR. The query value must be rebuilt after
 * every change — that re-registration is what catches monitor-to-monitor drags.
 */
export function dprMediaQueryText(dpr: number): string {
  return `(resolution: ${dpr}dppx)`;
}

// ---------------------------------------------------------------------------
// Edges and flow particles
// ---------------------------------------------------------------------------

/** A blocker stops holding a ticket back once it is resolved or ruled out. */
export function isSatisfiedBlockerStatus(status: StarMapNodeStatus | undefined): boolean {
  return status === "resolved" || status === "out_of_scope";
}

export const STAR_MAP_EDGE_CURVE_TENSION = 0.78;
export const STAR_MAP_EDGE_CURVE_MAX_HANDLE = 220;

export interface StarMapEdgeCurveControls {
  readonly fromControl: StarMapPoint;
  readonly toControl: StarMapPoint;
}

/**
 * Smooth dependency curve for the layered layout. Cross-rank links leave and
 * enter their rows vertically, producing a consistent S curve instead of a
 * random bend. Same-rank cycle links arc to a seeded side so they remain
 * visible without sitting directly on top of their row.
 */
export function edgeCurveControls(
  from: StarMapPoint,
  to: StarMapPoint,
  seed: number,
): StarMapEdgeCurveControls {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  if (Math.hypot(deltaX, deltaY) < 1e-9) {
    return { fromControl: from, toControl: to };
  }
  if (Math.abs(deltaY) >= 1e-9) {
    const handle = Math.min(
      Math.abs(deltaY) * STAR_MAP_EDGE_CURVE_TENSION,
      STAR_MAP_EDGE_CURVE_MAX_HANDLE,
    );
    const direction = Math.sign(deltaY);
    return {
      fromControl: { x: from.x, y: from.y + direction * handle },
      toControl: { x: to.x, y: to.y - direction * handle },
    };
  }
  const direction = Math.sign(deltaX);
  const handle = Math.abs(deltaX) / 3;
  const side = (seed & 1) === 0 ? 1 : -1;
  const lift = Math.min(Math.max(Math.abs(deltaX) * 0.34, 36), 120) * side;
  return {
    fromControl: { x: from.x + direction * handle, y: from.y + lift },
    toControl: { x: to.x - direction * handle, y: to.y + lift },
  };
}

export function cubicBezierPoint(
  from: StarMapPoint,
  fromControl: StarMapPoint,
  toControl: StarMapPoint,
  to: StarMapPoint,
  t: number,
): StarMapPoint {
  const u = 1 - t;
  return {
    x:
      u * u * u * from.x +
      3 * u * u * t * fromControl.x +
      3 * u * t * t * toControl.x +
      t * t * t * to.x,
    y:
      u * u * u * from.y +
      3 * u * u * t * fromControl.y +
      3 * u * t * t * toControl.y +
      t * t * t * to.y,
  };
}

/** Direction of travel along a cubic curve at `t`. */
export function cubicBezierTangent(
  from: StarMapPoint,
  fromControl: StarMapPoint,
  toControl: StarMapPoint,
  to: StarMapPoint,
  t: number,
): StarMapPoint {
  const clamped = Math.min(Math.max(t, 0), 1);
  const u = 1 - clamped;
  return {
    x:
      3 * u * u * (fromControl.x - from.x) +
      6 * u * clamped * (toControl.x - fromControl.x) +
      3 * clamped * clamped * (to.x - toControl.x),
    y:
      3 * u * u * (fromControl.y - from.y) +
      6 * u * clamped * (toControl.y - fromControl.y) +
      3 * clamped * clamped * (to.y - toControl.y),
  };
}

export type StarMapEdgeVisibility = "hidden" | "dimmed" | "normal" | "focused";

/**
 * Resting maps show only the reachability backbone. Focusing a ticket always
 * restores its exact declared relationships; the all-links toggle restores
 * every other relationship too, dimmed so the focused neighborhood still wins.
 */
export function starMapEdgeVisibility(
  fromId: string,
  toId: string,
  backbone: boolean,
  selection: string | null,
  showAllLinks: boolean,
): StarMapEdgeVisibility {
  if (selection !== null && (fromId === selection || toId === selection)) {
    return "focused";
  }
  if (!backbone && !showAllLinks) return "hidden";
  return selection === null ? "normal" : "dimmed";
}

/** Particles fade in leaving the blocker and out arriving at the dependent. */
export function particleAlpha(t: number): number {
  return Math.sin(Math.PI * Math.min(Math.max(t, 0), 1));
}

/** Flow speed along a satisfied edge, in world units per second. */
export const STAR_MAP_FLOW_SPEED = 45;
export const STAR_MAP_FLOW_PARTICLES_PER_EDGE = 2;

export interface StarMapFlowParticle {
  /** Index into the engine's satisfied-edge list. */
  readonly edgeIndex: number;
  /** Position along the curve, 0 at the blocker and 1 at the dependent. */
  t: number;
  /** Progress per second, so all edges take roughly length/speed seconds. */
  readonly speed: number;
}

/**
 * Deterministic particle set: every satisfied edge gets `particlesPerEdge`
 * particles with hash-seeded phases and ±15% speed variance, so the flow
 * looks organic but replays identically for identical input.
 */
export function createFlowParticles(
  edgeLengths: ReadonlyArray<number>,
  particlesPerEdge: number = STAR_MAP_FLOW_PARTICLES_PER_EDGE,
): Array<StarMapFlowParticle> {
  const particles: Array<StarMapFlowParticle> = [];
  for (let edgeIndex = 0; edgeIndex < edgeLengths.length; edgeIndex += 1) {
    const length = Math.max(edgeLengths[edgeIndex]!, 1);
    for (let slot = 0; slot < particlesPerEdge; slot += 1) {
      const seed = hash32(`${edgeIndex}\n${slot}`);
      const phase = ((seed & 0xffff) / 0x10000 + slot / particlesPerEdge) % 1;
      const variance = 0.85 + 0.3 * ((seed >>> 16) / 0x10000);
      particles.push({ edgeIndex, t: phase, speed: (STAR_MAP_FLOW_SPEED * variance) / length });
    }
  }
  return particles;
}

export function advanceFlowParticles(particles: Array<StarMapFlowParticle>, dtMs: number): void {
  for (const particle of particles) {
    particle.t = (particle.t + (particle.speed * dtMs) / 1000) % 1;
  }
}

// ---------------------------------------------------------------------------
// Starfield
// ---------------------------------------------------------------------------

/** Side of the square screen-space tile the starfield repeats on. */
/**
 * The starfield repeats on this grid. It must stay LARGER than a realistic
 * panel, or the eye reads the repeat as structure: at 512 an 851x1056 panel
 * stamped the identical 26-star arrangement six times and the field looked
 * like clumps in a pattern rather than stars. Star counts scale with the tile
 * area so density is unchanged, and the draw loop culls off-canvas stars so a
 * bigger tile costs less to draw, not more.
 */
export const STAR_MAP_STARFIELD_TILE = 1600;

export interface StarMapStarfieldLayer {
  /** Fraction of camera movement applied to this layer; smaller reads farther. */
  readonly parallax: number;
  readonly starsPerTile: number;
  readonly minRadius: number;
  readonly maxRadius: number;
  readonly baseAlpha: number;
}

export const STAR_MAP_STARFIELD_LAYERS: ReadonlyArray<StarMapStarfieldLayer> = [
  { parallax: 0.18, starsPerTile: 254, minRadius: 0.6, maxRadius: 1.2, baseAlpha: 0.55 },
  { parallax: 0.42, starsPerTile: 137, minRadius: 1.0, maxRadius: 1.8, baseAlpha: 0.85 },
];

export interface StarMapStarfieldStar {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly baseAlpha: number;
  readonly twinklePhase: number;
  /** Twinkle cycles per second. */
  readonly twinkleSpeed: number;
}

/**
 * MurmurHash3 finalizer. `hash32` is FNV-1a, whose avalanche is weak in the low
 * bits: for inputs differing only in a trailing digit — exactly `"0:1"`,
 * `"0:2"`, `"0:3"` — the low half advances almost linearly, so taking x from
 * the low bits and y from the high bits marched consecutive stars along a line
 * and the starfield drew as repeating clumps instead of scatter. `hash32`
 * itself is deliberately untouched: it seeds ticket layout and the content
 * revision, and changing it would move every node and break spatial memory.
 */
function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x85ebca6b) >>> 0;
  mixed ^= mixed >>> 13;
  mixed = Math.imul(mixed, 0xc2b2ae35) >>> 0;
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

/** Unit interval from an independently salted, avalanched hash. */
function starfieldUnit(salt: string, layerIndex: number, starIndex: number): number {
  return mix32(hash32(`${salt}:${layerIndex}:${starIndex}`)) / 0x1_0000_0000;
}

/** One deterministic star inside a tile; same input, same star, forever. */
export function starfieldStar(
  layer: StarMapStarfieldLayer,
  layerIndex: number,
  starIndex: number,
): StarMapStarfieldStar {
  // Each field draws from its own salt, so no two share bits of one hash.
  return {
    x: starfieldUnit("x", layerIndex, starIndex) * STAR_MAP_STARFIELD_TILE,
    y: starfieldUnit("y", layerIndex, starIndex) * STAR_MAP_STARFIELD_TILE,
    radius:
      layer.minRadius +
      starfieldUnit("r", layerIndex, starIndex) * (layer.maxRadius - layer.minRadius),
    baseAlpha: layer.baseAlpha,
    twinklePhase: starfieldUnit("p", layerIndex, starIndex) * TAU,
    twinkleSpeed: 0.15 + 0.35 * starfieldUnit("s", layerIndex, starIndex),
  };
}

/**
 * Screen-space tile offset for a layer: stars drift opposite the camera at a
 * fraction of its movement, wrapped into `[0, tile)` so the field is endless.
 */
export function wrappedStarfieldOffset(
  centerX: number,
  centerY: number,
  scale: number,
  parallax: number,
  tile: number,
): StarMapPoint {
  const wrap = (value: number) => ((value % tile) + tile) % tile;
  return { x: wrap(-centerX * scale * parallax), y: wrap(-centerY * scale * parallax) };
}

/** Alpha oscillation between 40% and 100% of the base, driven by ambient time. */
export function twinkleAlpha(
  baseAlpha: number,
  phase: number,
  speed: number,
  clockMs: number,
): number {
  return baseAlpha * (0.7 + 0.3 * Math.sin(TAU * ((speed * clockMs) / 1000) + phase));
}

// ---------------------------------------------------------------------------
// Frontier pulse
// ---------------------------------------------------------------------------

export const STAR_MAP_FRONTIER_PULSE_MS = 2600;

/**
 * Expanding-ring phase for a frontier star: phase sweeps 0→1 over the pulse
 * period, alpha falls off quadratically so the ring dissolves as it grows.
 * The seed desynchronizes stars; the clock is ambient time, so pulses freeze
 * when the loop stops.
 */
export function frontierPulse(
  clockMs: number,
  seed: number,
): { readonly phase: number; readonly alpha: number } {
  const seedFraction = (seed & 0xffff) / 0x10000;
  const raw = clockMs / STAR_MAP_FRONTIER_PULSE_MS + seedFraction;
  const phase = raw - Math.floor(raw);
  const alpha = (1 - phase) * (1 - phase);
  return { phase, alpha };
}

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

/**
 * Standalone probe the panel mount uses to pick its default view (list under
 * reduced motion) before constructing the engine. DOM-guarded so importing
 * this module in the Node test harness is safe.
 */
export function detectPrefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const STAR_MAP_STATUSES = ["open", "claimed", "resolved", "out_of_scope"] as const;

const GLOW_SPRITE_SIZE = 96;
/** Extra screen pixels around the viewport inside which content still draws. */
const DRAW_MARGIN = 48;

interface StarMapBrushes {
  readonly background: string;
  readonly completion: string;
  readonly completionEdge: string;
  readonly completionLabel: string;
  readonly completionVariants: ReadonlyArray<string>;
  readonly edge: string;
  readonly edgeSatisfied: string;
  readonly undermine: string;
  readonly label: string;
  readonly selection: string;
  readonly starHot: string;
  readonly core: Record<StarMapNodeStatus, string>;
  readonly starVariants: ReadonlyArray<string>;
  readonly starfieldFarVariants: ReadonlyArray<string>;
  readonly starfieldNearVariants: ReadonlyArray<string>;
  readonly pulseVariants: Record<StarMapNodeStatus, ReadonlyArray<string>>;
}

interface StarMapEdgeGeometry {
  readonly fromId: string;
  readonly toId: string;
  readonly kind: "blocks" | "undermines";
  readonly from: StarMapPoint;
  readonly fromControl: StarMapPoint;
  readonly toControl: StarMapPoint;
  readonly to: StarMapPoint;
  readonly satisfied: boolean;
  readonly backbone: boolean;
}

export interface StarMapRendererOptions {
  /** Element the engine fills with its canvas — the `data-star-map-canvas` div. */
  readonly container: HTMLElement;
  readonly graph: StarMapGraph | null;
  readonly layout: StarMapLayoutResult | null;
  /** True when the authoritative map counts contain only terminal tickets. */
  readonly complete?: boolean;
  /** Initial camera; when omitted the engine fits the map once it has a size. */
  readonly camera?: StarMapCamera;
  readonly selection?: string | null;
  /** Whether the resting constellation renders declared transitive links too. */
  readonly showAllLinks?: boolean;
  /** Mount-reported gate; defaults true and should be driven on surface switches. */
  readonly surfaceActive?: boolean;
  /** Theme override that skips DOM token reads (headless/testing only). */
  readonly theme?: StarMapTheme;
  /** Reduced-motion override that skips the media query (headless/testing only). */
  readonly reducedMotion?: boolean;
  /** Mirrors `framesRendered`/`loopRunning` onto canvas data attributes. */
  readonly debugFrameCounter?: boolean;
}

export class StarMapRenderer {
  /** Public so the mount can attach native listeners (wheel with `passive: false`). */
  readonly canvas: HTMLCanvasElement;

  private readonly container: HTMLElement;
  private readonly themeOverride: StarMapTheme | undefined;
  private readonly reducedMotionOverride: boolean | undefined;
  private readonly debugFrameCounter: boolean;

  private ctx: CanvasRenderingContext2D | null = null;
  private graph: StarMapGraph | null;
  private layout: StarMapLayoutResult | null;
  private complete: boolean;
  /** Explicit camera, or null while the engine auto-fits the content. */
  private cameraValue: StarMapCamera | null;
  private selection: string | null;
  private showAllLinks: boolean;
  private selectionNeighborhood = new Set<string>();

  private theme: StarMapTheme;
  private brushes: StarMapBrushes;
  private glowSprites: Partial<Record<StarMapNodeStatus, HTMLCanvasElement>> = {};
  private completionGlowSprite: HTMLCanvasElement | null = null;
  private labelFont = "11px sans-serif";

  private viewport: StarMapSize = { width: 0, height: 0 };
  private dpr = 1;

  private governor: StarMapRateGovernor = createStarMapRateGovernor(0);
  private rafId: number | null = null;
  private frames = 0;
  private started = false;
  private destroyed = false;
  private pendingStaticFrame = true;
  private staticFrameScheduled = false;
  private gestureActive = false;

  private reducedMotionValue: boolean;
  private documentHidden = false;
  private windowFocused = true;
  private surfaceActive: boolean;
  private onScreen = false;

  private edgeGeometry: Array<StarMapEdgeGeometry> = [];
  /** Satisfied backbone edges, aligned with `particles`' edgeIndex. */
  private flowEdges: Array<StarMapEdgeGeometry> = [];
  private particles: Array<StarMapFlowParticle> = [];
  private readonly starfieldStars: ReadonlyArray<ReadonlyArray<StarMapStarfieldStar>>;
  private readonly labelNodes: Array<StarMapLabelNode> = [];
  private labelPlacements: ReadonlyArray<StarMapLabelPlacement> = [];
  /**
   * True once the user has framed the map themselves. Only then is the camera
   * theirs to keep across a resize; otherwise the framing was chosen for a
   * viewport that no longer exists and must be recomputed. Selection easing
   * does NOT set this — it inherits whatever framing was already in effect.
   */
  private userFramedCamera = false;

  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private motionMedia: MediaQueryList | null = null;
  private dprMedia: MediaQueryList | null = null;

  constructor(options: StarMapRendererOptions) {
    this.container = options.container;
    this.graph = options.graph;
    this.layout = options.layout;
    this.complete = options.complete ?? false;
    this.cameraValue = options.camera ?? null;
    this.selection = options.selection ?? null;
    this.showAllLinks = options.showAllLinks ?? false;
    this.surfaceActive = options.surfaceActive ?? true;
    this.themeOverride = options.theme;
    this.reducedMotionOverride = options.reducedMotion;
    this.reducedMotionValue = options.reducedMotion ?? detectPrefersReducedMotion();
    this.debugFrameCounter = options.debugFrameCounter ?? false;

    this.canvas = document.createElement("canvas");
    // Token scoping per design decision 15: the engine carries `[data-star-map]`
    // on its own canvas, so no panel markup change is required.
    this.canvas.dataset.starMap = "";
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    // The next task's pan/zoom gestures must not degenerate into scrolling.
    this.canvas.style.touchAction = "none";

    this.theme = this.themeOverride ?? DEFAULT_STAR_MAP_THEME;
    this.brushes = this.buildBrushes(this.theme);
    this.starfieldStars = STAR_MAP_STARFIELD_LAYERS.map((layer, layerIndex) =>
      Array.from({ length: layer.starsPerTile }, (_, starIndex) =>
        starfieldStar(layer, layerIndex, starIndex),
      ),
    );
    this.rebuildGraphGeometry();
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Appends the canvas, wires every gate listener, and either starts the loop
   * or renders the single static frame, per the current gates. Idempotent.
   */
  start(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d", { alpha: false });
    this.governor = createStarMapRateGovernor(this.now());

    this.refreshTheme();

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) this.handleResize(entry.contentRect.width, entry.contentRect.height);
    });
    this.resizeObserver.observe(this.container);
    this.handleResize(this.container.clientWidth, this.container.clientHeight);
    this.watchDpr();

    this.documentHidden = document.hidden;
    this.windowFocused = document.hasFocus();
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("focus", this.handleFocusChange);
    window.addEventListener("blur", this.handleFocusChange);

    this.intersectionObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      this.onScreen = entry.isIntersecting;
      this.evaluate();
    });
    this.intersectionObserver.observe(this.canvas);

    if (this.reducedMotionOverride === undefined) {
      this.motionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
      this.reducedMotionValue = this.motionMedia.matches;
      this.motionMedia.addEventListener("change", this.handleMotionChange);
    }

    // Theme switches toggle `.dark` and appearance overrides set inline
    // properties; both land on <html>, so one shallow observer covers them.
    this.mutationObserver = new MutationObserver(() => this.refreshTheme());
    this.mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    this.evaluate();
  }

  /** Cancels the loop, removes every listener and the canvas. Terminal. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopLoop();
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.mutationObserver?.disconnect();
    this.motionMedia?.removeEventListener("change", this.handleMotionChange);
    this.dprMedia?.removeEventListener("change", this.handleDprChange);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener("focus", this.handleFocusChange);
    window.removeEventListener("blur", this.handleFocusChange);
    this.canvas.remove();
  }

  // -- observable state -----------------------------------------------------

  /**
   * Frames actually painted since construction. This is the counter the manual
   * verification pass watches: it must stop advancing when the surface is
   * hidden, and advance at the ambient rate — never full refresh — when idle.
   */
  get framesRendered(): number {
    return this.frames;
  }

  /** True while the `requestAnimationFrame` chain is live. */
  get loopRunning(): boolean {
    return this.rafId !== null;
  }

  get reducedMotion(): boolean {
    return this.reducedMotionValue;
  }

  getCamera(): StarMapCamera {
    return this.currentCamera();
  }

  getViewport(): StarMapSize {
    return this.viewport;
  }

  toWorld(point: StarMapPoint): StarMapPoint {
    return screenToWorld(this.currentCamera(), this.viewport, point);
  }

  /** Placements from the most recent painted frame, for label hit-testing. */
  getLabelPlacements(): ReadonlyArray<StarMapLabelPlacement> {
    return this.labelPlacements;
  }

  toScreen(point: StarMapPoint): StarMapPoint {
    return worldToScreen(this.currentCamera(), this.viewport, point);
  }

  // -- inputs from the mount --------------------------------------------------

  setGraph(graph: StarMapGraph | null, layout: StarMapLayoutResult | null, complete = false): void {
    this.graph = graph;
    this.layout = layout;
    this.complete = complete;
    this.rebuildGraphGeometry();
    this.invalidate();
  }

  setCamera(camera: StarMapCamera, options?: { readonly user?: boolean }): void {
    this.cameraValue = camera;
    if (options?.user === true) this.userFramedCamera = true;
    this.invalidate();
  }

  /** Returns to auto-fit; the reset-view control and map switches use this. */
  fitToContent(): void {
    this.cameraValue = null;
    this.userFramedCamera = false;
    this.invalidate();
  }

  setSelection(nodeId: string | null): void {
    this.selection = nodeId;
    this.rebuildSelectionNeighborhood();
    this.invalidate();
  }

  setShowAllLinks(showAllLinks: boolean): void {
    if (this.showAllLinks === showAllLinks) return;
    this.showAllLinks = showAllLinks;
    this.invalidate();
  }

  /**
   * The surface gate: the mount passes false when another right-panel surface
   * becomes active while this one stays mounted (sheet `keepMounted`).
   */
  setSurfaceActive(active: boolean): void {
    if (this.surfaceActive === active) return;
    this.surfaceActive = active;
    this.evaluate();
  }

  /** Full-rate hint for the duration of a pan/zoom gesture. */
  setGestureActive(active: boolean): void {
    this.gestureActive = active;
    if (active) this.noteInteraction();
  }

  /** Marks activity: full-rate rendering and a reset idle clock. */
  noteInteraction(): void {
    noteStarMapInteraction(this.governor, this.now());
    this.invalidate();
  }

  /** Re-reads the theme tokens (once per theme change) and repaints. */
  refreshTheme(): void {
    if (this.themeOverride !== undefined) {
      this.applyTheme(this.themeOverride);
    } else if (typeof getComputedStyle === "function") {
      this.applyTheme(
        resolveStarMapTheme((token) => getComputedStyle(this.canvas).getPropertyValue(token)),
      );
    }
    this.invalidate();
  }

  // -- gates and the loop -----------------------------------------------------

  private now(): number {
    return typeof performance === "undefined" ? 0 : performance.now();
  }

  private currentGates(): StarMapLoopGates {
    return {
      reducedMotion: this.reducedMotionValue,
      documentHidden: this.documentHidden,
      windowFocused: this.windowFocused,
      surfaceActive: this.surfaceActive,
      onScreen: this.onScreen,
    };
  }

  /**
   * Repaint request: the next tick renders immediately (dt 0) when the loop
   * runs, or the single static frame when it must not.
   */
  private invalidate(): void {
    this.governor.lastFrameAt = null;
    this.pendingStaticFrame = true;
    this.evaluate();
  }

  private evaluate(): void {
    if (this.destroyed || !this.started) return;
    const gates = this.currentGates();
    if (starMapLoopShouldRun(gates)) {
      this.pendingStaticFrame = false;
      if (this.rafId === null) {
        this.governor.lastFrameAt = null;
        this.rafId = requestAnimationFrame(this.tick);
        this.mirrorLoopState();
      }
      return;
    }
    this.stopLoop();
    if (this.pendingStaticFrame && starMapShouldRenderStaticFrame(gates)) {
      this.scheduleStaticFrame();
    }
  }

  /**
   * Coalesces static frames so one user-level change paints once. Selecting a
   * ticket invalidates twice — once for the selection, once for the camera
   * move it triggers — and drawing synchronously from each would paint twice
   * under reduced motion, breaking the one-frame-per-change contract. A
   * microtask drains after the whole React commit, so both collapse into one
   * draw. This is deliberately NOT `requestAnimationFrame`: reduced motion must
   * never reach that call, and `loopRunning` must stay false throughout.
   */
  private scheduleStaticFrame(): void {
    if (this.staticFrameScheduled) return;
    this.staticFrameScheduled = true;
    queueMicrotask(() => {
      this.staticFrameScheduled = false;
      if (this.destroyed || !this.started || !this.pendingStaticFrame) return;
      const gates = this.currentGates();
      // The loop may have armed between scheduling and draining; it paints its
      // own frames, so the pending static frame is no longer owed.
      if (starMapLoopShouldRun(gates)) return;
      if (!starMapShouldRenderStaticFrame(gates)) return;
      this.pendingStaticFrame = false;
      this.drawFrame(0);
      this.countFrame();
    });
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.mirrorLoopState();
    }
    // A resume starts with dt 0 instead of the whole hidden gap.
    this.governor.lastFrameAt = null;
  }

  private tick = (now: number): void => {
    this.rafId = null;
    if (this.destroyed) return;
    const decision = advanceStarMapRateGovernor(this.governor, now, this.gestureActive);
    if (decision.render) {
      this.drawFrame(decision.dtMs);
      this.countFrame();
    }
    if (!this.destroyed) {
      // Skipped frames keep the chain alive but paint nothing: no raster, no
      // GPU cost — the frame counter, not the rAF rate, is the proof of work.
      this.rafId = requestAnimationFrame(this.tick);
    }
  };

  private countFrame(): void {
    this.frames += 1;
    if (this.debugFrameCounter) this.canvas.dataset.starMapFrames = String(this.frames);
  }

  private mirrorLoopState(): void {
    if (this.debugFrameCounter) {
      this.canvas.dataset.starMapLoopRunning = String(this.rafId !== null);
    }
  }

  private handleVisibilityChange = (): void => {
    this.documentHidden = document.hidden;
    this.evaluate();
  };

  private handleFocusChange = (): void => {
    this.windowFocused = document.hasFocus();
    this.evaluate();
  };

  private handleMotionChange = (): void => {
    this.reducedMotionValue = this.motionMedia?.matches ?? false;
    this.invalidate();
  };

  private handleDprChange = (): void => {
    this.handleResize(this.container.clientWidth, this.container.clientHeight);
    // The query value embeds the DPR, so re-register to catch the next drag.
    this.watchDpr();
  };

  private watchDpr(): void {
    if (typeof window.matchMedia !== "function") return;
    this.dprMedia?.removeEventListener("change", this.handleDprChange);
    this.dprMedia = window.matchMedia(dprMediaQueryText(window.devicePixelRatio || 1));
    this.dprMedia.addEventListener("change", this.handleDprChange);
  }

  private handleResize(cssWidth: number, cssHeight: number): void {
    const dpr = window.devicePixelRatio || 1;
    const backing = backingStoreSize(cssWidth, cssHeight, dpr);
    this.viewport = { width: cssWidth, height: cssHeight };
    this.dpr = dpr;
    // The camera was framed for the old box. Auto framing recomputes itself in
    // `currentCamera`, but a pinned camera would keep a scale and centre chosen
    // for a viewport that no longer exists — which is how a re-laid-out panel
    // ends up drawing the whole constellation off-canvas.
    if (this.cameraValue !== null) {
      if (this.userFramedCamera) {
        this.cameraValue = clampCamera(this.cameraValue, this.contentBounds(), this.viewport);
      } else {
        this.cameraValue = null;
      }
    }
    if (backing.width > 0 && backing.height > 0) {
      if (this.canvas.width !== backing.width) this.canvas.width = backing.width;
      if (this.canvas.height !== backing.height) this.canvas.height = backing.height;
    }
    this.invalidate();
  }

  // -- theme ------------------------------------------------------------------

  private applyTheme(theme: StarMapTheme): void {
    this.theme = theme;
    this.brushes = this.buildBrushes(theme);
    this.buildGlowSprites();
    if (typeof getComputedStyle === "function" && this.canvas.isConnected) {
      const family = getComputedStyle(this.canvas).fontFamily;
      if (family.length > 0) this.labelFont = `11px ${family}`;
    }
  }

  private buildBrushes(theme: StarMapTheme): StarMapBrushes {
    const core = {} as Record<StarMapNodeStatus, string>;
    const pulseVariants = {} as Record<StarMapNodeStatus, ReadonlyArray<string>>;
    for (const status of STAR_MAP_STATUSES) {
      core[status] = formatCssColor(theme.status[status]);
      pulseVariants[status] = formatCssColorVariants(theme.status[status]);
    }
    return {
      background: formatCssColor(theme.background),
      completion: formatCssColor(theme.completion),
      completionEdge: formatCssColor(withAlpha(theme.completion, 0.8)),
      completionLabel: formatCssColor(withAlpha(theme.completion, 0.95)),
      completionVariants: formatCssColorVariants(theme.completion),
      edge: formatCssColor(theme.edge),
      edgeSatisfied: formatCssColor(withAlpha(theme.status.resolved, 0.85)),
      undermine: formatCssColor(withAlpha(theme.status.out_of_scope, 0.8)),
      label: formatCssColor(theme.label),
      selection: formatCssColor(theme.selection),
      starHot: formatCssColor(withAlpha(theme.star, 0.9)),
      core,
      starVariants: formatCssColorVariants(theme.star),
      starfieldFarVariants: formatCssColorVariants(theme.starfieldFar),
      starfieldNearVariants: formatCssColorVariants(theme.starfieldNear),
      pulseVariants,
    };
  }

  /** Per-status radial glow sprites, rebuilt per theme change — never per frame. */
  private buildGlowSprites(): void {
    const sprites: Partial<Record<StarMapNodeStatus, HTMLCanvasElement>> = {};
    for (const status of STAR_MAP_STATUSES) {
      const sprite = this.buildGlowSprite(this.theme.status[status]);
      if (sprite !== null) sprites[status] = sprite;
    }
    this.glowSprites = sprites;
    this.completionGlowSprite = this.buildGlowSprite(this.theme.completion);
  }

  private buildGlowSprite(color: StarMapColor): HTMLCanvasElement | null {
    const sprite = document.createElement("canvas");
    sprite.width = GLOW_SPRITE_SIZE;
    sprite.height = GLOW_SPRITE_SIZE;
    const context = sprite.getContext("2d");
    if (context === null) return null;
    const center = GLOW_SPRITE_SIZE / 2;
    const gradient = context.createRadialGradient(center, center, 0, center, center, center);
    gradient.addColorStop(0, formatCssColor(color, 0.8));
    gradient.addColorStop(0.35, formatCssColor(color, 0.25));
    gradient.addColorStop(1, formatCssColor(color, 0));
    context.fillStyle = gradient;
    context.fillRect(0, 0, GLOW_SPRITE_SIZE, GLOW_SPRITE_SIZE);
    return sprite;
  }

  // -- per-graph geometry -------------------------------------------------------

  private rebuildGraphGeometry(): void {
    this.edgeGeometry = [];
    this.flowEdges = [];
    this.particles = [];
    const graph = this.graph;
    const layout = this.layout;
    this.rebuildSelectionNeighborhood();
    if (graph === null || layout === null) return;
    const backboneEdges = new Set(graph.backboneEdges);
    const flowLengths: Array<number> = [];
    for (const edge of graph.edges) {
      const from = layout.positionById.get(edge.from);
      const to = layout.positionById.get(edge.to);
      if (from === undefined || to === undefined) continue;
      const controls = edgeCurveControls(from, to, hash32(`${edge.from}\n${edge.to}`));
      const satisfied =
        edge.kind === "blocks" && isSatisfiedBlockerStatus(graph.nodeById.get(edge.from)?.status);
      const geometry: StarMapEdgeGeometry = {
        fromId: edge.from,
        toId: edge.to,
        kind: edge.kind,
        from,
        ...controls,
        to,
        satisfied,
        backbone: backboneEdges.has(edge),
      };
      this.edgeGeometry.push(geometry);
      // Transitive links become directional when focused via their arrowhead;
      // keeping ambient particles on the resting backbone avoids paying to
      // animate links that are normally hidden.
      if (satisfied && geometry.backbone) {
        this.flowEdges.push(geometry);
        flowLengths.push(Math.hypot(to.x - from.x, to.y - from.y));
      }
    }
    this.particles = createFlowParticles(flowLengths);
  }

  private rebuildSelectionNeighborhood(): void {
    this.selectionNeighborhood.clear();
    const graph = this.graph;
    const selection = this.selection;
    if (graph === null || selection === null || !graph.nodeById.has(selection)) return;
    this.selectionNeighborhood.add(selection);
    const adjacency = [graph.incoming.get(selection), graph.outgoing.get(selection)];
    for (const group of adjacency) {
      if (group === undefined) continue;
      for (const edge of [...group.blocks, ...group.undermines]) {
        this.selectionNeighborhood.add(edge.from);
        this.selectionNeighborhood.add(edge.to);
      }
    }
  }

  private activeSelection(): string | null {
    return this.selectionNeighborhood.size > 0 ? this.selection : null;
  }

  private contentBounds() {
    return this.layout !== null
      ? boundsFromPoints(this.layout.positions)
      : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  private currentCamera(): StarMapCamera {
    if (this.cameraValue !== null) return this.cameraValue;
    return fitCameraToBounds(this.contentBounds(), this.viewport);
  }

  // -- drawing ------------------------------------------------------------------

  private drawFrame(dtMs: number): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const { width, height } = this.viewport;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.brushes.background;
    ctx.fillRect(0, 0, width, height);
    if (width <= 0 || height <= 0) return;

    if (dtMs > 0) advanceFlowParticles(this.particles, dtMs);
    const camera = this.currentCamera();
    this.drawStarfield(ctx, camera, width, height);
    if (this.graph === null || this.layout === null) return;
    this.drawEdges(ctx, camera, width, height);
    this.drawFlowParticles(ctx, camera, width, height);
    this.drawStarsAndCollectLabels(ctx, camera, width, height);
    this.drawLabels(ctx, width);
  }

  private drawStarfield(
    ctx: CanvasRenderingContext2D,
    camera: StarMapCamera,
    width: number,
    height: number,
  ): void {
    const clock = this.governor.ambientClockMs;
    for (let layerIndex = 0; layerIndex < STAR_MAP_STARFIELD_LAYERS.length; layerIndex += 1) {
      const layer = STAR_MAP_STARFIELD_LAYERS[layerIndex]!;
      const stars = this.starfieldStars[layerIndex]!;
      const variants =
        layerIndex === 0 ? this.brushes.starfieldFarVariants : this.brushes.starfieldNearVariants;
      const offset = wrappedStarfieldOffset(
        camera.centerX,
        camera.centerY,
        camera.scale,
        layer.parallax,
        STAR_MAP_STARFIELD_TILE,
      );
      for (let tileX = -offset.x; tileX < width; tileX += STAR_MAP_STARFIELD_TILE) {
        for (let tileY = -offset.y; tileY < height; tileY += STAR_MAP_STARFIELD_TILE) {
          for (const star of stars) {
            const x = tileX + star.x;
            const y = tileY + star.y;
            // Most of a tile now falls outside the canvas; skipping those makes
            // the cost track visible stars rather than tile area.
            if (x < -2 || x > width + 2 || y < -2 || y > height + 2) continue;
            const alpha = twinkleAlpha(star.baseAlpha, star.twinklePhase, star.twinkleSpeed, clock);
            ctx.fillStyle = variants[alphaVariantIndex(alpha, variants.length)]!;
            if (star.radius < 1.25) {
              ctx.fillRect(x - star.radius, y - star.radius, star.radius * 2, star.radius * 2);
            } else {
              ctx.beginPath();
              ctx.arc(x, y, star.radius, 0, TAU);
              ctx.fill();
            }
          }
        }
      }
    }
  }

  private drawEdges(
    ctx: CanvasRenderingContext2D,
    camera: StarMapCamera,
    width: number,
    height: number,
  ): void {
    const selection = this.activeSelection();
    for (const edge of this.edgeGeometry) {
      const visibility = starMapEdgeVisibility(
        edge.fromId,
        edge.toId,
        edge.backbone,
        selection,
        this.showAllLinks,
      );
      if (visibility === "hidden") continue;
      const from = worldToScreen(camera, this.viewport, edge.from);
      const fromControl = worldToScreen(camera, this.viewport, edge.fromControl);
      const toControl = worldToScreen(camera, this.viewport, edge.toControl);
      const to = worldToScreen(camera, this.viewport, edge.to);
      if (this.offScreen(from, fromControl, toControl, to, width, height)) continue;
      ctx.globalAlpha = visibility === "dimmed" ? 0.2 : 1;
      ctx.lineWidth = visibility === "focused" ? 1.6 : 1;
      if (edge.kind === "undermines") {
        ctx.strokeStyle = this.complete ? this.brushes.completionEdge : this.brushes.undermine;
        ctx.setLineDash([4, 4]);
      } else {
        ctx.strokeStyle = this.complete
          ? this.brushes.completionEdge
          : edge.satisfied
            ? this.brushes.edgeSatisfied
            : this.brushes.edge;
      }
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.bezierCurveTo(fromControl.x, fromControl.y, toControl.x, toControl.y, to.x, to.y);
      ctx.stroke();
      if (edge.kind === "undermines") ctx.setLineDash([]);
      if (visibility === "focused") {
        this.drawFocusedEdgeArrow(ctx, from, fromControl, toControl, to);
      }
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }

  private drawFlowParticles(
    ctx: CanvasRenderingContext2D,
    camera: StarMapCamera,
    width: number,
    height: number,
  ): void {
    if (this.particles.length === 0) return;
    const selection = this.activeSelection();
    const screenEdges = this.flowEdges.map((edge) => {
      const visibility = starMapEdgeVisibility(
        edge.fromId,
        edge.toId,
        edge.backbone,
        selection,
        this.showAllLinks,
      );
      if (visibility === "hidden") return null;
      return {
        from: worldToScreen(camera, this.viewport, edge.from),
        fromControl: worldToScreen(camera, this.viewport, edge.fromControl),
        toControl: worldToScreen(camera, this.viewport, edge.toControl),
        to: worldToScreen(camera, this.viewport, edge.to),
        visibility,
      };
    });
    const variants = this.complete ? this.brushes.completionVariants : this.brushes.starVariants;
    for (const particle of this.particles) {
      const edge = screenEdges[particle.edgeIndex];
      if (edge === null || edge === undefined) continue;
      const point = cubicBezierPoint(
        edge.from,
        edge.fromControl,
        edge.toControl,
        edge.to,
        particle.t,
      );
      if (point.x < -DRAW_MARGIN || point.x > width + DRAW_MARGIN) continue;
      if (point.y < -DRAW_MARGIN || point.y > height + DRAW_MARGIN) continue;
      const alpha = particleAlpha(particle.t) * 0.9 * (edge.visibility === "dimmed" ? 0.2 : 1);
      ctx.fillStyle = variants[alphaVariantIndex(alpha, variants.length)]!;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 1.6, 0, TAU);
      ctx.fill();
    }
  }

  private drawStarsAndCollectLabels(
    ctx: CanvasRenderingContext2D,
    camera: StarMapCamera,
    width: number,
    height: number,
  ): void {
    const graph = this.graph!;
    const layout = this.layout!;
    const clock = this.governor.ambientClockMs;
    const selection = this.activeSelection();
    this.labelNodes.length = 0;
    for (const node of graph.nodes) {
      const position = layout.positionById.get(node.id);
      if (position === undefined) continue;
      const screen = worldToScreen(camera, this.viewport, position);
      if (
        screen.x < -DRAW_MARGIN ||
        screen.x > width + DRAW_MARGIN ||
        screen.y < -DRAW_MARGIN ||
        screen.y > height + DRAW_MARGIN
      ) {
        continue;
      }

      const unrelated = selection !== null && !this.selectionNeighborhood.has(node.id);
      const starAlpha = unrelated
        ? 0.22
        : !this.complete && node.status === "out_of_scope"
          ? 0.55
          : 1;
      const coreRadius = node.isFrontier ? 3.4 : 2.8;
      const glowSize = coreRadius * (node.isFrontier ? 7 : 5.5);
      const sprite = this.complete ? this.completionGlowSprite : this.glowSprites[node.status];
      ctx.globalAlpha = starAlpha;
      if (sprite !== null && sprite !== undefined) {
        ctx.drawImage(sprite, screen.x - glowSize / 2, screen.y - glowSize / 2, glowSize, glowSize);
      }
      ctx.fillStyle = this.complete ? this.brushes.completion : this.brushes.core[node.status];
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, coreRadius, 0, TAU);
      ctx.fill();
      ctx.fillStyle = this.brushes.starHot;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, coreRadius * 0.45, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;

      if (!this.complete && node.isFrontier) {
        const pulse = frontierPulse(clock, hash32(node.id));
        if (pulse.alpha > 0.02) {
          const variants = this.brushes.pulseVariants[node.status];
          ctx.strokeStyle = variants[alphaVariantIndex(pulse.alpha * starAlpha, variants.length)]!;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(screen.x, screen.y, coreRadius * (1.4 + 2.6 * pulse.phase), 0, TAU);
          ctx.stroke();
        }
      }

      if (node.isUndermined) {
        ctx.globalAlpha = starAlpha;
        ctx.strokeStyle = this.complete ? this.brushes.completionEdge : this.brushes.undermine;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, coreRadius * 2.1, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      if (node.id === this.selection) {
        ctx.strokeStyle = this.brushes.selection;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, coreRadius * 2.8, 0, TAU);
        ctx.stroke();
      }

      this.labelNodes.push({
        id: node.id,
        ordinal: node.ordinal,
        label: node.label,
        x: screen.x,
        y: screen.y,
        priority:
          node.id === selection
            ? 4
            : this.selectionNeighborhood.has(node.id)
              ? 3
              : node.isFrontier
                ? 2
                : node.status === "open" || node.status === "claimed"
                  ? 1
                  : 0,
      });
    }
  }

  private drawLabels(ctx: CanvasRenderingContext2D, width: number): void {
    if (this.labelNodes.length === 0) return;
    ctx.font = this.labelFont;
    ctx.textBaseline = "middle";
    ctx.fillStyle = this.complete ? this.brushes.completionLabel : this.brushes.label;
    // Cached so the mount can hit-test exactly the labels that were drawn,
    // rather than recomputing placement (and risking a different answer).
    this.labelPlacements = placeStarMapLabels({
      nodes: this.labelNodes,
      viewportWidth: width,
    });
    const selection = this.activeSelection();
    for (const placement of this.labelPlacements) {
      if (placement.suppressed) continue;
      ctx.globalAlpha =
        selection !== null && !this.selectionNeighborhood.has(placement.id) ? 0.22 : 1;
      ctx.fillText(placement.text, placement.x, placement.y);
    }
    ctx.globalAlpha = 1;
  }

  private drawFocusedEdgeArrow(
    ctx: CanvasRenderingContext2D,
    from: StarMapPoint,
    fromControl: StarMapPoint,
    toControl: StarMapPoint,
    to: StarMapPoint,
  ): void {
    const point = cubicBezierPoint(from, fromControl, toControl, to, 0.82);
    const tangent = cubicBezierTangent(from, fromControl, toControl, to, 0.82);
    const length = Math.hypot(tangent.x, tangent.y);
    if (length < 1e-9) return;
    const alongX = tangent.x / length;
    const alongY = tangent.y / length;
    const backX = point.x - alongX * 7;
    const backY = point.y - alongY * 7;
    const sideX = -alongY * 3.5;
    const sideY = alongX * 3.5;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(backX + sideX, backY + sideY);
    ctx.lineTo(backX - sideX, backY - sideY);
    ctx.closePath();
    ctx.fill();
  }

  private offScreen(
    from: StarMapPoint,
    fromControl: StarMapPoint,
    toControl: StarMapPoint,
    to: StarMapPoint,
    width: number,
    height: number,
  ): boolean {
    const minX = Math.min(from.x, fromControl.x, toControl.x, to.x);
    const maxX = Math.max(from.x, fromControl.x, toControl.x, to.x);
    const minY = Math.min(from.y, fromControl.y, toControl.y, to.y);
    const maxY = Math.max(from.y, fromControl.y, toControl.y, to.y);
    return (
      maxX < -DRAW_MARGIN ||
      minX > width + DRAW_MARGIN ||
      maxY < -DRAW_MARGIN ||
      minY > height + DRAW_MARGIN
    );
  }
}
