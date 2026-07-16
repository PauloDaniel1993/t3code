import { DEFAULT_APPEARANCE_SETTINGS, DEFAULT_TERMINAL_FONT_FAMILY } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { migrateLegacyAppearance } from "./appearanceMigration.ts";
import { BUILT_IN_APPEARANCE_THEMES } from "./appearanceThemes.ts";

const migratedId = "custom-migrated-test";
const generateThemeId = () => migratedId;
const legacyFont = '"Cascadia Mono", Consolas, monospace';

function migrate(overrides: Partial<Parameters<typeof migrateLegacyAppearance>[0]> = {}) {
  return migrateLegacyAppearance({
    rawAppearancePresent: false,
    legacyThemeMode: null,
    legacyTerminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    defaults: DEFAULT_APPEARANCE_SETTINGS,
    generateThemeId,
    ...overrides,
  });
}

describe("legacy appearance migration", () => {
  it("keeps default Appearance without creating a custom theme for legacy defaults", () => {
    const result = migrate();

    expect(result).toEqual(DEFAULT_APPEARANCE_SETTINGS);
    expect(result).not.toBe(DEFAULT_APPEARANCE_SETTINGS);
  });

  it("migrates a non-default mode without creating a Migrated theme", () => {
    const result = migrate({ legacyThemeMode: "dark" });

    expect(result).toEqual({ ...DEFAULT_APPEARANCE_SETTINGS, colorScheme: "dark" });
    expect(result.activeThemeId).toBe("default");
    expect(result.customThemes).toEqual({});
  });

  it("creates and activates one Migrated theme for a legacy terminal font", () => {
    const defaultBefore = structuredClone(BUILT_IN_APPEARANCE_THEMES.default);
    const result = migrate({ legacyTerminalFontFamily: legacyFont });

    expect(result.activeThemeId).toBe(migratedId);
    expect(result.customThemeOrder).toEqual([migratedId]);
    expect(Object.keys(result.customThemes)).toEqual([migratedId]);
    expect(result.customThemes[migratedId]).toMatchObject({
      id: migratedId,
      name: "Migrated",
      monoFontFamily: legacyFont,
      terminalFontFamily: legacyFont,
    });
    expect(result.customThemes[migratedId]?.variants).toEqual(
      BUILT_IN_APPEARANCE_THEMES.default.variants,
    );
    expect(BUILT_IN_APPEARANCE_THEMES.default).toEqual(defaultBefore);
    expect(Object.isFrozen(BUILT_IN_APPEARANCE_THEMES.default)).toBe(true);
  });

  it("combines legacy mode and font into the same Migrated theme", () => {
    const result = migrate({
      legacyThemeMode: "light",
      legacyTerminalFontFamily: legacyFont,
    });

    expect(result.colorScheme).toBe("light");
    expect(result.customThemeOrder).toEqual([migratedId]);
    expect(result.customThemes[migratedId]?.name).toBe("Migrated");
  });

  it("keeps the color-scheme migration when an invalid legacy font is discarded", () => {
    const migration = () =>
      migrate({
        legacyThemeMode: "dark",
        legacyTerminalFontFamily: "Consolas; color:red",
      });

    expect(migration).not.toThrow();

    const result = migration();
    expect(result.colorScheme).toBe("dark");
    expect(result.activeThemeId).toBe("default");
    expect(result.customThemeOrder).toEqual([]);
    expect(result.customThemes).toEqual({});
  });

  it("does not migrate when the raw document already had Appearance", () => {
    const existing = { ...DEFAULT_APPEARANCE_SETTINGS, colorScheme: "dark" as const };
    const result = migrate({
      rawAppearancePresent: true,
      defaults: existing,
      legacyThemeMode: "light",
      legacyTerminalFontFamily: legacyFont,
    });

    expect(result).toBe(existing);
  });
});
