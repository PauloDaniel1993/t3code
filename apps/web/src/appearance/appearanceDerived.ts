import type { AppearanceThemeVariant, HexColor } from "@t3tools/contracts";

import { contrastRatio, hexToRgb } from "./appearanceContrast.ts";

export interface DerivedAppearanceTokens {
  readonly border: HexColor;
  readonly input: HexColor;
  readonly ring: HexColor;
  readonly primaryForeground: HexColor;
  readonly accent: HexColor;
  readonly accentForeground: HexColor;
  readonly secondaryForeground: HexColor;
  readonly mutedForeground: HexColor;
  readonly card: HexColor;
  readonly popover: HexColor;
  readonly chromeBackground: HexColor;
}

function toHexChannel(value: number): string {
  return Math.round(Math.max(0, Math.min(255, value)))
    .toString(16)
    .padStart(2, "0");
}

function mixHex(from: HexColor, to: HexColor, amount: number): HexColor {
  const start = hexToRgb(from);
  const end = hexToRgb(to);
  const weight = Math.max(0, Math.min(1, amount));
  return `#${toHexChannel(start.red + (end.red - start.red) * weight)}${toHexChannel(
    start.green + (end.green - start.green) * weight,
  )}${toHexChannel(start.blue + (end.blue - start.blue) * weight)}`;
}

export function chooseContrastingForeground(background: HexColor): HexColor {
  const white = "#ffffff";
  const nearBlack = "#111111";
  return contrastRatio(background, white) >= contrastRatio(background, nearBlack)
    ? white
    : nearBlack;
}

function readableNeutralForeground(
  variant: AppearanceThemeVariant,
  background = variant.muted,
): HexColor {
  if (contrastRatio(variant.foreground, background) >= 4.5) {
    return variant.foreground;
  }

  const contrastingForeground = chooseContrastingForeground(background);
  if (contrastRatio(contrastingForeground, background) >= 4.5) {
    return contrastingForeground;
  }

  return contrastRatio("#ffffff", background) >= 4.5 ? "#ffffff" : "#000000";
}

export function deriveVariantTokens(variant: AppearanceThemeVariant): DerivedAppearanceTokens {
  const strength = variant.contrast;
  const primaryForeground = chooseContrastingForeground(variant.accent);
  const neutralForeground = readableNeutralForeground(variant);
  // Match the baseline's 4% neutral hover tint instead of reusing the brand primary color.
  const accent = mixHex(variant.background, variant.foreground, 0.04);

  return {
    border: mixHex(variant.background, variant.foreground, 0.08 * strength),
    input: mixHex(variant.background, variant.foreground, 0.12 * strength),
    ring: variant.accent,
    primaryForeground,
    accent,
    accentForeground: readableNeutralForeground(variant, accent),
    secondaryForeground: neutralForeground,
    mutedForeground: neutralForeground,
    card: variant.surface,
    popover: variant.surface,
    chromeBackground: variant.translucentSidebar
      ? mixHex(variant.background, variant.surface, 0.5)
      : variant.background,
  };
}
