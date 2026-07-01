import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings } from "@t3tools/contracts/settings";
import {
  BUILT_IN_APPEARANCE_THEMES,
  deleteCustomAppearanceTheme,
  duplicateAppearanceTheme,
  renameCustomAppearanceTheme,
  resetCustomAppearanceThemeField,
  resolveAppearanceTheme,
  setCustomAppearanceThemeVariantColor,
  updateCustomAppearanceTheme,
  validateAppearanceThemeVariant,
} from "./appearanceThemes";

function duplicateDefault(
  appearance: AppearanceSettings = DEFAULT_APPEARANCE_SETTINGS,
): AppearanceSettings {
  return duplicateAppearanceTheme(appearance, "default", {
    id: "custom_default",
    name: "Default copy",
  });
}

describe("appearance theme domain", () => {
  it("duplicates a built-in theme into an active custom theme", () => {
    const appearance = duplicateDefault();

    expect(appearance.activeThemeId).toBe("custom_default");
    expect(appearance.customThemeOrder).toEqual(["custom_default"]);
    expect(appearance.customThemes.custom_default).toEqual({
      ...BUILT_IN_APPEARANCE_THEMES.default,
      id: "custom_default",
      name: "Default copy",
    });
  });

  it("duplicates a custom theme into a second active custom theme", () => {
    const first = duplicateDefault();
    const second = duplicateAppearanceTheme(first, "custom_default", {
      id: "custom_default_2",
      name: "Default copy 2",
    });

    expect(second.activeThemeId).toBe("custom_default_2");
    expect(second.customThemeOrder).toEqual(["custom_default", "custom_default_2"]);
    expect(second.customThemes.custom_default_2).toEqual({
      ...first.customThemes.custom_default,
      id: "custom_default_2",
      name: "Default copy 2",
    });
  });

  it("renames custom themes with trimmed names", () => {
    const appearance = renameCustomAppearanceTheme(duplicateDefault(), "custom_default", "  Easy ");

    expect(appearance.customThemes.custom_default?.name).toBe("Easy");
  });

  it("ignores built-in rename, edit, and delete operations", () => {
    const renamed = renameCustomAppearanceTheme(DEFAULT_APPEARANCE_SETTINGS, "default", "Changed");
    const edited = updateCustomAppearanceTheme(DEFAULT_APPEARANCE_SETTINGS, "default", (theme) => ({
      ...theme,
      uiFontSizePx: 20,
    }));
    const deleted = deleteCustomAppearanceTheme(DEFAULT_APPEARANCE_SETTINGS, "default");

    expect(renamed).toBe(DEFAULT_APPEARANCE_SETTINGS);
    expect(edited).toBe(DEFAULT_APPEARANCE_SETTINGS);
    expect(deleted).toBe(DEFAULT_APPEARANCE_SETTINGS);
  });

  it("deletes an active custom theme and falls back to built-in Default", () => {
    const deleted = deleteCustomAppearanceTheme(duplicateDefault(), "custom_default");

    expect(deleted.activeThemeId).toBe("default");
    expect(deleted.customThemeOrder).toEqual([]);
    expect(deleted.customThemes).toEqual({});
  });

  it("resolves unknown active theme ids to built-in Default", () => {
    const resolved = resolveAppearanceTheme({
      ...DEFAULT_APPEARANCE_SETTINGS,
      activeThemeId: "missing_theme",
    });

    expect(resolved.isBuiltIn).toBe(true);
    expect(resolved.theme).toBe(BUILT_IN_APPEARANCE_THEMES.default);
  });

  it("resets custom top-level and variant fields to the Default template", () => {
    const customized = setCustomAppearanceThemeVariantColor(
      updateCustomAppearanceTheme(duplicateDefault(), "custom_default", (theme) => ({
        ...theme,
        uiFontSizePx: 18,
      })),
      "custom_default",
      "light",
      "accent",
      "#2563EB",
    );

    const resetSize = resetCustomAppearanceThemeField(customized, "custom_default", {
      kind: "topLevel",
      field: "uiFontSizePx",
    });
    const resetAccent = resetCustomAppearanceThemeField(resetSize, "custom_default", {
      kind: "variant",
      variant: "light",
      field: "accent",
    });

    expect(resetAccent.customThemes.custom_default?.uiFontSizePx).toBe(
      BUILT_IN_APPEARANCE_THEMES.default.uiFontSizePx,
    );
    expect(resetAccent.customThemes.custom_default?.variants.light.accent).toBe(
      BUILT_IN_APPEARANCE_THEMES.default.variants.light.accent,
    );
  });

  it("rejects invalid custom colors before persistence", () => {
    expect(() =>
      setCustomAppearanceThemeVariantColor(
        duplicateDefault(),
        "custom_default",
        "light",
        "accent",
        "#12345",
      ),
    ).toThrow("Use a #RRGGBB color.");
  });

  it("blocks unsafe foreground and background contrast", () => {
    expect(() =>
      setCustomAppearanceThemeVariantColor(
        duplicateDefault(),
        "custom_default",
        "light",
        "foreground",
        "#FFFFFF",
      ),
    ).toThrow("Foreground and background need at least 4.5:1 contrast.");

    expect(
      validateAppearanceThemeVariant({
        ...BUILT_IN_APPEARANCE_THEMES.default.variants.light,
        foreground: "#FFFFFF",
      }),
    ).toEqual({
      isValid: false,
      error: "Foreground and background need at least 4.5:1 contrast.",
    });
  });
});
