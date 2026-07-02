import { Debouncer } from "@tanstack/react-pacer";
import {
  DEFAULT_APPEARANCE_CHAT_FONT_SIZE_PX,
  DEFAULT_APPEARANCE_CODE_FONT_SIZE_PX,
  DEFAULT_APPEARANCE_MONO_FONT_FAMILY,
  DEFAULT_APPEARANCE_TERMINAL_FONT_SIZE_PX,
  DEFAULT_APPEARANCE_UI_FONT_FAMILY,
  DEFAULT_APPEARANCE_UI_FONT_SIZE_PX,
  MAX_APPEARANCE_CHAT_FONT_SIZE_PX,
  MAX_APPEARANCE_CODE_FONT_SIZE_PX,
  MAX_APPEARANCE_TERMINAL_FONT_SIZE_PX,
  MAX_APPEARANCE_UI_FONT_SIZE_PX,
  MIN_APPEARANCE_CHAT_FONT_SIZE_PX,
  MIN_APPEARANCE_CODE_FONT_SIZE_PX,
  MIN_APPEARANCE_TERMINAL_FONT_SIZE_PX,
  MIN_APPEARANCE_UI_FONT_SIZE_PX,
  READABLE_APPEARANCE_UI_FONT_FAMILY,
  type AppearanceColorScheme,
  type AppearanceDensity,
  type AppearanceDiffMarkerStyle,
} from "@t3tools/contracts/settings";
import { validateHexColor, type AppearanceThemeVariantField } from "~/appearance/appearanceThemes";

export type FontSizeField =
  | "uiFontSizePx"
  | "chatFontSizePx"
  | "codeFontSizePx"
  | "terminalFontSizePx";

export interface DebouncedCommit<T> {
  readonly set: (value: T) => void;
  readonly flush: () => void;
  readonly cancel: () => void;
}

export const THEME_MODE_OPTIONS: ReadonlyArray<{
  readonly value: AppearanceColorScheme;
  readonly label: string;
}> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export const DENSITY_OPTIONS: ReadonlyArray<{
  readonly value: AppearanceDensity;
  readonly label: string;
}> = [
  { value: "compact", label: "Compact" },
  { value: "default", label: "Default" },
  { value: "comfortable", label: "Comfortable" },
];

export const DIFF_MARKER_OPTIONS: ReadonlyArray<{
  readonly value: AppearanceDiffMarkerStyle;
  readonly label: string;
}> = [
  { value: "color", label: "Color" },
  { value: "color-and-markers", label: "+/- markers" },
];

