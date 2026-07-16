import {
  AppearanceFontFamily,
  DEFAULT_TERMINAL_FONT_FAMILY,
  type AppearanceSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  defaultAppearanceThemeIdGenerator,
  duplicateAppearanceTheme,
  type AppearanceThemeIdGenerator,
  updateAppearanceTheme,
} from "./appearanceOperations.ts";
import { parseThemePreference } from "./legacyTheme.ts";

const decodeAppearanceFontFamily = Schema.decodeUnknownOption(AppearanceFontFamily);

export interface MigrateLegacyAppearanceInput {
  readonly rawAppearancePresent: boolean;
  readonly legacyThemeMode: string | null;
  readonly legacyTerminalFontFamily: string | null | undefined;
  readonly defaults: AppearanceSettings;
  readonly generateThemeId?: AppearanceThemeIdGenerator;
}

/**
 * Builds a new Appearance snapshot from legacy visual preferences. The caller
 * decides whether to persist it; existing Appearance state is always returned
 * untouched when the raw settings document already contained `appearance`.
 */
export function migrateLegacyAppearance({
  rawAppearancePresent,
  legacyThemeMode,
  legacyTerminalFontFamily,
  defaults,
  generateThemeId = defaultAppearanceThemeIdGenerator,
}: MigrateLegacyAppearanceInput): AppearanceSettings {
  if (rawAppearancePresent) {
    return defaults;
  }

  const colorScheme = parseThemePreference(legacyThemeMode);
  const decodedLegacyFont = decodeAppearanceFontFamily(legacyTerminalFontFamily?.trim());
  const legacyFont = Option.getOrElse(decodedLegacyFont, () => DEFAULT_TERMINAL_FONT_FAMILY);
  const base: AppearanceSettings = { ...defaults, colorScheme };

  if (legacyFont === DEFAULT_TERMINAL_FONT_FAMILY) {
    return base;
  }

  const duplicated = duplicateAppearanceTheme(base, "default", generateThemeId);
  return updateAppearanceTheme(duplicated, duplicated.activeThemeId, {
    name: "Migrated",
    monoFontFamily: legacyFont,
    terminalFontFamily: legacyFont,
  });
}
