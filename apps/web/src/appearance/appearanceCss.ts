import type { AppearanceSettings } from "@t3tools/contracts/settings";
import {
  derivePrimaryForeground,
  resolveAppearanceTheme,
  type AppearanceVariantKey,
} from "./appearanceThemes";

type AppearanceCssVariables = Record<string, string>;

const APP_APPEARANCE_VARIABLES = [
  "--app-ui-font-family",
  "--app-mono-font-family",
  "--app-terminal-font-family",
  "--app-ui-font-size",
  "--app-chat-font-size",
  "--app-code-font-size",
  "--app-terminal-font-size",
  "--app-density-scale",
  "--app-density-gap",
  "--app-density-padding-y",
];

const CORE_APPEARANCE_VARIABLES = [
  "--background",
  "--app-chrome-background",
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
];

export const MANAGED_APPEARANCE_CSS_VARIABLES = [
  ...APP_APPEARANCE_VARIABLES,
  ...CORE_APPEARANCE_VARIABLES,
] as const;

function densityVariables(density: "compact" | "default" | "comfortable"): AppearanceCssVariables {
  switch (density) {
    case "compact":
      return {
        "--app-density-scale": "0.875",
        "--app-density-gap": "0.375rem",
        "--app-density-padding-y": "0.375rem",
      };
    case "comfortable":
      return {
        "--app-density-scale": "1.125",
        "--app-density-gap": "0.625rem",
        "--app-density-padding-y": "0.625rem",
      };
    case "default":
      return {
        "--app-density-scale": "1",
        "--app-density-gap": "0.5rem",
        "--app-density-padding-y": "0.5rem",
      };
  }
}

function readableMix(color: string, background: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, ${background})`;
}

export function createAppearanceCssVariables(
  appearance: AppearanceSettings,
  resolvedTheme: AppearanceVariantKey,
): {
  readonly variables: AppearanceCssVariables;
  readonly appliesCoreColors: boolean;
  readonly activeThemeId: string;
} {
  const resolved = resolveAppearanceTheme(appearance);
  const theme = resolved.theme;
  const variant = theme.variants[resolvedTheme];
  const appliesCoreColors = !(resolved.isBuiltIn && theme.id === "default");
  const variables: AppearanceCssVariables = {
    "--app-ui-font-family": theme.uiFontFamily,
    "--app-mono-font-family": theme.monoFontFamily,
    "--app-terminal-font-family": theme.terminalFontFamily,
    "--app-ui-font-size": `${theme.uiFontSizePx}px`,
    "--app-chat-font-size": `${theme.chatFontSizePx}px`,
    "--app-code-font-size": `${theme.codeFontSizePx}px`,
    "--app-terminal-font-size": `${theme.terminalFontSizePx}px`,
    ...densityVariables(theme.density),
  };

  if (appliesCoreColors) {
    const primaryForeground = derivePrimaryForeground(variant.accent);
    variables["--background"] = variant.background;
    variables["--app-chrome-background"] = variant.background;
    variables["--foreground"] = variant.foreground;
    variables["--card"] = variant.surface;
    variables["--card-foreground"] = variant.foreground;
    variables["--popover"] = variant.surface;
    variables["--popover-foreground"] = variant.foreground;
    variables["--primary"] = variant.accent;
    variables["--primary-foreground"] = primaryForeground;
    variables["--secondary"] = variant.muted;
    variables["--secondary-foreground"] = variant.foreground;
    variables["--muted"] = variant.muted;
    variables["--muted-foreground"] = readableMix(variant.foreground, variant.background, 72);
    variables["--accent"] = readableMix(variant.foreground, "transparent", 4);
    variables["--accent-foreground"] = variant.foreground;
    variables["--border"] = readableMix(variant.foreground, "transparent", 12);
    variables["--input"] = readableMix(variant.foreground, "transparent", 16);
    variables["--ring"] = variant.accent;
  }

  return {
    variables,
    appliesCoreColors,
    activeThemeId: theme.id,
  };
}

export function applyAppearanceCssVariables(
  root: HTMLElement,
  appearance: AppearanceSettings,
  resolvedTheme: AppearanceVariantKey,
): void {
  const { variables, appliesCoreColors, activeThemeId } = createAppearanceCssVariables(
    appearance,
    resolvedTheme,
  );
  const variablesToClear = appliesCoreColors
    ? APP_APPEARANCE_VARIABLES
    : MANAGED_APPEARANCE_CSS_VARIABLES;

  for (const variableName of variablesToClear) {
    root.style.removeProperty(variableName);
  }
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }

  root.dataset.appearanceTheme = activeThemeId;
  root.dataset.appearanceCoreColors = appliesCoreColors ? "custom" : "default";
}
