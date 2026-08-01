import { describe, expect, it } from "vite-plus/test";

import {
  STAR_MAP_AMBIENT_FRAME_MS,
  STAR_MAP_EDGE_CURVATURE,
  STAR_MAP_EDGE_MAX_BEND,
  STAR_MAP_FLOW_SPEED,
  STAR_MAP_FRONTIER_PULSE_MS,
  STAR_MAP_IDLE_AFTER_MS,
  STAR_MAP_IDLE_TICK_MS,
  STAR_MAP_MAX_FRAME_DT_MS,
  STAR_MAP_STARFIELD_LAYERS,
  STAR_MAP_STARFIELD_TILE,
  advanceFlowParticles,
  advanceStarMapRateGovernor,
  backingStoreSize,
  createFlowParticles,
  createStarMapRateGovernor,
  detectPrefersReducedMotion,
  dprMediaQueryText,
  edgeCurveControl,
  frontierPulse,
  isSatisfiedBlockerStatus,
  noteStarMapInteraction,
  particleAlpha,
  quadraticBezierPoint,
  starMapLoopShouldRun,
  starMapShouldRenderStaticFrame,
  starfieldStar,
  twinkleAlpha,
  wrappedStarfieldOffset,
  type StarMapLoopGates,
} from "./starMapRenderer";

const OPEN_GATES: StarMapLoopGates = {
  reducedMotion: false,
  documentHidden: false,
  windowFocused: true,
  surfaceActive: true,
  onScreen: true,
};

describe("starMapLoopShouldRun", () => {
  it("runs only while every gate is open", () => {
    expect(starMapLoopShouldRun(OPEN_GATES)).toBe(true);
    // Each gate on its own is a hard stop.
    expect(starMapLoopShouldRun({ ...OPEN_GATES, reducedMotion: true })).toBe(false);
    expect(starMapLoopShouldRun({ ...OPEN_GATES, documentHidden: true })).toBe(false);
    expect(starMapLoopShouldRun({ ...OPEN_GATES, windowFocused: false })).toBe(false);
    expect(starMapLoopShouldRun({ ...OPEN_GATES, surfaceActive: false })).toBe(false);
    expect(starMapLoopShouldRun({ ...OPEN_GATES, onScreen: false })).toBe(false);
  });
});

describe("starMapShouldRenderStaticFrame", () => {
  it("allows the one-shot frame under reduced motion but never while hidden", () => {
    expect(starMapShouldRenderStaticFrame(OPEN_GATES)).toBe(true);
    // Reduced motion blocks the loop, not the single static frame.
    expect(starMapShouldRenderStaticFrame({ ...OPEN_GATES, reducedMotion: true })).toBe(true);
    expect(starMapShouldRenderStaticFrame({ ...OPEN_GATES, documentHidden: true })).toBe(false);
    expect(starMapShouldRenderStaticFrame({ ...OPEN_GATES, windowFocused: false })).toBe(false);
    expect(starMapShouldRenderStaticFrame({ ...OPEN_GATES, surfaceActive: false })).toBe(false);
    expect(starMapShouldRenderStaticFrame({ ...OPEN_GATES, onScreen: false })).toBe(false);
  });
});

