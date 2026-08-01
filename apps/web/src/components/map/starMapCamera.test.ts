import { describe, expect, it } from "vite-plus/test";

import {
  boundsFromPoints,
  clampCamera,
  fitCameraToBounds,
  panCameraBy,
  screenToWorld,
  STAR_MAP_FIT_PADDING,
  STAR_MAP_MAX_SCALE,
  STAR_MAP_MIN_SCALE,
  worldToScreen,
  zoomCameraAt,
  type StarMapCamera,
} from "./starMapCamera";

const VIEWPORT = { width: 360, height: 600 };
const BOUNDS = { minX: -500, minY: -300, maxX: 500, maxY: 300 };

describe("boundsFromPoints", () => {
  it("returns degenerate origin bounds for no points", () => {
    expect(boundsFromPoints([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });

  it("encloses all points plus padding", () => {
    const bounds = boundsFromPoints(
      [
        { x: -10, y: 5 },
        { x: 30, y: -20 },
        { x: 4, y: 12 },
      ],
      7,
    );
    expect(bounds).toEqual({ minX: -17, minY: -27, maxX: 37, maxY: 19 });
  });
});

describe("fitCameraToBounds", () => {
  it("centers on the bounds and fits the tighter axis with padding", () => {
    const camera = fitCameraToBounds(BOUNDS, VIEWPORT);
    expect(camera.centerX).toBe(0);
    expect(camera.centerY).toBe(0);
    // Width is the tighter axis: 360 / (1000 * padding) < 600 / (600 * padding).
    expect(camera.scale).toBeCloseTo(VIEWPORT.width / (1000 * STAR_MAP_FIT_PADDING), 10);

    const topLeft = worldToScreen(camera, VIEWPORT, { x: BOUNDS.minX, y: BOUNDS.minY });
    const bottomRight = worldToScreen(camera, VIEWPORT, { x: BOUNDS.maxX, y: BOUNDS.maxY });
    expect(topLeft.x).toBeGreaterThan(0);
    expect(bottomRight.x).toBeLessThan(VIEWPORT.width);
  });

  it("clamps the scale for tiny and huge content", () => {
    expect(fitCameraToBounds({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, VIEWPORT).scale).toBe(
      STAR_MAP_MAX_SCALE,
    );
    expect(
      fitCameraToBounds({ minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 }, VIEWPORT).scale,
    ).toBe(STAR_MAP_MIN_SCALE);
  });

  it("falls back to a unit camera for a degenerate viewport", () => {
    expect(fitCameraToBounds(BOUNDS, { width: 0, height: 0 })).toEqual({
      centerX: 0,
      centerY: 0,
      scale: 1,
    });
  });
});

describe("screen and world transforms", () => {
  it("round-trip through the camera", () => {
    const camera: StarMapCamera = { centerX: 120, centerY: -45, scale: 0.42 };
    const world = { x: 333, y: -128 };
    const screen = worldToScreen(camera, VIEWPORT, world);
    const roundTripped = screenToWorld(camera, VIEWPORT, screen);
    expect(roundTripped.x).toBeCloseTo(world.x, 10);
    expect(roundTripped.y).toBeCloseTo(world.y, 10);
  });

  it("maps the camera center to the viewport center", () => {
    const camera: StarMapCamera = { centerX: 88, centerY: -12, scale: 1.5 };
    expect(worldToScreen(camera, VIEWPORT, { x: 88, y: -12 })).toEqual({
      x: VIEWPORT.width / 2,
      y: VIEWPORT.height / 2,
    });
  });
});

describe("panCameraBy", () => {
  it("moves the camera opposite the drag in world units", () => {
    const camera: StarMapCamera = { centerX: 0, centerY: 0, scale: 2 };
    const panned = panCameraBy(camera, 100, -50);
    expect(panned.centerX).toBe(-50);
    expect(panned.centerY).toBe(25);
  });
});

describe("zoomCameraAt", () => {
  it("keeps the world point under the anchor fixed", () => {
    const camera = fitCameraToBounds(BOUNDS, VIEWPORT);
    const anchor = { x: 40, y: 500 };
    const before = screenToWorld(camera, VIEWPORT, anchor);
    const zoomed = zoomCameraAt(camera, VIEWPORT, anchor, 1.8);
    const after = worldToScreen(zoomed, VIEWPORT, before);
    expect(after.x).toBeCloseTo(anchor.x, 6);
    expect(after.y).toBeCloseTo(anchor.y, 6);
    expect(zoomed.scale).toBeCloseTo(camera.scale * 1.8, 10);
  });

  it("clamps the zoom factor and ignores non-positive factors", () => {
    const camera: StarMapCamera = { centerX: 5, centerY: 5, scale: STAR_MAP_MAX_SCALE };
    expect(zoomCameraAt(camera, VIEWPORT, { x: 0, y: 0 }, 10).scale).toBe(STAR_MAP_MAX_SCALE);
    expect(zoomCameraAt(camera, VIEWPORT, { x: 0, y: 0 }, 0)).toBe(camera);
    expect(zoomCameraAt(camera, VIEWPORT, { x: 0, y: 0 }, -2)).toBe(camera);
  });
});

describe("clampCamera", () => {
  it("keeps content reachable when panned into empty space", () => {
    const camera: StarMapCamera = { centerX: 100_000, centerY: -100_000, scale: 0.5 };
    const clamped = clampCamera(camera, BOUNDS, VIEWPORT);
    const visibleWorldWidth = VIEWPORT.width / clamped.scale;
    // At most the margin rule: the camera cannot go further than the content
    // edge plus the visible half-width minus the margin.
    expect(clamped.centerX).toBeLessThanOrEqual(BOUNDS.maxX + visibleWorldWidth / 2 - 60 + 1e-9);
    expect(clamped.centerY).toBeGreaterThanOrEqual(
      BOUNDS.minY - VIEWPORT.height / clamped.scale / 2 + 60 - 1e-9,
    );
  });

  it("settles on the content center when the content is smaller than the visible margin", () => {
    const squareViewport = { width: 360, height: 360 };
    const camera: StarMapCamera = { centerX: 900, centerY: -900, scale: STAR_MAP_MAX_SCALE };
    const clamped = clampCamera(
      camera,
      { minX: -10, minY: -10, maxX: 10, maxY: 10 },
      squareViewport,
    );
    expect(clamped.centerX).toBe(0);
    expect(clamped.centerY).toBe(0);
  });

  it("leaves an in-range camera untouched apart from scale clamping", () => {
    const camera: StarMapCamera = { centerX: 100, centerY: -50, scale: 1 };
    expect(clampCamera(camera, BOUNDS, VIEWPORT)).toEqual(camera);
  });
});
