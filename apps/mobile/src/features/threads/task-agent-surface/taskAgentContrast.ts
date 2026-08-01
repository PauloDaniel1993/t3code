export const WCAG_TEXT_CONTRAST_THRESHOLD = 4.5;

export interface RgbaColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha?: number;
}

export type ContrastColor = string | RgbaColor;

export interface EffectiveContrastInput {
  readonly foreground: ContrastColor;
  readonly background: ContrastColor;
  /** Opacity values from the text's nearest ancestor outward. */
  readonly opacities: readonly number[];
}

export interface OpacitySubtreeContrastInput {
  readonly foreground: ContrastColor;
  readonly surface: ContrastColor;
  readonly backdrop: ContrastColor;
  /** Opacity values from the subtree's nearest ancestor outward. */
  readonly opacities: readonly number[];
}

export interface RenderedOpacitySubtree {
  readonly foreground: RgbaColor;
  readonly surface: RgbaColor;
}

interface ParsedColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

function validateChannel(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 255) {
    throw new RangeError(`${name} must be a finite number between 0 and 255`);
  }

  return value;
}

function validateAlpha(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number between 0 and 1`);
  }

  return value;
}

function parseHexColor(value: string): ParsedColor {
  const hex = value.slice(1);

  if (![3, 4, 6, 8].includes(hex.length) || !/^[\da-f]+$/i.test(hex)) {
    throw new TypeError(`Unsupported hex color: ${value}`);
  }

  const expand = (component: string): string =>
    component.length === 1 ? component.repeat(2) : component;
  const componentLength = hex.length <= 4 ? 1 : 2;
  const red = Number.parseInt(expand(hex.slice(0, componentLength)), 16);
  const green = Number.parseInt(expand(hex.slice(componentLength, componentLength * 2)), 16);
  const blue = Number.parseInt(expand(hex.slice(componentLength * 2, componentLength * 3)), 16);
  const alphaComponent =
    hex.length === 4 || hex.length === 8 ? hex.slice(componentLength * 3) : null;

  return {
    red,
    green,
    blue,
    alpha: alphaComponent === null ? 1 : Number.parseInt(expand(alphaComponent), 16) / 255,
  };
}

function parseRgbComponent(value: string): number {
  const trimmed = value.trim();
  const isPercentage = trimmed.endsWith("%");
  const numeric = Number.parseFloat(isPercentage ? trimmed.slice(0, -1) : trimmed);

  if (!Number.isFinite(numeric)) {
    throw new TypeError(`Invalid RGB component: ${value}`);
  }

  return validateChannel(isPercentage ? (numeric / 100) * 255 : numeric, "RGB component");
}

function parseAlphaComponent(value: string): number {
  const trimmed = value.trim();
  const isPercentage = trimmed.endsWith("%");
  const numeric = Number.parseFloat(isPercentage ? trimmed.slice(0, -1) : trimmed);

  if (!Number.isFinite(numeric)) {
    throw new TypeError(`Invalid alpha component: ${value}`);
  }

  return validateAlpha(isPercentage ? numeric / 100 : numeric, "Alpha");
}

function parseRgbColor(value: string): ParsedColor {
  const match = /^rgba?\((.*)\)$/i.exec(value);
  if (match === null) {
    throw new TypeError(`Unsupported color: ${value}`);
  }

  const components = match[1]
    .replaceAll("/", " ")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (components.length !== 3 && components.length !== 4) {
    throw new TypeError(`RGB colors must have three channels and an optional alpha: ${value}`);
  }

  return {
    red: parseRgbComponent(components[0]),
    green: parseRgbComponent(components[1]),
    blue: parseRgbComponent(components[2]),
    alpha: components.length === 4 ? parseAlphaComponent(components[3]) : 1,
  };
}

function parseHslPercentage(value: string, name: string): number {
  const trimmed = value.trim();
  if (!trimmed.endsWith("%")) {
    throw new TypeError(`${name} must be a percentage: ${value}`);
  }

  const numeric = Number.parseFloat(trimmed.slice(0, -1));
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    throw new RangeError(`${name} must be a percentage between 0% and 100%`);
  }

  return numeric / 100;
}

function parseHslColor(value: string): ParsedColor {
  const match = /^hsla?\((.*)\)$/i.exec(value);
  if (match === null) {
    throw new TypeError(`Unsupported color: ${value}`);
  }

  const components = match[1]
    .replaceAll("/", " ")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (components.length !== 3 && components.length !== 4) {
    throw new TypeError(
      `HSL colors must have hue, saturation, lightness, and optional alpha: ${value}`,
    );
  }

  const hueValue = components[0].trim().toLowerCase();
  const hueDegrees = Number.parseFloat(hueValue.endsWith("deg") ? hueValue.slice(0, -3) : hueValue);
  if (!Number.isFinite(hueDegrees)) {
    throw new TypeError(`Invalid HSL hue: ${components[0]}`);
  }

  const hue = (((hueDegrees % 360) + 360) % 360) / 60;
  const saturation = parseHslPercentage(components[1], "HSL saturation");
  const lightness = parseHslPercentage(components[2], "HSL lightness");
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondComponent = chroma * (1 - Math.abs((hue % 2) - 1));
  const matchComponent = lightness - chroma / 2;

  let red = 0;
  let green = 0;
  let blue = 0;
  if (hue < 1) {
    red = chroma;
    green = secondComponent;
  } else if (hue < 2) {
    red = secondComponent;
    green = chroma;
  } else if (hue < 3) {
    green = chroma;
    blue = secondComponent;
  } else if (hue < 4) {
    green = secondComponent;
    blue = chroma;
  } else if (hue < 5) {
    red = secondComponent;
    blue = chroma;
  } else {
    red = chroma;
    blue = secondComponent;
  }

  return {
    red: (red + matchComponent) * 255,
    green: (green + matchComponent) * 255,
    blue: (blue + matchComponent) * 255,
    alpha: components.length === 4 ? parseAlphaComponent(components[3]) : 1,
  };
}

function parseColor(color: ContrastColor): ParsedColor {
  if (typeof color === "string") {
    const value = color.trim();
    if (value.startsWith("#")) {
      return parseHexColor(value);
    }

    if (/^hsla?\(/i.test(value)) {
      return parseHslColor(value);
    }

    return parseRgbColor(value);
  }

  return {
    red: validateChannel(color.red, "Red channel"),
    green: validateChannel(color.green, "Green channel"),
    blue: validateChannel(color.blue, "Blue channel"),
    alpha: validateAlpha(color.alpha ?? 1, "Alpha"),
  };
}

function requireOpaque(color: ParsedColor, name: string): void {
  if (color.alpha !== 1) {
    throw new RangeError(`${name} must be opaque when used for luminance or as a background`);
  }
}

function validateOpacity(opacity: number): number {
  return validateAlpha(opacity, "Ancestor opacity");
}

function ancestorOpacity(opacities: readonly number[]): number {
  return opacities.reduce((product, opacity) => product * validateOpacity(opacity), 1);
}

function compositeOver(foreground: ParsedColor, background: ParsedColor): ParsedColor {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  if (alpha === 0) {
    return { red: 0, green: 0, blue: 0, alpha: 0 };
  }

  return {
    red:
      (foreground.red * foreground.alpha +
        background.red * background.alpha * (1 - foreground.alpha)) /
      alpha,
    green:
      (foreground.green * foreground.alpha +
        background.green * background.alpha * (1 - foreground.alpha)) /
      alpha,
    blue:
      (foreground.blue * foreground.alpha +
        background.blue * background.alpha * (1 - foreground.alpha)) /
      alpha,
    alpha,
  };
}

function compositeAtOpacity(
  source: ParsedColor,
  backdrop: ParsedColor,
  opacity: number,
): RgbaColor {
  const effectiveAlpha = source.alpha * opacity;
  return {
    red: backdrop.red + (source.red - backdrop.red) * effectiveAlpha,
    green: backdrop.green + (source.green - backdrop.green) * effectiveAlpha,
    blue: backdrop.blue + (source.blue - backdrop.blue) * effectiveAlpha,
    alpha: 1,
  };
}

/** Converts an sRGB channel to its WCAG 2.x linear-light value. */
function linearizeSrgbChannel(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: ContrastColor): number {
  const parsed = parseColor(color);
  requireOpaque(parsed, "Color");

  return (
    0.2126 * linearizeSrgbChannel(parsed.red) +
    0.7152 * linearizeSrgbChannel(parsed.green) +
    0.0722 * linearizeSrgbChannel(parsed.blue)
  );
}

export function contrastRatio(first: ContrastColor, second: ContrastColor): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Models text alpha and ancestor opacity over an already-rendered opaque
 * surface. The opacity chain affects only the foreground pixel; use
 * effectiveOpacitySubtreeContrast when the surface itself is inside that
 * opacity-carrying subtree.
 */
export function compositeForeground(input: EffectiveContrastInput): RgbaColor {
  const foreground = parseColor(input.foreground);
  const background = parseColor(input.background);
  requireOpaque(background, "Background");

  const effectiveAlpha = foreground.alpha * ancestorOpacity(input.opacities);

  return {
    red: background.red + (foreground.red - background.red) * effectiveAlpha,
    green: background.green + (foreground.green - background.green) * effectiveAlpha,
    blue: background.blue + (foreground.blue - background.blue) * effectiveAlpha,
    alpha: 1,
  };
}

export function effectiveContrast(input: EffectiveContrastInput): number {
  return contrastRatio(compositeForeground(input), input.background);
}

/**
 * Models React Native View opacity on a subtree containing both text and its
 * own surface. The flattened text pixel and surface pixel are each composited
 * through the combined ancestor opacity over the opaque outer backdrop.
 */
export function compositeOpacitySubtree(
  input: OpacitySubtreeContrastInput,
): RenderedOpacitySubtree {
  const foreground = parseColor(input.foreground);
  const surface = parseColor(input.surface);
  const backdrop = parseColor(input.backdrop);
  requireOpaque(backdrop, "Backdrop");

  const opacity = ancestorOpacity(input.opacities);
  const foregroundOverSurface = compositeOver(foreground, surface);

  return {
    foreground: compositeAtOpacity(foregroundOverSurface, backdrop, opacity),
    surface: compositeAtOpacity(surface, backdrop, opacity),
  };
}

export function effectiveOpacitySubtreeContrast(input: OpacitySubtreeContrastInput): number {
  const rendered = compositeOpacitySubtree(input);
  return contrastRatio(rendered.foreground, rendered.surface);
}

function validateThreshold(threshold: number): number {
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new RangeError("Contrast threshold must be a finite non-negative number");
  }

  return threshold;
}

export function meetsTextContrast(
  input: EffectiveContrastInput,
  threshold = WCAG_TEXT_CONTRAST_THRESHOLD,
): boolean {
  return effectiveContrast(input) >= validateThreshold(threshold);
}

export function meetsOpacitySubtreeTextContrast(
  input: OpacitySubtreeContrastInput,
  threshold = WCAG_TEXT_CONTRAST_THRESHOLD,
): boolean {
  return effectiveOpacitySubtreeContrast(input) >= validateThreshold(threshold);
}

export function assertTextContrast(
  input: EffectiveContrastInput,
  threshold = WCAG_TEXT_CONTRAST_THRESHOLD,
): void {
  const checkedThreshold = validateThreshold(threshold);
  const ratio = effectiveContrast(input);

  if (ratio < checkedThreshold) {
    throw new Error(
      `Effective text contrast is ${ratio.toFixed(4)}:1; expected at least ${checkedThreshold}:1`,
    );
  }
}

export function assertOpacitySubtreeTextContrast(
  input: OpacitySubtreeContrastInput,
  threshold = WCAG_TEXT_CONTRAST_THRESHOLD,
): void {
  const checkedThreshold = validateThreshold(threshold);
  const ratio = effectiveOpacitySubtreeContrast(input);

  if (ratio < checkedThreshold) {
    throw new Error(
      `Effective opacity-subtree text contrast is ${ratio.toFixed(4)}:1; expected at least ${checkedThreshold}:1`,
    );
  }
}