describe("rate governor", () => {
  it("renders the first frame immediately with dt 0", () => {
    const governor = createStarMapRateGovernor(500);
    expect(advanceStarMapRateGovernor(governor, 500, false)).toEqual({
      render: true,
      dtMs: 0,
    });
  });

  it("renders every tick at full refresh while interacting, with real dt", () => {
    const governor = createStarMapRateGovernor(0);
    advanceStarMapRateGovernor(governor, 0, true);
    expect(advanceStarMapRateGovernor(governor, 16, true)).toEqual({ render: true, dtMs: 16 });
    expect(advanceStarMapRateGovernor(governor, 32, true)).toEqual({ render: true, dtMs: 16 });
  });

  it("keeps full rate through the interaction tail, then caps at the ambient rate", () => {
    const governor = createStarMapRateGovernor(0);
    advanceStarMapRateGovernor(governor, 0, false);
    // Within the 120 ms tail after the (initial) interaction: still full rate.
    expect(advanceStarMapRateGovernor(governor, 100, false).render).toBe(true);
    // Past the tail (130 ms) with less than one ambient frame elapsed: skipped.
    expect(advanceStarMapRateGovernor(governor, 130, false)).toEqual({
      render: false,
      dtMs: 0,
    });
    // One ambient interval after the last rendered frame the accumulator fires.
    const decision = advanceStarMapRateGovernor(
      governor,
      100 + STAR_MAP_AMBIENT_FRAME_MS + 1,
      false,
    );
    expect(decision.render).toBe(true);
    expect(decision.dtMs).toBeCloseTo(STAR_MAP_AMBIENT_FRAME_MS + 1, 5);
  });

  it("decays to the idle tick after ~10 s without interaction", () => {
    const governor = createStarMapRateGovernor(0);
    advanceStarMapRateGovernor(governor, 0, false);
    const idleNow = STAR_MAP_IDLE_AFTER_MS + 100;
    // Past the idle threshold only the slow tick interval remains.
    expect(advanceStarMapRateGovernor(governor, idleNow, false).render).toBe(true);
    expect(
      advanceStarMapRateGovernor(governor, idleNow + STAR_MAP_IDLE_TICK_MS - 10, false).render,
    ).toBe(false);
    expect(
      advanceStarMapRateGovernor(governor, idleNow + STAR_MAP_IDLE_TICK_MS + 10, false),
    ).toEqual({ render: true, dtMs: STAR_MAP_IDLE_TICK_MS + 10 });
  });

  it("returns to full rate on interaction and accumulates ambient time", () => {
    const governor = createStarMapRateGovernor(0);
    advanceStarMapRateGovernor(governor, 0, false);
    advanceStarMapRateGovernor(governor, 40, false); // ambient frame, dt 40
    expect(governor.ambientClockMs).toBe(40);
    noteStarMapInteraction(governor, 50);
    // Interaction resets the idle clock: full rate resumes immediately.
    expect(advanceStarMapRateGovernor(governor, 56, false)).toEqual({ render: true, dtMs: 16 });
    expect(governor.ambientClockMs).toBe(56);
  });

  it("clamps dt after long gaps so a resume cannot teleport motion", () => {
    const governor = createStarMapRateGovernor(0);
    advanceStarMapRateGovernor(governor, 0, false);
    const decision = advanceStarMapRateGovernor(governor, 60_000, false);
    expect(decision.render).toBe(true);
    expect(decision.dtMs).toBe(STAR_MAP_MAX_FRAME_DT_MS);
  });
});

describe("backingStoreSize", () => {
  it("scales by DPR with rounding and a minimum of 1", () => {
    expect(backingStoreSize(360, 600, 2)).toEqual({ width: 720, height: 1200 });
    expect(backingStoreSize(360.6, 600, 2)).toEqual({ width: 721, height: 1200 });
    expect(backingStoreSize(1, 1, 0.4)).toEqual({ width: 1, height: 1 });
  });

  it("reports 0/0 for hidden or nonsensical input", () => {
    expect(backingStoreSize(0, 600, 2)).toEqual({ width: 0, height: 0 });
    expect(backingStoreSize(360, 0, 2)).toEqual({ width: 0, height: 0 });
    expect(backingStoreSize(360, 600, 0)).toEqual({ width: 0, height: 0 });
    expect(backingStoreSize(Number.NaN, 600, 2)).toEqual({ width: 0, height: 0 });
  });
});

describe("dprMediaQueryText", () => {
  it("formats the resolution query that tracks the current DPR", () => {
    expect(dprMediaQueryText(2)).toBe("(resolution: 2dppx)");
    expect(dprMediaQueryText(1.5)).toBe("(resolution: 1.5dppx)");
  });
});

describe("isSatisfiedBlockerStatus", () => {
  it("is satisfied exactly when the blocker is resolved or ruled out", () => {
    expect(isSatisfiedBlockerStatus("resolved")).toBe(true);
    expect(isSatisfiedBlockerStatus("out_of_scope")).toBe(true);
    expect(isSatisfiedBlockerStatus("open")).toBe(false);
    expect(isSatisfiedBlockerStatus("claimed")).toBe(false);
    expect(isSatisfiedBlockerStatus(undefined)).toBe(false);
  });
});

