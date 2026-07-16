import {
  APPEARANCE_FONT_SIZE_BOUNDS,
  BUILT_IN_APPEARANCE_THEME_IDS,
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  type AppearanceSettings,
} from "@t3tools/contracts";

import { BUILT_IN_APPEARANCE_THEMES } from "../../appearance/appearanceThemes.ts";

export type AppearanceFontSizeKind = keyof typeof APPEARANCE_FONT_SIZE_BOUNDS;

export function clampFontSize(kind: AppearanceFontSizeKind, px: number): number {
  const bounds = APPEARANCE_FONT_SIZE_BOUNDS[kind];
  if (!Number.isFinite(px)) {
    return bounds.default;
  }
  return Math.min(bounds.max, Math.max(bounds.min, px));
}

export interface DebouncedCommit<T> {
  readonly set: (value: T) => void;
  readonly flush: () => void;
  readonly cancel: () => void;
  /** Use as a React effect cleanup to commit the latest pending value on unmount. */
  readonly flushOnUnmount: () => void;
  /** Alias for flushOnUnmount for non-React lifecycle owners. */
  readonly dispose: () => void;
}

export function createDebouncedCommit<T>(
  commit: (value: T) => void,
  delayMs = 400,
): DebouncedCommit<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hasPendingValue = false;
  let pendingValue: T;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    clearTimer();
    if (!hasPendingValue) {
      return;
    }
    const value = pendingValue;
    hasPendingValue = false;
    commit(value);
  };

  const cancel = () => {
    clearTimer();
    hasPendingValue = false;
  };

  const set = (value: T) => {
    pendingValue = value;
    hasPendingValue = true;
    clearTimer();
    timer = setTimeout(flush, Math.max(0, delayMs));
  };

  return { set, flush, cancel, flushOnUnmount: flush, dispose: flush };
}

export type HexInputValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export function validateHexInput(value: string): HexInputValidation {
  return /^#[0-9a-fA-F]{6}$/.test(value)
    ? { ok: true }
    : { ok: false, error: "Enter a six-digit hex color in #RRGGBB format." };
}

export interface AppearanceFontOption {
  readonly label: string;
  readonly value: string;
}

export const APPEARANCE_UI_FONT_OPTIONS: readonly AppearanceFontOption[] = Object.freeze([
  { label: "Default", value: DEFAULT_UI_FONT_STACK },
  {
    label: "Atkinson Hyperlegible",
    value: `"Atkinson Hyperlegible", ${DEFAULT_UI_FONT_STACK}`,
  },
  {
    label: "System UI",
    value: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
]);

export const APPEARANCE_MONO_FONT_OPTIONS: readonly AppearanceFontOption[] = Object.freeze([
  { label: "Default", value: DEFAULT_MONO_FONT_STACK },
  {
    label: "JetBrains Mono",
    value: '"JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace',
  },
  {
    label: "System Mono",
    value: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
  },
]);

export interface AppearanceThemeListItem {
  readonly id: string;
  readonly name: string;
  readonly isBuiltIn: boolean;
  readonly isActive: boolean;
}

export function buildThemeListModel(
  appearance: AppearanceSettings,
): readonly AppearanceThemeListItem[] {
  const builtIns = BUILT_IN_APPEARANCE_THEME_IDS.map((id) => ({
    id,
    name: BUILT_IN_APPEARANCE_THEMES[id].name,
    isBuiltIn: true,
    isActive: appearance.activeThemeId === id,
  }));
  const customs = appearance.customThemeOrder.flatMap((id) => {
    const theme = appearance.customThemes[id];
    return theme === undefined
      ? []
      : [
          {
            id,
            name: theme.name,
            isBuiltIn: false,
            isActive: appearance.activeThemeId === id,
          },
        ];
  });
  return [...builtIns, ...customs];
}
