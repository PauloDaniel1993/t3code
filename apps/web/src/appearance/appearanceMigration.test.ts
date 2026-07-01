import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_APPEARANCE_SETTINGS, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { BUILT_IN_APPEARANCE_THEMES } from "./appearanceThemes";
import {
  MIGRATED_APPEARANCE_THEME_ID,
  MIGRATED_APPEARANCE_THEME_NAME,
  migrateLegacyAppearanceSettings,
} from "./appearanceMigration";

describe("appearance legacy migration", () => {
  it("stores legacy mode without creating a custom theme when fonts are default", () => {
    const migrated = migrateLegacyAppearanceSettings(DEFAULT_CLIENT_SETTINGS, {
      legacyThemePreference: "dark",
    });

    expect(migrated.appearance.colorScheme).toBe("dark");
    expect(migrated.appearance.activeThemeId).toBe("default");
    expect(migrated.appearance.customThemeOrder).toEqual([]);
    expect(migrated.appearance.customThemes).toEqual({});
  });

  it("creates an active Migrated custom theme for legacy terminal fonts", () => {
    const migrated = migrateLegacyAppearanceSettings(
      {
        ...DEFAULT_CLIENT_SETTINGS,
        terminalFontFamily: '"CaskaydiaCove Nerd Font", monospace',
      },
      { legacyThemePreference: "light" },
    );

    expect(migrated.appearance.colorScheme).toBe("light");
    expect(migrated.appearance.activeThemeId).toBe(MIGRATED_APPEARANCE_THEME_ID);
    expect(migrated.appearance.customThemeOrder).toEqual([MIGRATED_APPEARANCE_THEME_ID]);
    expect(migrated.appearance.customThemes[MIGRATED_APPEARANCE_THEME_ID]).toEqual({
      ...BUILT_IN_APPEARANCE_THEMES.default,
      id: MIGRATED_APPEARANCE_THEME_ID,
      name: MIGRATED_APPEARANCE_THEME_NAME,
      monoFontFamily: '"CaskaydiaCove Nerd Font", monospace',
      terminalFontFamily: '"CaskaydiaCove Nerd Font", monospace',
    });
    expect(BUILT_IN_APPEARANCE_THEMES.default.terminalFontFamily).not.toBe(
      '"CaskaydiaCove Nerd Font", monospace',
    );
  });

  it("leaves default legacy settings unchanged", () => {
    expect(migrateLegacyAppearanceSettings(DEFAULT_CLIENT_SETTINGS)).toBe(DEFAULT_CLIENT_SETTINGS);
  });

  it("does not mutate explicit non-default appearance settings", () => {
    const explicit = {
      ...DEFAULT_CLIENT_SETTINGS,
      appearance: {
        ...DEFAULT_APPEARANCE_SETTINGS,
        activeThemeId: "readable",
      },
      terminalFontFamily: '"CaskaydiaCove Nerd Font", monospace',
    };

    expect(
      migrateLegacyAppearanceSettings(explicit, {
        legacyThemePreference: "dark",
      }),
    ).toBe(explicit);
  });
});