describe("edgeCurveControl", () => {
  it("offsets the control point perpendicular to the chord, seeded per edge", () => {
    const control = edgeCurveControl({ x: 0, y: 0 }, { x: 100, y: 0 }, 2);
    expect(control.x).toBeCloseTo(50, 10);
    expect(Math.abs(control.y)).toBeCloseTo(100 * STAR_MAP_EDGE_CURVATURE, 10);
    // The seed picks the side deterministically.
    expect(edgeCurveControl({ x: 0, y: 0 }, { x: 100, y: 0 }, 3).y).toBe(-control.y);
    expect(edgeCurveControl({ x: 0, y: 0 }, { x: 100, y: 0 }, 2)).toEqual(control);
  });

  it("stays perpendicular for diagonal chords", () => {
    const from = { x: -40, y: 10 };
    const to = { x: 60, y: 90 };
    const control = edgeCurveControl(from, to, 0);
    const chord = { x: to.x - from.x, y: to.y - from.y };
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const offset = { x: control.x - mid.x, y: control.y - mid.y };
    expect(offset.x * chord.x + offset.y * chord.y).toBeCloseTo(0, 8);
  });

  it("caps the bend for long chords and handles zero-length edges", () => {
    const control = edgeCurveControl({ x: 0, y: 0 }, { x: 1000, y: 0 }, 0);
    expect(Math.abs(control.y)).toBeCloseTo(STAR_MAP_EDGE_MAX_BEND, 10);
    expect(edgeCurveControl({ x: 5, y: 5 }, { x: 5, y: 5 }, 1)).toEqual({ x: 5, y: 5 });
  });
});

describe("quadraticBezierPoint", () => {
  const from = { x: 0, y: 0 };
  const control = { x: 50, y: 40 };
  const to = { x: 100, y: 0 };

  it("lands on the endpoints at t 0 and 1", () => {
    expect(quadraticBezierPoint(from, control, to, 0)).toEqual(from);
    expect(quadraticBezierPoint(from, control, to, 1)).toEqual(to);
  });

  it("evaluates the midpoint blend at t 0.5", () => {
    const point = quadraticBezierPoint(from, control, to, 0.5);
    expect(point.x).toBeCloseTo(50, 10);
    expect(point.y).toBeCloseTo(20, 10);
  });
});

describe("particleAlpha", () => {
  it("fades in and out across the edge", () => {
    expect(particleAlpha(0)).toBe(0);
    expect(particleAlpha(1)).toBeCloseTo(0, 10);
    expect(particleAlpha(0.5)).toBeCloseTo(1, 10);
    expect(particleAlpha(-0.2)).toBe(0);
    expect(particleAlpha(1.2)).toBeCloseTo(0, 10);
  });
});

