import * as Schema from "effect/Schema";
import {
  APPEARANCE_BUILT_IN_THEME_IDS,
  AppearanceTheme,
  DEFAULT_APPEARANCE_ACTIVE_THEME_ID,
  DEFAULT_APPEARANCE_CHAT_FONT_SIZE_PX,
  DEFAULT_APPEARANCE_CODE_FONT_SIZE_PX,
  DEFAULT_APPEARANCE_DENSITY,
  DEFAULT_APPEARANCE_DIFF_MARKER_STYLE,
  DEFAULT_APPEARANCE_MONO_FONT_FAMILY,
  DEFAULT_APPEARANCE_TERMINAL_FONT_SIZE_PX,
  DEFAULT_APPEARANCE_UI_FONT_FAMILY,
  DEFAULT_APPEARANCE_UI_FONT_SIZE_PX,
  DEFAULT_TERMINAL_FONT_FAMILY,
  HexColor,
  READABLE_APPEARANCE_UI_FONT_FAMILY,
  type AppearanceBuiltInThemeId,
  type AppearanceColorScheme,
  type AppearanceSettings,
  type AppearanceThemeId,
  type AppearanceThemeVariant,
} from "@t3tools/contracts/settings";

export type AppearanceVariantKey = keyof AppearanceTheme["variants"];
export type AppearanceThemeSource = "built-in" | "custom";

export interface ResolvedAppearanceTheme {
  readonly theme: AppearanceTheme;
  readonly source: AppearanceThemeSource;
  readonly isBuiltIn: boolean;
}

export interface AppearanceThemeEntry extends ResolvedAppearanceTheme {
  readonly id: AppearanceThemeId;
}

export type AppearanceThemeTopLevelField =
  | "uiFontFamily"
  | "monoFontFamily"
  | "terminalFontFamily"
  | "uiFontSizePx"
  | "chatFontSizePx"
  | "codeFontSizePx"
  | "terminalFontSizePx"
  | "density"
  | "diffMarkerStyle";

export type AppearanceThemeVariantField = keyof AppearanceThemeVariant;

export type AppearanceThemeFieldPath =
  | {
      readonly kind: "topLevel";
      readonly field: AppearanceThemeTopLevelField;
    }
  | {
      readonly kind: "variant";
      readonly variant: AppearanceVariantKey;
      readonly field: AppearanceThemeVariantField;
    };

export interface AppearanceValidationResult {
  readonly isValid: boolean;
  readonly error: string | null;
}

export const MINIMUM_APPEARANCE_CONTRAST_RATIO = 4.5;

const decodeAppearanceTheme = Schema.decodeUnknownSync(AppearanceTheme);
const isHexColor = Schema.is(HexColor);
const BUILT_IN_THEME_ID_SET = new Set<string>(APPEARANCE_BUILT_IN_THEME_IDS);

const defaultLightVariant: AppearanceThemeVariant = {
  accent: "#4F46E5",
  background: "#FFFFFF",
  foreground: "#262626",
  surface: "#FFFFFF",
  muted: "#F5F5F5",
  contrast: 45,
  translucentSidebar: true,
};

const defaultDarkVariant: AppearanceThemeVariant = {
  accent: "#6366F1",
  background: "#181818",
  foreground: "#F5F5F5",
  surface: "#1A1A1A",
  muted: "#262626",
  contrast: 60,
  translucentSidebar: true,
};

