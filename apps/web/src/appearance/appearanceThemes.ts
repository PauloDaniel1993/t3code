import {
  BUILT_IN_APPEARANCE_THEME_IDS,
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_TERMINAL_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  type AppearanceBuiltInThemeId,
  type AppearanceSettings,
  type AppearanceTheme,
  type AppearanceThemeVariant,
} from "@t3tools/contracts";

export type AppearanceThemeDefinition = Omit<AppearanceTheme, "id"> & {
  readonly id: string;
};

export type ResolvedAppearanceTheme = AppearanceTheme | AppearanceThemeDefinition;

const LIGHT_VARIANT: AppearanceThemeVariant = {
  accent: "#1b4ed8",
  background: "#ffffff",
  foreground: "#262626",
  surface: "#ffffff",
  muted: "#f5f5f5",
  contrast: 1,
  translucentSidebar: false,
};

const DARK_VARIANT: AppearanceThemeVariant = {
  accent: "#366ffb",
  background: "#161616",
  foreground: "#f5f5f5",
  surface: "#1b1b1b",
  muted: "#1f1f1f",
  contrast: 1,
  translucentSidebar: false,
};

function freezeVariant(variant: AppearanceThemeVariant): AppearanceThemeVariant {
  return Object.freeze({ ...variant });
}

function freezeTheme(theme: AppearanceThemeDefinition): AppearanceThemeDefinition {
  return Object.freeze({
    ...theme,
    variants: Object.freeze({
      light: freezeVariant(theme.variants.light),
      dark: freezeVariant(theme.variants.dark),
    }),
  });
}

const DEFAULT_THEME = freezeTheme({
  id: "default",
  name: "Default",
  uiFontFamily: DEFAULT_UI_FONT_STACK,
  monoFontFamily: DEFAULT_MONO_FONT_STACK,
  terminalFontFamily: DEFAULT_TERMINAL_FONT_STACK,
  uiFontSizePx: 14,
  chatFontSizePx: 14,
  codeFontSizePx: 12,
  terminalFontSizePx: 12,
  density: "default",
  diffMarkerStyle: "color",
  variants: { light: LIGHT_VARIANT, dark: DARK_VARIANT },
});

export const BUILT_IN_APPEARANCE_THEMES: Readonly<
  Record<AppearanceBuiltInThemeId, AppearanceThemeDefinition>
> = Object.freeze({
  default: DEFAULT_THEME,
  readable: freezeTheme({
    ...DEFAULT_THEME,
    id: "readable",
    name: "Readable",
    uiFontFamily: `"Atkinson Hyperlegible", ${DEFAULT_UI_FONT_STACK}`,
    uiFontSizePx: 16,
    chatFontSizePx: 16,
    density: "comfortable",
  }),
  compact: freezeTheme({
    ...DEFAULT_THEME,
    id: "compact",
    name: "Compact",
    uiFontSizePx: 13,
    chatFontSizePx: 13,
    density: "compact",
  }),
  terminal: freezeTheme({
    ...DEFAULT_THEME,
    id: "terminal",
    name: "Terminal",
    codeFontSizePx: 13,
    terminalFontSizePx: 13,
  }),
});

export function collidesWithBuiltInId(id: string): boolean {
  const normalized = id.toLowerCase();
  return BUILT_IN_APPEARANCE_THEME_IDS.some((builtInId) => builtInId === normalized);
}

export function isBuiltInThemeId(id: string): id is AppearanceBuiltInThemeId {
  return BUILT_IN_APPEARANCE_THEME_IDS.some((builtInId) => builtInId === id);
}

export function resolveActiveAppearanceTheme(
  appearance: AppearanceSettings,
): ResolvedAppearanceTheme {
  if (isBuiltInThemeId(appearance.activeThemeId)) {
    return BUILT_IN_APPEARANCE_THEMES[appearance.activeThemeId];
  }
  return appearance.customThemes[appearance.activeThemeId] ?? BUILT_IN_APPEARANCE_THEMES.default;
}
