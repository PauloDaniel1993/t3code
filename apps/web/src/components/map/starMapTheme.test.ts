import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_STAR_MAP_THEME,
  STAR_MAP_ALPHA_STEPS,
  STAR_MAP_THEME_TOKENS,
  alphaVariantIndex,
  formatCssColor,
  formatCssColorVariants,
  parseCssColor,
  resolveStarMapTheme,
  withAlpha,
} from "./starMapTheme";

describe("parseCssColor", () => {
  it("parses 3, 4, 6, and 8 digit hex", () => {
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("#3b82f6")).toEqual({ r: 59, g: 130, b: 246, a: 1 });
    expect(parseCssColor("#3b82f680")!.a).toBeCloseTo(0x80 / 0xff, 5);
    expect(parseCssColor("#fffb")).toEqual({ r: 255, g: 255, b: 255, a: 0xbb / 0xff });
  });

  it("parses comma and space-slash rgb() with and without alpha", () => {
    expect(parseCssColor("rgb(59, 130, 246)")).toEqual({ r: 59, g: 130, b: 246, a: 1 });
    expect(parseCssColor("rgba(59, 130, 246, 0.5)")).toEqual({ r: 59, g: 130, b: 246, a: 0.5 });
    expect(parseCssColor("rgb(168 180 205 / 0.45)")).toEqual({
      r: 168,
      g: 180,
      b: 205,
      a: 0.45,
    });
    expect(parseCssColor("rgb(100% 0% 0%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseCssColor("rgb(10 20 30 / 50%)")!.a).toBe(0.5);
  });

  it("parses oklch — the Tailwind v4 palette format the status tokens resolve to", () => {
    // Exact sRGB resolutions of the v4 500-scale values (v4 is more vivid
    // than v3 hex, and blue/amber land slightly out of gamut and clamp).
    expect(parseCssColor("oklch(0.623 0.214 259.815)")).toEqual({ r: 43, g: 127, b: 255, a: 1 });
    expect(parseCssColor("oklch(0.696 0.17 162.48)")).toEqual({ r: 0, g: 188, b: 125, a: 1 });
    expect(parseCssColor("oklch(0.769 0.188 70.08)")).toEqual({ r: 254, g: 154, b: 0, a: 1 });
    expect(parseCssColor("oklch(0.637 0.237 25.331)")).toEqual({ r: 251, g: 44, b: 54, a: 1 });
    expect(parseCssColor("oklch(1 0 0)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("oklch(0 0 0)")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it("parses oklch alpha and powerless hue", () => {
    expect(parseCssColor("oklch(0.5 0.1 40 / 0.25)")!.a).toBe(0.25);
    expect(parseCssColor("oklch(50% 0.1 none)")).not.toBeNull();
  });

  it("returns null for anything it cannot parse", () => {
    expect(parseCssColor("")).toBeNull();
    expect(parseCssColor("   ")).toBeNull();
    expect(parseCssColor("rebeccapurple")).toBeNull();
    expect(parseCssColor("var(--info)")).toBeNull();
    expect(parseCssColor("color-mix(in srgb, red 50%, transparent)")).toBeNull();
    expect(parseCssColor("rgb(1 2)")).toBeNull();
    expect(parseCssColor("#12")).toBeNull();
    expect(parseCssColor("hsl(210 50% 40%)")).toBeNull();
  });
});

describe("formatCssColor", () => {
  it("formats rgba with clamping and channel rounding", () => {
    expect(formatCssColor({ r: 59.4, g: 130, b: 246, a: 1 })).toBe("rgba(59, 130, 246, 1)");
    expect(formatCssColor({ r: 0, g: 0, b: 0, a: 1 }, 0.5)).toBe("rgba(0, 0, 0, 0.5)");
    expect(formatCssColor({ r: 0, g: 0, b: 0, a: 1 }, 7)).toBe("rgba(0, 0, 0, 1)");
    expect(formatCssColor({ r: 0, g: 0, b: 0, a: 1 }, -2)).toBe("rgba(0, 0, 0, 0)");
  });
});

describe("withAlpha", () => {
  it("overrides alpha and preserves hue", () => {
    expect(withAlpha({ r: 10, g: 20, b: 30, a: 1 }, 0.4)).toEqual({ r: 10, g: 20, b: 30, a: 0.4 });
  });
});

describe("formatCssColorVariants", () => {
  it("produces `steps` buckets from transparent to full alpha", () => {
    const variants = formatCssColorVariants({ r: 255, g: 0, b: 0, a: 1 });
    expect(variants).toHaveLength(STAR_MAP_ALPHA_STEPS);
    expect(variants[0]).toBe("rgba(255, 0, 0, 0)");
    expect(variants[STAR_MAP_ALPHA_STEPS - 1]).toBe("rgba(255, 0, 0, 1)");
  });
});

describe("alphaVariantIndex", () => {
  it("maps alpha onto buckets and clamps the extremes", () => {
    expect(alphaVariantIndex(0)).toBe(0);
    expect(alphaVariantIndex(1)).toBe(STAR_MAP_ALPHA_STEPS - 1);
    expect(alphaVariantIndex(0.5)).toBe(8);
    expect(alphaVariantIndex(-1)).toBe(0);
    expect(alphaVariantIndex(2)).toBe(STAR_MAP_ALPHA_STEPS - 1);
  });
});

describe("resolveStarMapTheme", () => {
  it("reads and parses every token through the reader", () => {
    const theme = resolveStarMapTheme((token) => {
      if (token === STAR_MAP_THEME_TOKENS.statusOpen) return "oklch(0.623 0.214 259.815)";
      if (token === STAR_MAP_THEME_TOKENS.background) return "#10141d";
      return "rgb(1 2 3)";
    });
    expect(theme.background).toEqual({ r: 16, g: 20, b: 29, a: 1 });
    expect(theme.status.open).toEqual({ r: 43, g: 127, b: 255, a: 1 });
    expect(theme.star).toEqual({ r: 1, g: 2, b: 3, a: 1 });
  });

  it("falls back per token, so one broken value degrades one color", () => {
    const theme = resolveStarMapTheme((token) =>
      token === STAR_MAP_THEME_TOKENS.statusResolved ? "not-a-color" : "",
    );
    expect(theme.status.resolved).toEqual(DEFAULT_STAR_MAP_THEME.status.resolved);
    expect(theme.background).toEqual(DEFAULT_STAR_MAP_THEME.background);
    expect(theme.status.open).toEqual(DEFAULT_STAR_MAP_THEME.status.open);
  });
});