export const UI_FONT_OPTIONS = [
  { label: "DM Sans", value: DEFAULT_APPEARANCE_UI_FONT_FAMILY },
  {
    label: "System",
    value: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
  { label: "Inter", value: `Inter, ${DEFAULT_APPEARANCE_UI_FONT_FAMILY}` },
  { label: "Segoe UI", value: '"Segoe UI", system-ui, sans-serif' },
  { label: "Atkinson Hyperlegible", value: READABLE_APPEARANCE_UI_FONT_FAMILY },
] as const;

export const MONO_FONT_OPTIONS = [
  { label: "System Mono", value: DEFAULT_APPEARANCE_MONO_FONT_FAMILY },
  {
    label: "Cascadia Code",
    value: `"Cascadia Code", "Cascadia Mono", ${DEFAULT_APPEARANCE_MONO_FONT_FAMILY}`,
  },
  { label: "JetBrains Mono", value: `"JetBrains Mono", ${DEFAULT_APPEARANCE_MONO_FONT_FAMILY}` },
  { label: "Consolas", value: `Consolas, ${DEFAULT_APPEARANCE_MONO_FONT_FAMILY}` },
  {
    label: "SF Mono",
    value: `"SF Mono", "SFMono-Regular", ${DEFAULT_APPEARANCE_MONO_FONT_FAMILY}`,
  },
] as const;

export const COLOR_SWATCHES = [
  "#6366F1",
  "#2563EB",
  "#059669",
  "#D97706",
  "#E11D48",
  "#525252",
] as const;

export const FONT_SIZE_CSS_VARIABLES: Record<FontSizeField, string> = {
  uiFontSizePx: "--app-ui-font-size",
  chatFontSizePx: "--app-chat-font-size",
  codeFontSizePx: "--app-code-font-size",
  terminalFontSizePx: "--app-terminal-font-size",
};

export const COLOR_FIELDS = [
  { field: "accent", label: "Accent" },
  { field: "background", label: "Background" },
  { field: "foreground", label: "Foreground" },
  { field: "surface", label: "Surface" },
  { field: "muted", label: "Muted" },
] as const satisfies ReadonlyArray<{
  readonly field: Extract<
    AppearanceThemeVariantField,
    "accent" | "background" | "foreground" | "surface" | "muted"
  >;
  readonly label: string;
}>;

export const FONT_SIZE_ROWS: ReadonlyArray<{
  readonly field: FontSizeField;
  readonly title: string;
  readonly description: string;
  readonly min: number;
  readonly max: number;
}> = [
  {
    field: "uiFontSizePx",
    title: "UI font size",
    description: "Adjust the base size used for T3 Code controls.",
    min: MIN_APPEARANCE_UI_FONT_SIZE_PX,
    max: MAX_APPEARANCE_UI_FONT_SIZE_PX,
  },
  {
    field: "chatFontSizePx",
    title: "Chat font size",
    description: "Adjust the base size used for assistant and user messages.",
    min: MIN_APPEARANCE_CHAT_FONT_SIZE_PX,
    max: MAX_APPEARANCE_CHAT_FONT_SIZE_PX,
  },
  {
    field: "codeFontSizePx",
    title: "Code font size",
    description: "Adjust inline code, code blocks, and diff text.",
    min: MIN_APPEARANCE_CODE_FONT_SIZE_PX,
    max: MAX_APPEARANCE_CODE_FONT_SIZE_PX,
  },
  {
    field: "terminalFontSizePx",
    title: "Terminal font size",
    description: "Adjust open terminal sessions and future terminals.",
    min: MIN_APPEARANCE_TERMINAL_FONT_SIZE_PX,
    max: MAX_APPEARANCE_TERMINAL_FONT_SIZE_PX,
  },
];

export function clampInt(value: number | null, min: number, max: number): number {
  if (value === null || !Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function fontOptionLabel(
  value: string,
  options: ReadonlyArray<{ readonly label: string; readonly value: string }>,
): string {
  return options.find((option) => option.value === value)?.label ?? "Custom";
}

export function getFontSizeDefaults(field: FontSizeField): number {
  switch (field) {
    case "uiFontSizePx":
      return DEFAULT_APPEARANCE_UI_FONT_SIZE_PX;
    case "chatFontSizePx":
      return DEFAULT_APPEARANCE_CHAT_FONT_SIZE_PX;
    case "codeFontSizePx":
      return DEFAULT_APPEARANCE_CODE_FONT_SIZE_PX;
    case "terminalFontSizePx":
      return DEFAULT_APPEARANCE_TERMINAL_FONT_SIZE_PX;
  }
}

export function normalizeHexColorInput(value: string): string {
  return value.trim().toUpperCase();
}

export function validateHexColorInput(value: string): ReturnType<typeof validateHexColor> {
  return validateHexColor(normalizeHexColorInput(value));
}

export function createDebouncedCommit<T>(
  commit: (value: T) => void,
  delayMs: number,
): DebouncedCommit<T> {
  let hasPendingValue = false;
  let pendingValue: T | undefined;
  const debouncer = new Debouncer(
    () => {
      if (!hasPendingValue) {
        return;
      }
      const value = pendingValue as T;
      hasPendingValue = false;
      pendingValue = undefined;
      commit(value);
    },
    { wait: delayMs },
  );

  return {
    set: (value) => {
      pendingValue = value;
      hasPendingValue = true;
      debouncer.maybeExecute();
    },
    flush: () => {
      debouncer.flush();
    },
    cancel: () => {
      hasPendingValue = false;
      pendingValue = undefined;
      debouncer.cancel();
    },
  };
}