export const BUILT_IN_APPEARANCE_THEMES: Record<AppearanceBuiltInThemeId, AppearanceTheme> = {
  default: decodeAppearanceTheme({
    id: "default",
    name: "Default",
    uiFontFamily: DEFAULT_APPEARANCE_UI_FONT_FAMILY,
    monoFontFamily: DEFAULT_APPEARANCE_MONO_FONT_FAMILY,
    terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    uiFontSizePx: DEFAULT_APPEARANCE_UI_FONT_SIZE_PX,
    chatFontSizePx: DEFAULT_APPEARANCE_CHAT_FONT_SIZE_PX,
    codeFontSizePx: DEFAULT_APPEARANCE_CODE_FONT_SIZE_PX,
    terminalFontSizePx: DEFAULT_APPEARANCE_TERMINAL_FONT_SIZE_PX,
    density: DEFAULT_APPEARANCE_DENSITY,
    diffMarkerStyle: DEFAULT_APPEARANCE_DIFF_MARKER_STYLE,
    variants: {
      light: defaultLightVariant,
      dark: defaultDarkVariant,
    },
  }),
  readable: decodeAppearanceTheme({
    id: "readable",
    name: "Readable",
    uiFontFamily: READABLE_APPEARANCE_UI_FONT_FAMILY,
    monoFontFamily: DEFAULT_APPEARANCE_MONO_FONT_FAMILY,
    terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    uiFontSizePx: 16,
    chatFontSizePx: 17,
    codeFontSizePx: 14,
    terminalFontSizePx: 14,
    density: "comfortable",
    diffMarkerStyle: "color-and-markers",
    variants: {
      light: {
        accent: "#2563EB",
        background: "#FFFFFF",
        foreground: "#111827",
        surface: "#F8FAFC",
        muted: "#E2E8F0",
        contrast: 72,
        translucentSidebar: false,
      },
      dark: {
        accent: "#60A5FA",
        background: "#0B1020",
        foreground: "#F8FAFC",
        surface: "#111827",
        muted: "#1F2937",
        contrast: 78,
        translucentSidebar: false,
      },
    },
  }),
  compact: decodeAppearanceTheme({
    id: "compact",
    name: "Compact",
    uiFontFamily: DEFAULT_APPEARANCE_UI_FONT_FAMILY,
    monoFontFamily: DEFAULT_APPEARANCE_MONO_FONT_FAMILY,
    terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    uiFontSizePx: 13,
    chatFontSizePx: 13,
    codeFontSizePx: 11,
    terminalFontSizePx: 11,
    density: "compact",
    diffMarkerStyle: "color",
    variants: {
      light: {
        accent: "#4F46E5",
        background: "#FFFFFF",
        foreground: "#262626",
        surface: "#FAFAFA",
        muted: "#F5F5F5",
        contrast: 42,
        translucentSidebar: true,
      },
      dark: {
        accent: "#6366F1",
        background: "#181818",
        foreground: "#F5F5F5",
        surface: "#1A1A1A",
        muted: "#262626",
        contrast: 58,
        translucentSidebar: true,
      },
    },
  }),
  terminal: decodeAppearanceTheme({
    id: "terminal",
    name: "Terminal",
    uiFontFamily: DEFAULT_APPEARANCE_UI_FONT_FAMILY,
    monoFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    uiFontSizePx: 14,
    chatFontSizePx: 14,
    codeFontSizePx: 13,
    terminalFontSizePx: 14,
    density: "default",
    diffMarkerStyle: "color-and-markers",
    variants: {
      light: {
        accent: "#15803D",
        background: "#F8FAFC",
        foreground: "#111827",
        surface: "#FFFFFF",
        muted: "#E5E7EB",
        contrast: 64,
        translucentSidebar: false,
      },
      dark: {
        accent: "#22C55E",
        background: "#101010",
        foreground: "#E5E7EB",
        surface: "#171717",
        muted: "#27272A",
        contrast: 74,
        translucentSidebar: false,
      },
    },
  }),
};

export function isBuiltInAppearanceThemeId(id: string): id is AppearanceBuiltInThemeId {
  return BUILT_IN_THEME_ID_SET.has(id);
}

export function cloneAppearanceTheme(theme: AppearanceTheme): AppearanceTheme {
  return {
    ...theme,
    variants: {
      light: { ...theme.variants.light },
      dark: { ...theme.variants.dark },
    },
  };
}

export function resolveAppearanceTheme(
  appearance: AppearanceSettings,
  themeId: AppearanceThemeId = appearance.activeThemeId,
): ResolvedAppearanceTheme {
  if (isBuiltInAppearanceThemeId(themeId)) {
    return {
      theme: BUILT_IN_APPEARANCE_THEMES[themeId],
      source: "built-in",
      isBuiltIn: true,
    };
  }

  const customTheme = appearance.customThemes[themeId];
  if (customTheme) {
    return {
      theme: customTheme,
      source: "custom",
      isBuiltIn: false,
    };
  }

  return {
    theme: BUILT_IN_APPEARANCE_THEMES.default,
    source: "built-in",
    isBuiltIn: true,
  };
}

export function listAppearanceThemes(appearance: AppearanceSettings): AppearanceThemeEntry[] {
  const builtInEntries: AppearanceThemeEntry[] = APPEARANCE_BUILT_IN_THEME_IDS.map((id) => ({
    id,
    theme: BUILT_IN_APPEARANCE_THEMES[id],
    source: "built-in",
    isBuiltIn: true,
  }));
  const customEntries: AppearanceThemeEntry[] = [];

  for (const id of appearance.customThemeOrder) {
    const theme = appearance.customThemes[id];
    if (!theme) {
      continue;
    }
    customEntries.push({
      id,
      theme,
      source: "custom",
      isBuiltIn: false,
    });
  }

  return [...builtInEntries, ...customEntries];
}

function createSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "theme";
}

export function createCustomAppearanceThemeId(
  name: string,
  existingIds: Iterable<string>,
): AppearanceThemeId {
  const usedIds = new Set(existingIds);
  const baseId = `custom_${createSlug(name)}`;
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id) || isBuiltInAppearanceThemeId(id)) {
    id = `${baseId}_${suffix}`;
    suffix += 1;
  }
  return id;
}

function createCopyName(sourceName: string, existingNames: Iterable<string>): string {
  const usedNames = new Set([...existingNames].map((name) => name.trim().toLowerCase()));
  const baseName = `${sourceName} copy`;
  if (!usedNames.has(baseName.toLowerCase())) {
    return baseName;
  }

  let suffix = 2;
  while (usedNames.has(`${baseName} ${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${baseName} ${suffix}`;
}

function getKnownThemeIds(appearance: AppearanceSettings): string[] {
  return [...APPEARANCE_BUILT_IN_THEME_IDS, ...Object.keys(appearance.customThemes)];
}

function getKnownThemeNames(appearance: AppearanceSettings): string[] {
  return [
    ...APPEARANCE_BUILT_IN_THEME_IDS.map((id) => BUILT_IN_APPEARANCE_THEMES[id].name),
    ...Object.values(appearance.customThemes).map((theme) => theme.name),
  ];
}

export function duplicateAppearanceTheme(
  appearance: AppearanceSettings,
  sourceThemeId: AppearanceThemeId = appearance.activeThemeId,
  options: {
    readonly id?: AppearanceThemeId;
    readonly name?: string;
  } = {},
): AppearanceSettings {
  const source = resolveAppearanceTheme(appearance, sourceThemeId).theme;
  const name = (options.name ?? createCopyName(source.name, getKnownThemeNames(appearance))).trim();
  if (!name) {
    throw new Error("Theme name must not be empty.");
  }

  const id = options.id ?? createCustomAppearanceThemeId(name, getKnownThemeIds(appearance));
  if (isBuiltInAppearanceThemeId(id) || appearance.customThemes[id] !== undefined) {
    throw new Error("Theme id must be unique and custom.");
  }

  const theme = decodeAppearanceTheme({
    ...cloneAppearanceTheme(source),
    id,
    name,
  });
  validateAppearanceThemeOrThrow(theme);

  return {
    ...appearance,
    activeThemeId: id,
    customThemeOrder: [...appearance.customThemeOrder, id],
    customThemes: {
      ...appearance.customThemes,
      [id]: theme,
    },
  };
}

export function renameCustomAppearanceTheme(
  appearance: AppearanceSettings,
  themeId: AppearanceThemeId,
  name: string,
): AppearanceSettings {
  const theme = appearance.customThemes[themeId];
  if (!theme) {
    return appearance;
  }

  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error("Theme name must not be empty.");
  }

  return {
    ...appearance,
    customThemes: {
      ...appearance.customThemes,
      [themeId]: decodeAppearanceTheme({
        ...cloneAppearanceTheme(theme),
        name: normalizedName,
      }),
    },
  };
}

export function deleteCustomAppearanceTheme(
  appearance: AppearanceSettings,
  themeId: AppearanceThemeId,
): AppearanceSettings {
  if (!appearance.customThemes[themeId]) {
    return appearance;
  }

  const { [themeId]: _deleted, ...customThemes } = appearance.customThemes;
  return {
    ...appearance,
    activeThemeId:
      appearance.activeThemeId === themeId
        ? DEFAULT_APPEARANCE_ACTIVE_THEME_ID
        : appearance.activeThemeId,
    customThemeOrder: appearance.customThemeOrder.filter((id) => id !== themeId),
    customThemes,
  };
}

export function updateCustomAppearanceTheme(
  appearance: AppearanceSettings,
  themeId: AppearanceThemeId,
  update: (theme: AppearanceTheme) => AppearanceTheme,
): AppearanceSettings {
  const theme = appearance.customThemes[themeId];
  if (!theme) {
    return appearance;
  }

  const nextTheme = decodeAppearanceTheme(update(cloneAppearanceTheme(theme)));
  validateAppearanceThemeOrThrow(nextTheme);

  return {
    ...appearance,
    customThemes: {
      ...appearance.customThemes,
      [themeId]: nextTheme,
    },
  };
}

export function resetCustomAppearanceThemeField(
  appearance: AppearanceSettings,
  themeId: AppearanceThemeId,
  path: AppearanceThemeFieldPath,
  templateThemeId: AppearanceBuiltInThemeId = "default",
): AppearanceSettings {
  const template = BUILT_IN_APPEARANCE_THEMES[templateThemeId];
  return updateCustomAppearanceTheme(appearance, themeId, (theme) => {
    if (path.kind === "topLevel") {
      return {
        ...theme,
        [path.field]: template[path.field],
      };
    }

    return {
      ...theme,
      variants: {
        ...theme.variants,
        [path.variant]: {
          ...theme.variants[path.variant],
          [path.field]: template.variants[path.variant][path.field],
        },
      },
    };
  });
}

export function validateHexColor(value: string): AppearanceValidationResult {
  return isHexColor(value.trim())
    ? { isValid: true, error: null }
    : { isValid: false, error: "Use a #RRGGBB color." };
}

function parseHexColor(value: string): { r: number; g: number; b: number } | null {
  const color = value.trim();
  if (!isHexColor(color)) {
    return null;
  }
  return {
    r: Number.parseInt(color.slice(1, 3), 16),
    g: Number.parseInt(color.slice(3, 5), 16),
    b: Number.parseInt(color.slice(5, 7), 16),
  };
}

function toLinearChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

export function getRelativeLuminance(color: string): number {
  const parsed = parseHexColor(color);
  if (!parsed) {
    return 0;
  }
  return (
    0.2126 * toLinearChannel(parsed.r) +
    0.7152 * toLinearChannel(parsed.g) +
    0.0722 * toLinearChannel(parsed.b)
  );
}

export function getContrastRatio(first: string, second: string): number {
  const lighter = Math.max(getRelativeLuminance(first), getRelativeLuminance(second));
  const darker = Math.min(getRelativeLuminance(first), getRelativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

export function derivePrimaryForeground(accent: string): "#000000" | "#FFFFFF" {
  return getContrastRatio(accent, "#000000") >= getContrastRatio(accent, "#FFFFFF")
    ? "#000000"
    : "#FFFFFF";
}

export function validateAppearanceThemeVariant(
  variant: AppearanceThemeVariant,
): AppearanceValidationResult {
  for (const field of ["accent", "background", "foreground", "surface", "muted"] as const) {
    const result = validateHexColor(variant[field]);
    if (!result.isValid) {
      return {
        isValid: false,
        error: `${field} must be a #RRGGBB color.`,
      };
    }
  }

  if (
    getContrastRatio(variant.foreground, variant.background) < MINIMUM_APPEARANCE_CONTRAST_RATIO
  ) {
    return {
      isValid: false,
      error: "Foreground and background need at least 4.5:1 contrast.",
    };
  }

  const primaryForeground = derivePrimaryForeground(variant.accent);
  if (getContrastRatio(variant.accent, primaryForeground) < MINIMUM_APPEARANCE_CONTRAST_RATIO) {
    return {
      isValid: false,
      error: "Accent needs at least 4.5:1 contrast with its foreground.",
    };
  }

  return { isValid: true, error: null };
}

export function validateAppearanceTheme(theme: AppearanceTheme): AppearanceValidationResult {
  const light = validateAppearanceThemeVariant(theme.variants.light);
  if (!light.isValid) {
    return light;
  }

  return validateAppearanceThemeVariant(theme.variants.dark);
}

export function validateAppearanceThemeOrThrow(theme: AppearanceTheme): void {
  const result = validateAppearanceTheme(theme);
  if (!result.isValid) {
    throw new Error(result.error ?? "Appearance theme is invalid.");
  }
}

export function setCustomAppearanceThemeVariantColor(
  appearance: AppearanceSettings,
  themeId: AppearanceThemeId,
  variantKey: AppearanceVariantKey,
  field: Extract<
    AppearanceThemeVariantField,
    "accent" | "background" | "foreground" | "surface" | "muted"
  >,
  color: string,
): AppearanceSettings {
  const normalizedColor = color.trim().toUpperCase();
  const hexResult = validateHexColor(normalizedColor);
  if (!hexResult.isValid) {
    throw new Error(hexResult.error ?? "Invalid color.");
  }

  return updateCustomAppearanceTheme(appearance, themeId, (theme) => ({
    ...theme,
    variants: {
      ...theme.variants,
      [variantKey]: {
        ...theme.variants[variantKey],
        [field]: normalizedColor,
      },
    },
  }));
}

export function resolveVariantKey(
  colorScheme: AppearanceColorScheme,
  prefersDark: boolean,
): AppearanceVariantKey {
  if (colorScheme === "dark") {
    return "dark";
  }
  if (colorScheme === "light") {
    return "light";
  }
  return prefersDark ? "dark" : "light";
}
