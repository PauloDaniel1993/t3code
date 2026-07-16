import type { AppearanceSettings, AppearanceThemeVariant } from "@t3tools/contracts";

import { deriveVariantTokens } from "./appearanceDerived.ts";
import {
  BUILT_IN_APPEARANCE_THEMES,
  resolveActiveAppearanceTheme,
  type ResolvedAppearanceTheme,
} from "./appearanceThemes.ts";

export type ResolvedAppearanceScheme = "light" | "dark";

const DENSITY_SCALE = {
  compact: "0.85",
  default: "1",
  comfortable: "1.2",
} as const;

export const APPEARANCE_MANAGED_SEMANTIC_PROPERTIES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--input",
  "--ring",
  "--app-chrome-background",
] as const;

function appPropertyValues(theme: ResolvedAppearanceTheme): Readonly<Record<string, string>> {
  return {
    "--app-ui-font-family": theme.uiFontFamily,
    "--app-mono-font-family": theme.monoFontFamily,
    "--app-terminal-font-family": theme.terminalFontFamily,
    "--app-ui-font-size": `${theme.uiFontSizePx}px`,
    "--app-chat-font-size": `${theme.chatFontSizePx}px`,
    "--app-code-font-size": `${theme.codeFontSizePx}px`,
    "--app-terminal-font-size": `${theme.terminalFontSizePx}px`,
    "--app-density-scale": DENSITY_SCALE[theme.density],
  };
}

/** Baseline values that index.css must bind for pre-React/default rendering. */
export const DEFAULT_APPEARANCE_APP_PROPERTY_VALUES = Object.freeze(
  appPropertyValues(BUILT_IN_APPEARANCE_THEMES.default),
);

function variantsAreEqual(
  candidate: AppearanceThemeVariant,
  baseline: AppearanceThemeVariant,
): boolean {
  return (
    candidate.accent === baseline.accent &&
    candidate.background === baseline.background &&
    candidate.foreground === baseline.foreground &&
    candidate.surface === baseline.surface &&
    candidate.muted === baseline.muted &&
    candidate.contrast === baseline.contrast &&
    candidate.translucentSidebar === baseline.translucentSidebar
  );
}

function isBaselineEquivalentTheme(theme: ResolvedAppearanceTheme): boolean {
  const baselineVariants = BUILT_IN_APPEARANCE_THEMES.default.variants;
  return (
    variantsAreEqual(theme.variants.light, baselineVariants.light) &&
    variantsAreEqual(theme.variants.dark, baselineVariants.dark)
  );
}

export function applyAppearanceToDocument(
  appearance: AppearanceSettings,
  resolvedScheme: ResolvedAppearanceScheme,
): void {
  if (typeof document === "undefined") {
    return;
  }

  const rootStyle = document.documentElement.style;
  const theme = resolveActiveAppearanceTheme(appearance);
  for (const [property, value] of Object.entries(appPropertyValues(theme))) {
    rootStyle.setProperty(property, value);
  }

  if (isBaselineEquivalentTheme(theme)) {
    for (const property of APPEARANCE_MANAGED_SEMANTIC_PROPERTIES) {
      rootStyle.removeProperty(property);
    }
    return;
  }

  const variant = theme.variants[resolvedScheme];
  const derived = deriveVariantTokens(variant);
  const semanticValues: Record<(typeof APPEARANCE_MANAGED_SEMANTIC_PROPERTIES)[number], string> = {
    "--background": variant.background,
    "--foreground": variant.foreground,
    "--card": derived.card,
    "--card-foreground": variant.foreground,
    "--popover": derived.popover,
    "--popover-foreground": variant.foreground,
    "--primary": variant.accent,
    "--primary-foreground": derived.primaryForeground,
    "--secondary": variant.muted,
    "--secondary-foreground": derived.secondaryForeground,
    "--muted": variant.muted,
    "--muted-foreground": derived.mutedForeground,
    "--accent": derived.accent,
    "--accent-foreground": derived.accentForeground,
    "--border": derived.border,
    "--input": derived.input,
    "--ring": variant.accent,
    "--app-chrome-background": derived.chromeBackground,
  };

  for (const property of APPEARANCE_MANAGED_SEMANTIC_PROPERTIES) {
    rootStyle.setProperty(property, semanticValues[property]);
  }
}
