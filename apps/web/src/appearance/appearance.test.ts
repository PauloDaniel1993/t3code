import {
  BUILT_IN_APPEARANCE_THEME_IDS,
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_TERMINAL_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  type AppearanceSettings,
  type AppearanceTheme,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { contrastRatio, hexToRgb, relativeLuminance } from "./appearanceContrast.ts";
import { deriveVariantTokens } from "./appearanceDerived.ts";
import {
  deleteAppearanceTheme,
  duplicateAppearanceTheme,
  renameAppearanceTheme,
  resetAppearance,
  setActiveTheme,
  setColorScheme,
  updateAppearanceTheme,
} from "./appearanceOperations.ts";
import {
  BUILT_IN_APPEARANCE_THEMES,
  collidesWithBuiltInId,
  isBuiltInThemeId,
  resolveActiveAppearanceTheme,
} from "./appearanceThemes.ts";
import { validateAppearanceTheme } from "./appearanceValidation.ts";

function customTheme(id = "custom-ocean", name = "Ocean"): AppearanceTheme {
  return {
    id,
    name,
    uiFontFamily: DEFAULT_UI_FONT_STACK,
    monoFontFamily: DEFAULT_MONO_FONT_STACK,
    terminalFontFamily: DEFAULT_TERMINAL_FONT_STACK,
    uiFontSizePx: 14,
    chatFontSizePx: 14,
    codeFontSizePx: 12,
    terminalFontSizePx: 12,
    density: "default",
    diffMarkerStyle: "color",
    variants: {
      light: {
        accent: "#1b4ed8",
        background: "#ffffff",
        foreground: "#262626",
        surface: "#ffffff",
        muted: "#f5f5f5",
        contrast: 1,
        translucentSidebar: false,
      },
      dark: {
        accent: "#366ffb",
        background: "#161616",
        foreground: "#f5f5f5",
        surface: "#1b1b1b",
        muted: "#1f1f1f",
        contrast: 1,
        translucentSidebar: false,
      },
    },
  };
}

function stateWithThemes(...themes: AppearanceTheme[]): AppearanceSettings {
  return {
    colorScheme: "dark",
    activeThemeId: themes[0]?.id ?? "default",
    customThemeOrder: themes.map((theme) => theme.id),
    customThemes: Object.fromEntries(themes.map((theme) => [theme.id, theme])),
  };
}

describe("appearance contrast", () => {
  it("parses strict hex colors", () => {
    expect(hexToRgb("#1b4eD8")).toEqual({ red: 27, green: 78, blue: 216 });
    expect(() => hexToRgb("#fff")).toThrow(/#RRGGBB/);
  });

  it("matches known WCAG luminance and contrast values", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBe(1);
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
  });
});

describe("built-in appearance themes", () => {
  it("preserves the exact current Default baseline and freezes every built-in", () => {
    expect(BUILT_IN_APPEARANCE_THEMES.default).toMatchObject({
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
      variants: {
        light: {
          accent: "#1b4ed8",
          background: "#ffffff",
          foreground: "#262626",
          surface: "#ffffff",
          muted: "#f5f5f5",
        },
        dark: {
          accent: "#366ffb",
          background: "#161616",
          foreground: "#f5f5f5",
          surface: "#1b1b1b",
          muted: "#1f1f1f",
        },
      },
    });
    for (const id of BUILT_IN_APPEARANCE_THEME_IDS) {
      const theme = BUILT_IN_APPEARANCE_THEMES[id];
      expect(Object.isFrozen(theme)).toBe(true);
      expect(Object.isFrozen(theme.variants)).toBe(true);
      expect(Object.isFrozen(theme.variants.light)).toBe(true);
      expect(Object.isFrozen(theme.variants.dark)).toBe(true);
    }
  });

  it("defines Readable, Compact, and Terminal from the baseline", () => {
    expect(BUILT_IN_APPEARANCE_THEMES.readable).toMatchObject({
      uiFontSizePx: 16,
      chatFontSizePx: 16,
      density: "comfortable",
    });
    expect(BUILT_IN_APPEARANCE_THEMES.readable.uiFontFamily).toMatch(/^"Atkinson Hyperlegible",/);
    expect(BUILT_IN_APPEARANCE_THEMES.compact).toMatchObject({
      uiFontSizePx: 13,
      chatFontSizePx: 13,
      density: "compact",
    });
    expect(BUILT_IN_APPEARANCE_THEMES.terminal).toMatchObject({
      codeFontSizePx: 13,
      terminalFontSizePx: 13,
    });
    for (const id of ["readable", "compact", "terminal"] as const) {
      expect(BUILT_IN_APPEARANCE_THEMES[id].variants).toEqual(
        BUILT_IN_APPEARANCE_THEMES.default.variants,
      );
    }
  });

  it("resolves built-ins, custom themes, and unknown-id fallback", () => {
    expect(resolveActiveAppearanceTheme(DEFAULT_APPEARANCE_SETTINGS).id).toBe("default");
    const custom = customTheme();
    expect(resolveActiveAppearanceTheme(stateWithThemes(custom))).toBe(custom);
    expect(
      resolveActiveAppearanceTheme({
        ...stateWithThemes(custom),
        activeThemeId: "custom-missing",
      }).id,
    ).toBe("default");
    expect(isBuiltInThemeId("default")).toBe(true);
    expect(isBuiltInThemeId("Default")).toBe(false);
    expect(collidesWithBuiltInId("Default")).toBe(true);
  });
});

describe("appearance validation and derivation", () => {
  it("normalizes valid themes and accepts the baseline variants", () => {
    expect(validateAppearanceTheme({ ...customTheme(), name: "  Ocean  " }).name).toBe("Ocean");
  });

  it.each([
    ["missing shape field", ({ id: _id, ...theme }: AppearanceTheme) => theme],
    ["empty name", (theme: AppearanceTheme) => ({ ...theme, name: "   " })],
    [
      "invalid font list",
      (theme: AppearanceTheme) => ({ ...theme, monoFontFamily: "Consolas; color:red" }),
    ],
    ["font size bounds", (theme: AppearanceTheme) => ({ ...theme, chatFontSizePx: 99 })],
    ["density", (theme: AppearanceTheme) => ({ ...theme, density: "dense" })],
    ["diff marker style", (theme: AppearanceTheme) => ({ ...theme, diffMarkerStyle: "markers" })],
    [
      "hex color",
      (theme: AppearanceTheme) => ({
        ...theme,
        variants: { ...theme.variants, light: { ...theme.variants.light, accent: "#fff" } },
      }),
    ],
    [
      "variant shape",
      (theme: AppearanceTheme) => ({ ...theme, variants: { light: theme.variants.light } }),
    ],
  ] as const)("rejects invalid %s", (_label, mutate) => {
    expect(() => validateAppearanceTheme(mutate(customTheme()))).toThrow(/Invalid appearance/);
  });

  it("rejects unsafe foreground/background contrast", () => {
    const theme = customTheme();
    expect(() =>
      validateAppearanceTheme({
        ...theme,
        variants: {
          ...theme.variants,
          light: { ...theme.variants.light, foreground: "#777777", background: "#777777" },
        },
      }),
    ).toThrow(/below 4\.5:1/);
  });

  it("derives deterministic and contrast-safe tokens for both Default variants", () => {
    for (const variant of Object.values(BUILT_IN_APPEARANCE_THEMES.default.variants)) {
      expect(deriveVariantTokens(variant)).toEqual(deriveVariantTokens(variant));
      const tokens = deriveVariantTokens(variant);
      expect(contrastRatio(tokens.primaryForeground, variant.accent)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(tokens.mutedForeground, variant.muted)).toBeGreaterThanOrEqual(4.5);
      for (const value of Object.values(tokens)) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("keeps derived accent foregrounds readable at light and dark contrast boundaries", () => {
    const boundaryTheme = validateAppearanceTheme({
      ...customTheme("custom-boundary", "Boundary"),
      variants: {
        light: {
          ...customTheme().variants.light,
          background: "#ffffff",
          foreground: "#767676",
        },
        dark: {
          ...customTheme().variants.dark,
          background: "#000000",
          foreground: "#767676",
        },
      },
    });

    for (const variant of Object.values(boundaryTheme.variants)) {
      const tokens = deriveVariantTokens(variant);
      expect(contrastRatio(tokens.accentForeground, tokens.accent)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("appearance operations", () => {
  it.each(BUILT_IN_APPEARANCE_THEME_IDS)("duplicates built-in %s successfully", (sourceId) => {
    const next = duplicateAppearanceTheme(
      DEFAULT_APPEARANCE_SETTINGS,
      sourceId,
      (slug) => `custom-${slug}-test`,
    );
    const created = next.customThemes[next.activeThemeId];
    expect(created).toBeDefined();
    expect(created?.name).toBe(`${BUILT_IN_APPEARANCE_THEMES[sourceId].name} copy`);
    expect(created?.variants).toEqual(BUILT_IN_APPEARANCE_THEMES[sourceId].variants);
    expect(next.customThemeOrder).toEqual([next.activeThemeId]);
  });

  it("duplicates a custom theme with deterministic id and copy-name sequencing", () => {
    const source = customTheme();
    const existingCopy = customTheme("custom-ocean-copy", "Ocean copy");
    const state = stateWithThemes(source, existingCopy);
    const next = duplicateAppearanceTheme(state, source.id, () => "custom-ocean-copy-2");

    expect(next.activeThemeId).toBe("custom-ocean-copy-2");
    expect(next.customThemes["custom-ocean-copy-2"]?.name).toBe("Ocean copy 2");
    expect(next.customThemes["custom-ocean-copy-2"]?.variants).toEqual(source.variants);
    expect(state.customThemes).not.toHaveProperty("custom-ocean-copy-2");
  });

  it("duplicates a 64-character theme name within the name limit", () => {
    const sourceName = "A".repeat(64);
    const source = customTheme("custom-sixty-four-character-theme", sourceName);
    const next = duplicateAppearanceTheme(
      stateWithThemes(source),
      source.id,
      () => "custom-long-copy",
    );
    const created = next.customThemes["custom-long-copy"];
    const expectedName = `${sourceName.slice(0, 59)} copy`;

    expect(created?.name).toBe(expectedName);
    expect(created?.name.length).toBeLessThanOrEqual(64);
    expect(created?.name).toMatch(/ copy$/);
    expect(
      new Set(Object.values(next.customThemes).map((theme) => theme.name.toLowerCase())).size,
    ).toBe(2);
  });

  it("keeps numbered copy names within the name limit after a collision", () => {
    const sourceName = "B".repeat(64);
    const source = customTheme("custom-sixty-four-character-theme", sourceName);
    const existingCopy = customTheme("custom-long-copy", `${sourceName.slice(0, 59)} copy`);
    const next = duplicateAppearanceTheme(stateWithThemes(source, existingCopy), source.id, () => {
      return "custom-long-copy-2";
    });
    const created = next.customThemes["custom-long-copy-2"];

    expect(created?.name).toBe(`${sourceName.slice(0, 57)} copy 2`);
    expect(created?.name.length).toBeLessThanOrEqual(64);
  });

  it("throws without mutation when duplicating a stored invalid-contrast custom theme", () => {
    const source = customTheme();
    const invalid: AppearanceTheme = {
      ...source,
      variants: {
        ...source.variants,
        light: { ...source.variants.light, foreground: "#ffffff" },
      },
    };
    const state = stateWithThemes(invalid);
    expect(() => duplicateAppearanceTheme(state, invalid.id, () => "custom-invalid-copy")).toThrow(
      /contrast/,
    );
    expect(state).toEqual(stateWithThemes(invalid));
    expect(state.customThemes).not.toHaveProperty("custom-invalid-copy");
  });

  it("renames custom themes with trimming and rejects empty names", () => {
    const state = stateWithThemes(customTheme());
    expect(
      renameAppearanceTheme(state, "custom-ocean", "  Sea  ").customThemes["custom-ocean"]?.name,
    ).toBe("Sea");
    expect(() => renameAppearanceTheme(state, "custom-ocean", "   ")).toThrow(/must not be empty/);
  });

  it("deletes an active custom theme and falls back to default", () => {
    const state = stateWithThemes(customTheme());
    const next = deleteAppearanceTheme(state, "custom-ocean");
    expect(next.activeThemeId).toBe("default");
    expect(next.customThemeOrder).toEqual([]);
    expect(next.customThemes).toEqual({});
  });

  it.each(["default", "readable", "compact", "terminal"])(
    "rejects mutation, rename, and deletion of built-in %s",
    (id) => {
      expect(() =>
        updateAppearanceTheme(DEFAULT_APPEARANCE_SETTINGS, id, { name: "Changed" }),
      ).toThrow(/Built-in/);
      expect(() => renameAppearanceTheme(DEFAULT_APPEARANCE_SETTINGS, id, "Changed")).toThrow(
        /Built-in/,
      );
      expect(() => deleteAppearanceTheme(DEFAULT_APPEARANCE_SETTINGS, id)).toThrow(/Built-in/);
    },
  );

  it("validates updates for colors, bounds, and contrast", () => {
    const state = stateWithThemes(customTheme());
    expect(() =>
      updateAppearanceTheme(state, "custom-ocean", {
        variants: { light: { accent: "#fff" } },
      }),
    ).toThrow(/shape/);
    expect(() => updateAppearanceTheme(state, "custom-ocean", { terminalFontSizePx: 100 })).toThrow(
      /shape/,
    );
    expect(() =>
      updateAppearanceTheme(state, "custom-ocean", {
        variants: { dark: { foreground: "#161616" } },
      }),
    ).toThrow(/contrast/);

    const next = updateAppearanceTheme(state, "custom-ocean", {
      density: "compact",
      variants: { light: { accent: "#234567" } },
    });
    expect(next.customThemes["custom-ocean"]?.density).toBe("compact");
    expect(next.customThemes["custom-ocean"]?.variants.light.accent).toBe("#234567");
    expect(state.customThemes["custom-ocean"]?.density).toBe("default");
  });

  it("sets mode and active theme, with unknown active ids as a no-op", () => {
    const state = stateWithThemes(customTheme());
    expect(setColorScheme(state, "light").colorScheme).toBe("light");
    expect(setActiveTheme(state, "default").activeThemeId).toBe("default");
    expect(setActiveTheme(state, "custom-missing")).toBe(state);
  });

  it("resets mode and active theme while preserving custom themes", () => {
    const state = stateWithThemes(customTheme());
    const next = resetAppearance(state);
    expect(next.colorScheme).toBe("system");
    expect(next.activeThemeId).toBe("default");
    expect(next.customThemes).toBe(state.customThemes);
    expect(next.customThemeOrder).toBe(state.customThemeOrder);
  });
});