describe("flow particles", () => {
  it("creates a deterministic set: same input, same particles", () => {
    const first = createFlowParticles([100, 240]);
    const second = createFlowParticles([100, 240]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(4);
    for (const particle of first) {
      expect(particle.t).toBeGreaterThanOrEqual(0);
      expect(particle.t).toBeLessThan(1);
      const baseSpeed = STAR_MAP_FLOW_SPEED / (particle.edgeIndex === 0 ? 100 : 240);
      expect(particle.speed).toBeGreaterThanOrEqual(baseSpeed * 0.84);
      expect(particle.speed).toBeLessThanOrEqual(baseSpeed * 1.16);
    }
  });

  it("advances by speed * dt and wraps at the dependent end", () => {
    const particles = [
      { edgeIndex: 0, t: 0.9, speed: 0.5 },
      { edgeIndex: 0, t: 0, speed: 1 },
    ];
    advanceFlowParticles(particles, 400);
    expect(particles[0]!.t).toBeCloseTo(0.1, 10);
    expect(particles[1]!.t).toBeCloseTo(0.4, 10);
  });
});

describe("starfield", () => {
  const layer = STAR_MAP_STARFIELD_LAYERS[0]!;

  it("is deterministic and stays inside the tile", () => {
    for (let index = 0; index < layer.starsPerTile; index += 1) {
      const star = starfieldStar(layer, 0, index);
      expect(star).toEqual(starfieldStar(layer, 0, index));
      expect(star.x).toBeGreaterThanOrEqual(0);
      expect(star.x).toBeLessThan(STAR_MAP_STARFIELD_TILE);
      expect(star.y).toBeGreaterThanOrEqual(0);
      expect(star.y).toBeLessThan(STAR_MAP_STARFIELD_TILE);
      expect(star.radius).toBeGreaterThanOrEqual(layer.minRadius);
      expect(star.radius).toBeLessThanOrEqual(layer.maxRadius);
      expect(star.baseAlpha).toBe(layer.baseAlpha);
    }
  });

  it("differs between layers", () => {
    expect(starfieldStar(layer, 0, 3)).not.toEqual(
      starfieldStar(STAR_MAP_STARFIELD_LAYERS[1]!, 1, 3),
    );
  });

  it("wraps offsets into [0, tile) including negative camera movement", () => {
    expect(wrappedStarfieldOffset(0, 0, 1, 0.5, 512)).toEqual({ x: 0, y: 0 });
    expect(wrappedStarfieldOffset(100, -100, 1, 0.5, 512)).toEqual({ x: 462, y: 50 });
    expect(wrappedStarfieldOffset(-1024, 0, 1, 1, 512)).toEqual({ x: 0, y: 0 });
  });

  it("twinkles within 40%-100% of base alpha and is clock-driven", () => {
    expect(twinkleAlpha(0.8, 0, 0, 0)).toBeCloseTo(0.56, 10);
    for (let clock = 0; clock < 20_000; clock += 137) {
      const alpha = twinkleAlpha(0.8, 1.3, 0.4, clock);
      expect(alpha).toBeGreaterThanOrEqual(0.8 * 0.4 - 1e-9);
      expect(alpha).toBeLessThanOrEqual(0.8 + 1e-9);
    }
    // No clock advance, no motion — the static frame under reduced motion.
    expect(twinkleAlpha(0.8, 1.3, 0.4, 5000)).toBe(twinkleAlpha(0.8, 1.3, 0.4, 5000));
  });
});

describe("frontierPulse", () => {
  it("sweeps phase 0→1 over the period with quadratic alpha falloff", () => {
    expect(frontierPulse(0, 0)).toEqual({ phase: 0, alpha: 1 });
    const halfway = frontierPulse(STAR_MAP_FRONTIER_PULSE_MS / 2, 0);
    expect(halfway.phase).toBeCloseTo(0.5, 10);
    expect(halfway.alpha).toBeCloseTo(0.25, 10);
    // Wraps at the period boundary.
    expect(frontierPulse(STAR_MAP_FRONTIER_PULSE_MS, 0).phase).toBeCloseTo(0, 10);
  });

  it("desynchronizes stars by seed", () => {
    expect(frontierPulse(100, 0).phase).not.toBeCloseTo(frontierPulse(100, 12345).phase, 5);
  });
});

describe("detectPrefersReducedMotion", () => {
  it("is false outside a browser (the Node test harness)", () => {
    expect(detectPrefersReducedMotion()).toBe(false);
  });

  describe("starfield distribution", () => {
    // The starfield drew as repeating clumps of dots rather than scatter,
    // because x and y were the two halves of one FNV-1a hash and FNV-1a
    // avalanches poorly across inputs differing only in a trailing digit.
    // These assert scatter directly; determinism is covered above.
    const layer = STAR_MAP_STARFIELD_LAYERS[0]!;
    const stars = Array.from({ length: 400 }, (_, index) => starfieldStar(layer, 0, index));

    it("fills every quadrant of the tile instead of clumping", () => {
      const half = STAR_MAP_STARFIELD_TILE / 2;
      const quadrants = [0, 0, 0, 0];
      for (const star of stars) {
        quadrants[(star.x < half ? 0 : 1) + (star.y < half ? 0 : 2)]! += 1;
      }
      // A clumped field leaves quadrants near-empty; scatter lands ~25% each.
      for (const count of quadrants) {
        expect(count).toBeGreaterThan(stars.length * 0.15);
      }
    });

    it("keeps x and y uncorrelated, so stars do not march along a line", () => {
      const n = stars.length;
      const xs = stars.map((star) => star.x);
      const ys = stars.map((star) => star.y);
      const meanX = xs.reduce((a, b) => a + b, 0) / n;
      const meanY = ys.reduce((a, b) => a + b, 0) / n;
      let cov = 0;
      let varX = 0;
      let varY = 0;
      for (let i = 0; i < n; i += 1) {
        const dx = xs[i]! - meanX;
        const dy = ys[i]! - meanY;
        cov += dx * dy;
        varX += dx * dx;
        varY += dy * dy;
      }
      const correlation = cov / Math.sqrt(varX * varY);
      expect(Math.abs(correlation)).toBeLessThan(0.2);
    });

    it("does not step consecutive stars a near-constant distance apart", () => {
      const steps: number[] = [];
      for (let i = 1; i < 60; i += 1) {
        steps.push(Math.hypot(stars[i]!.x - stars[i - 1]!.x, stars[i]!.y - stars[i - 1]!.y));
      }
      const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
      const spread =
        Math.sqrt(steps.reduce((a, b) => a + (b - mean) ** 2, 0) / steps.length) / mean;
      // A marching line has near-identical steps (tiny spread); scatter varies.
      expect(spread).toBeGreaterThan(0.3);
    });
  });
});
