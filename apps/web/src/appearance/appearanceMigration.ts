import {
  DEFAULT_APPEARANCE_ACTIVE_THEME_ID,
  DEFAULT_APPEARANCE_COLOR_SCHEME,
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_TERMINAL_FONT_FAMILY,
  type AppearanceColorScheme,
  type AppearanceSettings,
  type ClientSettings,
} from "@t3tools/contracts/settings";
import { duplicateAppearanceTheme, updateCustomAppearanceTheme } from "./appearanceThemes";
import { THEME_STORAGE_KEY, readThemePreference } from "./legacyTheme";

export const LEGACY_THEME_STORAGE_KEY = THEME_STORAGE_KEY;
export const MIGRATED_APPEARANCE_THEME_ID = "custom_migrated";
export const MIGRATED_APPEARANCE_THEME_NAME = "Migrated";

export function readLegacyThemePreferenceSafely(
  onError?: (error: unknown) => void,
): ReturnType<typeof readThemePreference> {
  try {
    return readThemePreference();
  } catch (error) {
    onError?.(error);
    return null;
  }
}

function isDefaultAppearanceSettings(appearance: AppearanceSettings): boolean {
  return (
    appearance.colorScheme === DEFAULT_APPEARANCE_COLOR_SCHEME &&
    appearance.activeThemeId === DEFAULT_APPEARANCE_ACTIVE_THEME_ID &&
    appearance.customThemeOrder.length === 0 &&
    Object.keys(appearance.customThemes).length === 0
  );
}

function createMigratedTheme(appearance: AppearanceSettings, terminalFontFamily: string) {
  const duplicated = duplicateAppearanceTheme(appearance, "default", {
    id: MIGRATED_APPEARANCE_THEME_ID,
    name: MIGRATED_APPEARANCE_THEME_NAME,
  });

  return updateCustomAppearanceTheme(duplicated, MIGRATED_APPEARANCE_THEME_ID, (theme) => ({
    ...theme,
    monoFontFamily: terminalFontFamily,
    terminalFontFamily,
  }));
}

export function migrateLegacyAppearanceSettings(
  settings: ClientSettings,
  options: {
    readonly legacyThemePreference?: AppearanceColorScheme | null;
    readonly force?: boolean;
  } = {},
): ClientSettings {
  if (!options.force && !isDefaultAppearanceSettings(settings.appearance)) {
    return settings;
  }

  const legacyThemePreference = options.legacyThemePreference ?? null;
  const legacyTerminalFontFamily = settings.terminalFontFamily;
  const hasLegacyTerminalFont =
    legacyTerminalFontFamily.trim() !== "" &&
    legacyTerminalFontFamily !== DEFAULT_TERMINAL_FONT_FAMILY;

  if (!legacyThemePreference && !hasLegacyTerminalFont) {
    return settings;
  }

  let appearance: AppearanceSettings = {
    ...DEFAULT_APPEARANCE_SETTINGS,
    colorScheme: legacyThemePreference ?? DEFAULT_APPEARANCE_COLOR_SCHEME,
  };

  if (hasLegacyTerminalFont) {
    appearance = {
      ...createMigratedTheme(appearance, legacyTerminalFontFamily),
      colorScheme: appearance.colorScheme,
    };
  }

  return {
    ...settings,
    appearance,
  };
}
