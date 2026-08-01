import type { StarMapNodeStatus } from "./starMapGraph";

/**
 * Theme tokens for the star map canvas (design decision 15). The starfield is
 * intrinsically dark, so the panel scopes its own `[data-star-map]` token block
 * in `index.css` with light and dark variants — the same technique as
 * `[data-sidebar-version]`. The engine reads those tokens ONCE per theme change
 * through `resolveStarMapTheme`; nothing here is called per frame.
 *
 * Status hues bind to `--success` / `--warning` / `--info` / `--destructive`
 * because `APPEARANCE_MANAGED_SEMANTIC_PROPERTIES`
 * (`apps/web/src/appearance/applyAppearance.ts:18-37`) does not manage them:
 * they are theme-invariant, so a user's custom appearance theme cannot turn
 * the status palette into mush.
 *
 * Everything in this module is pure and DOM-free so it runs under the Node
 * test harness. The canvas element only ever sees pre-parsed colors.
 */

/** One parsed color: channels 0-255, alpha 0-1. */
export interface StarMapColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function color(r: number, g: number, b: number, a = 1): StarMapColor {
  return { r, g, b, a };
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function clampChannel(value: number): number {
  return Math.min(Math.max(Math.round(value), 0), 255);
}

/** Overrides the alpha channel, preserving the hue. */
export function withAlpha(input: StarMapColor, alpha: number): StarMapColor {
  return { ...input, a: clamp01(alpha) };
}

/** Formats a parsed color for canvas fill/stroke styles. */
export function formatCssColor(input: StarMapColor, alphaOverride?: number): string {
  const alpha = alphaOverride === undefined ? input.a : clamp01(alphaOverride);
  return `rgba(${clampChannel(input.r)}, ${clampChannel(input.g)}, ${clampChannel(input.b)}, ${alpha})`;
}

/** Number of pre-formatted alpha buckets `formatCssColorVariants` produces. */
export const STAR_MAP_ALPHA_STEPS = 16;

/**
 * Pre-formats `steps` alpha buckets of a color at theme-refresh time, so the
 * render loop never allocates a style string per particle or pulse ring.
 */
export function formatCssColorVariants(
  input: StarMapColor,
  steps: number = STAR_MAP_ALPHA_STEPS,
): ReadonlyArray<string> {
  const variants: Array<string> = [];
  for (let index = 0; index < steps; index += 1) {
    variants.push(formatCssColor(input, (input.a * index) / (steps - 1)));
  }
  return variants;
}

/** Picks the nearest bucket from `formatCssColorVariants` for a live alpha. */
export function alphaVariantIndex(alpha: number, steps: number = STAR_MAP_ALPHA_STEPS): number {
  return Math.min(Math.max(Math.round(clamp01(alpha) * (steps - 1)), 0), steps - 1);
}

function parseChannel(token: string): number | null {
  if (token.endsWith("%")) {
    const percent = Number(token.slice(0, -1));
    return Number.isFinite(percent) ? (percent / 100) * 255 : null;
  }
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

function parseAlpha(token: string | undefined): number | null {
  if (token === undefined) return 1;
  if (token.endsWith("%")) {
    const percent = Number(token.slice(0, -1));
    return Number.isFinite(percent) ? clamp01(percent / 100) : null;
  }
  const value = Number(token);
  return Number.isFinite(value) ? clamp01(value) : null;
}

/** Splits a function body on commas and/or whitespace, keeping `/ alpha`. */
function splitColorArgs(inner: string): ReadonlyArray<string> {
  return inner
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter((part) => part.length > 0);
}

function parseHex(text: string): StarMapColor | null {
  const digits = text.slice(1);
  const expand = (hex: string) => Number.parseInt(hex, 16);
  if (/^[0-9a-f]{3}$/i.test(digits) || /^[0-9a-f]{4}$/i.test(digits)) {
    const chars = [...digits].map((digit) => digit + digit);
    return color(
      expand(chars[0]!),
      expand(chars[1]!),
      expand(chars[2]!),
      chars.length === 4 ? expand(chars[3]!) / 255 : 1,
    );
  }
  if (/^[0-9a-f]{6}$/i.test(digits) || /^[0-9a-f]{8}$/i.test(digits)) {
    return color(
      expand(digits.slice(0, 2)),
      expand(digits.slice(2, 4)),
      expand(digits.slice(4, 6)),
      digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1,
    );
  }
  return null;
}

function parseRgb(inner: string): StarMapColor | null {
  const [channelsToken, alphaToken] = inner.split("/").map((part) => part.trim());
  const parts = splitColorArgs(channelsToken ?? "");
  let channels = parts;
  let alpha = parseAlpha(alphaToken);
  // Legacy comma rgba() carries the alpha as a fourth channel, no slash.
  if (alphaToken === undefined && parts.length === 4) {
    channels = parts.slice(0, 3);
    alpha = parseAlpha(parts[3]);
  }
  if (channels.length !== 3) return null;
  const r = parseChannel(channels[0]!);
  const g = parseChannel(channels[1]!);
  const b = parseChannel(channels[2]!);
  if (r === null || g === null || b === null || alpha === null) return null;
  return color(clampChannel(r), clampChannel(g), clampChannel(b), alpha);
}

/** OKLab/OKLCH → linear sRGB matrix (Björn Ottosson's published constants). */
function oklchToSrgb(lightness: number, chroma: number, hueDegrees: number): StarMapColor {
  const hue = (hueDegrees * Math.PI) / 180;
  const aAxis = chroma * Math.cos(hue);
  const bAxis = chroma * Math.sin(hue);
  const lPrime = lightness + 0.3963377774 * aAxis + 0.2158037573 * bAxis;
  const mPrime = lightness - 0.1055613458 * aAxis - 0.0638541728 * bAxis;
  const sPrime = lightness - 0.0894841775 * aAxis - 1.291485548 * bAxis;
  const lCubed = lPrime ** 3;
  const mCubed = mPrime ** 3;
  const sCubed = sPrime ** 3;
  const linearR = +4.0767416621 * lCubed - 3.3077115913 * mCubed + 0.2309699292 * sCubed;
  const linearG = -1.2684380046 * lCubed + 2.6097574011 * mCubed - 0.3413193965 * sCubed;
  const linearB = -0.0041960863 * lCubed - 0.7034186147 * mCubed + 1.707614701 * sCubed;
  const encode = (channel: number) =>
    channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
  return color(
    clampChannel(encode(linearR) * 255),
    clampChannel(encode(linearG) * 255),
    clampChannel(encode(linearB) * 255),
  );
}

function parseOklch(inner: string): StarMapColor | null {
  const [componentsToken, alphaToken] = inner.split("/").map((part) => part.trim());
  const components = splitColorArgs(componentsToken ?? "");
  if (components.length !== 3) return null;
  const lightnessToken = components[0]!;
  let lightness: number;
  if (lightnessToken.endsWith("%")) {
    lightness = Number(lightnessToken.slice(0, -1)) / 100;
  } else {
    lightness = Number(lightnessToken);
  }
  const chroma = Number(components[1]);
  // "none" is valid for a powerless hue (chroma 0); the angle is irrelevant then.
  const hueToken = components[2]!.replace(/deg$/, "");
  const hue = hueToken === "none" ? 0 : Number(hueToken);
  const alpha = parseAlpha(alphaToken);
  if (
    !Number.isFinite(lightness) ||
    !Number.isFinite(chroma) ||
    !Number.isFinite(hue) ||
    alpha === null
  ) {
    return null;
  }
  const parsed = oklchToSrgb(clamp01(lightness), Math.max(chroma, 0), hue);
  return { ...parsed, a: alpha };
}

/**
 * Parses the color formats the `[data-star-map]` tokens can resolve to after
 * `var()` substitution: `#hex`, `rgb()/rgba()` (comma or space/slash syntax),
 * and `oklch()` (the Tailwind v4 palette format). Returns null for anything
 * else so the caller can fall back to the default theme per token.
 */
export function parseCssColor(raw: string): StarMapColor | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  if (text.startsWith("#")) return parseHex(text);
  const open = text.indexOf("(");
  if (open === -1 || !text.endsWith(")")) return null;
  const fn = text.slice(0, open).toLowerCase();
  const inner = text.slice(open + 1, -1).trim();
  if (fn === "rgb" || fn === "rgba") return parseRgb(inner);
  if (fn === "oklch") return parseOklch(inner);
  return null;
}

/**
 * The parsed token set the renderer consumes. `edgeSatisfied` and `undermine`
 * are deliberately NOT tokens: the engine derives them from the status hues
 * (`resolved` for satisfied blockers, `out_of_scope` for undermines edges), so
 * the CSS block has fewer knobs and the two palettes can never drift apart.
 */
export interface StarMapTheme {
  readonly background: StarMapColor;
  readonly star: StarMapColor;
  readonly starfieldFar: StarMapColor;
  readonly starfieldNear: StarMapColor;
  readonly edge: StarMapColor;
  readonly label: StarMapColor;
  readonly selection: StarMapColor;
  readonly status: Readonly<Record<StarMapNodeStatus, StarMapColor>>;
}

/** Token custom-property names, mirrored by the `[data-star-map]` CSS block. */
export const STAR_MAP_THEME_TOKENS = {
  background: "--star-map-background",
  star: "--star-map-star",
  starfieldFar: "--star-map-starfield-far",
  starfieldNear: "--star-map-starfield-near",
  edge: "--star-map-edge",
  label: "--star-map-label",
  selection: "--star-map-selection",
  statusOpen: "--star-map-status-open",
  statusClaimed: "--star-map-status-claimed",
  statusResolved: "--star-map-status-resolved",
  statusOutOfScope: "--star-map-status-out-of-scope",
} as const;

/**
 * Fallback theme used for any token that is missing or unparseable, and as the
 * whole theme when the engine runs without DOM token reads. Values mirror the
 * light-variant `[data-star-map]` block in `index.css`; keep them in sync.
 */
export const DEFAULT_STAR_MAP_THEME: StarMapTheme = {
  background: color(16, 20, 29),
  star: color(238, 242, 249),
  starfieldFar: color(168, 180, 205, 0.45),
  starfieldNear: color(214, 224, 240, 0.7),
  edge: color(148, 163, 184, 0.38),
  label: color(226, 232, 240, 0.9),
  selection: color(143, 179, 255),
  status: {
    // Fallback hues are the sRGB resolution of the Tailwind v4 500-scale
    // oklch values that --success / --warning / --info / --destructive bind
    // to (v4 is more vivid than v3 hex, and blue/amber clamp out of gamut).
    open: color(43, 127, 255),
    claimed: color(254, 154, 0),
    resolved: color(0, 188, 125),
    out_of_scope: color(251, 44, 54),
  },
};

/**
 * Reads every token once through `readToken` (typically a bound
 * `getComputedStyle(el).getPropertyValue`) and parses it. Each token falls
 * back to `DEFAULT_STAR_MAP_THEME` independently, so one broken custom theme
 * degrades one color instead of failing the whole read.
 */
export function resolveStarMapTheme(readToken: (token: string) => string): StarMapTheme {
  const read = (token: string, fallback: StarMapColor): StarMapColor =>
    parseCssColor(readToken(token)) ?? fallback;
  const defaults = DEFAULT_STAR_MAP_THEME;
  return {
    background: read(STAR_MAP_THEME_TOKENS.background, defaults.background),
    star: read(STAR_MAP_THEME_TOKENS.star, defaults.star),
    starfieldFar: read(STAR_MAP_THEME_TOKENS.starfieldFar, defaults.starfieldFar),
    starfieldNear: read(STAR_MAP_THEME_TOKENS.starfieldNear, defaults.starfieldNear),
    edge: read(STAR_MAP_THEME_TOKENS.edge, defaults.edge),
    label: read(STAR_MAP_THEME_TOKENS.label, defaults.label),
    selection: read(STAR_MAP_THEME_TOKENS.selection, defaults.selection),
    status: {
      open: read(STAR_MAP_THEME_TOKENS.statusOpen, defaults.status.open),
      claimed: read(STAR_MAP_THEME_TOKENS.statusClaimed, defaults.status.claimed),
      resolved: read(STAR_MAP_THEME_TOKENS.statusResolved, defaults.status.resolved),
      out_of_scope: read(STAR_MAP_THEME_TOKENS.statusOutOfScope, defaults.status.out_of_scope),
    },
  };
}
