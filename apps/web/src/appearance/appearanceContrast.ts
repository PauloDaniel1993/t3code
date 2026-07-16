import type { HexColor } from "@t3tools/contracts";

export interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function hexToRgb(hex: string): RgbColor {
  if (!HEX_COLOR_PATTERN.test(hex)) {
    throw new Error(`Invalid hex color "${hex}"; expected #RRGGBB.`);
  }

  return {
    red: Number.parseInt(hex.slice(1, 3), 16),
    green: Number.parseInt(hex.slice(3, 5), 16),
    blue: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function linearizeSrgb(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: HexColor | string): number {
  const { red, green, blue } = hexToRgb(hex);
  return 0.2126 * linearizeSrgb(red) + 0.7152 * linearizeSrgb(green) + 0.0722 * linearizeSrgb(blue);
}

export function contrastRatio(hexA: HexColor | string, hexB: HexColor | string): number {
  const luminanceA = relativeLuminance(hexA);
  const luminanceB = relativeLuminance(hexB);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}
