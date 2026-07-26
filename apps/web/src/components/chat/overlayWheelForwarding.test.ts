import { describe, expect, it } from "vite-plus/test";
import {
  elementConsumesWheel,
  overlayConsumesWheel,
  resolveWheelDeltaPixels,
  WHEEL_LINE_HEIGHT_PX,
  type WheelScrollableElement,
} from "./overlayWheelForwarding";

function element(
  input: Partial<Omit<WheelScrollableElement, "parentElement">> & {
    readonly parentElement?: WheelScrollableElement | null;
  } = {},
): WheelScrollableElement {
  return {
    scrollTop: input.scrollTop ?? 0,
    scrollHeight: input.scrollHeight ?? 100,
    clientHeight: input.clientHeight ?? 100,
    parentElement: input.parentElement ?? null,
  };
}

describe("resolveWheelDeltaPixels", () => {
  it("passes pixel deltas through and converts line and page deltas", () => {
    expect(resolveWheelDeltaPixels({ deltaY: -120, deltaMode: 0, viewportHeight: 800 })).toBe(-120);
    expect(resolveWheelDeltaPixels({ deltaY: 3, deltaMode: 1, viewportHeight: 800 })).toBe(
      3 * WHEEL_LINE_HEIGHT_PX,
    );
    expect(resolveWheelDeltaPixels({ deltaY: -1, deltaMode: 2, viewportHeight: 800 })).toBe(-800);
  });

  it("ignores deltas too small to move the list", () => {
    expect(resolveWheelDeltaPixels({ deltaY: 0, deltaMode: 0, viewportHeight: 800 })).toBe(0);
    expect(resolveWheelDeltaPixels({ deltaY: 0.2, deltaMode: 0, viewportHeight: 800 })).toBe(0);
    expect(resolveWheelDeltaPixels({ deltaY: Number.NaN, deltaMode: 0, viewportHeight: 800 })).toBe(
      0,
    );
  });
});

describe("elementConsumesWheel", () => {
  it("consumes only while there is room left in the gesture's direction", () => {
    const scrollable = element({ scrollTop: 50, scrollHeight: 400, clientHeight: 100 });
    expect(elementConsumesWheel(scrollable, -120)).toBe(true);
    expect(elementConsumesWheel(scrollable, 120)).toBe(true);

    const atTop = element({ scrollTop: 0, scrollHeight: 400, clientHeight: 100 });
    expect(elementConsumesWheel(atTop, -120)).toBe(false);
    expect(elementConsumesWheel(atTop, 120)).toBe(true);

    const atBottom = element({ scrollTop: 300, scrollHeight: 400, clientHeight: 100 });
    expect(elementConsumesWheel(atBottom, 120)).toBe(false);
    expect(elementConsumesWheel(atBottom, -120)).toBe(true);
  });

  it("never consumes for content that does not overflow", () => {
    expect(elementConsumesWheel(element({ scrollHeight: 100, clientHeight: 100 }), -120)).toBe(
      false,
    );
  });
});

describe("overlayConsumesWheel", () => {
  it("finds a scrollable region between the target and the host", () => {
    const host = element({ scrollHeight: 200, clientHeight: 200 });
    const region = element({
      scrollTop: 40,
      scrollHeight: 400,
      clientHeight: 100,
      parentElement: host,
    });
    const target = element({ parentElement: region });

    expect(overlayConsumesWheel({ target, host, deltaPixels: -120 })).toBe(true);
  });

  it("hands the gesture on when nothing between target and host can scroll", () => {
    const host = element({ scrollHeight: 200, clientHeight: 200 });
    const card = element({ parentElement: host });
    const target = element({ parentElement: card });

    expect(overlayConsumesWheel({ target, host, deltaPixels: -120 })).toBe(false);
  });

  it("stops at the host rather than handing the gesture to page ancestors", () => {
    const page = element({ scrollTop: 100, scrollHeight: 4000, clientHeight: 800 });
    const host = element({ scrollHeight: 200, clientHeight: 200, parentElement: page });
    const target = element({ parentElement: host });

    expect(overlayConsumesWheel({ target, host, deltaPixels: -120 })).toBe(false);
  });

  it("treats a missing target as unhandled", () => {
    expect(overlayConsumesWheel({ target: null, host: element(), deltaPixels: -120 })).toBe(false);
  });
});
