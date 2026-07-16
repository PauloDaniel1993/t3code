import {
  DEFAULT_APPEARANCE_SETTINGS,
  type AppearanceSettings,
  type AppearanceTheme,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  APPEARANCE_MANAGED_SEMANTIC_PROPERTIES,
  applyAppearanceToDocument,
  DEFAULT_APPEARANCE_APP_PROPERTY_VALUES,
} from "./applyAppearance.ts";
import { contrastRatio } from "./appearanceContrast.ts";
import { deriveVariantTokens } from "./appearanceDerived.ts";
import { BUILT_IN_APPEARANCE_THEMES } from "./appearanceThemes.ts";

class StyleDeclarationStub {
  readonly values = new Map<string, string>();

  getPropertyValue(property: string): string {
    return this.values.get(property) ?? "";
  }

  removeProperty(property: string): string {
    const previous = this.getPropertyValue(property);
    this.values.delete(property);
    return previous;
  }

  setProperty(property: string, value: string): void {
    this.values.set(property, value);
  }
}

function installDocument() {
  const style = new StyleDeclarationStub();
  vi.stubGlobal("document", {
    documentElement: { style },
  });
  return style;
}

function customAppearance(): AppearanceSettings {
  const source = BUILT_IN_APPEARANCE_THEMES.default;
  const theme: AppearanceTheme = {
    ...source,
    id: "custom-ocean-test",
    name: "Ocean",
    variants: {
      light: {
        ...source.variants.light,
        accent: "#123456",
        background: "#f0f4f8",
        foreground: "#101820",
        surface: "#ffffff",
        muted: "#d9e2ec",
      },
      dark: {
        ...source.variants.dark,
        accent: "#abcdef",
        background: "#101820",
        foreground: "#f0f4f8",
        surface: "#18222c",
        muted: "#243447",
      },
    },
  };
  return {
    colorScheme: "system",
    activeThemeId: theme.id,
    customThemeOrder: [theme.id],
    customThemes: { [theme.id]: theme },
  };
}

function defaultDuplicateAppearance(): AppearanceSettings {
  const source = BUILT_IN_APPEARANCE_THEMES.default;
  const theme: AppearanceTheme = {
    ...source,
    id: "custom-default-copy-test",
    name: "Default copy",
    variants: {
      light: { ...source.variants.light },
      dark: { ...source.variants.dark },
    },
  };
  return {
    colorScheme: "system",
    activeThemeId: theme.id,
    customThemeOrder: [theme.id],
    customThemes: { [theme.id]: theme },
  };
}

function semanticState(style: StyleDeclarationStub): Record<string, string> {
  return Object.fromEntries(
    APPEARANCE_MANAGED_SEMANTIC_PROPERTIES.map((property) => [
      property,
      style.getPropertyValue(property),
    ]),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyAppearanceToDocument", () => {
  it("sets baseline app properties and clears all semantic overrides for Default", () => {
    const style = installDocument();
    for (const property of APPEARANCE_MANAGED_SEMANTIC_PROPERTIES) {
      style.setProperty(property, "stale");
    }

    applyAppearanceToDocument(DEFAULT_APPEARANCE_SETTINGS, "light");

    for (const [property, value] of Object.entries(DEFAULT_APPEARANCE_APP_PROPERTY_VALUES)) {
      expect(style.getPropertyValue(property)).toBe(value);
    }
    for (const property of APPEARANCE_MANAGED_SEMANTIC_PROPERTIES) {
      expect(style.getPropertyValue(property)).toBe("");
    }
  });

  it.each(["readable", "compact", "terminal"] as const)(
    "clears semantic overrides while applying %s typography from the baseline variants",
    (activeThemeId) => {
      const style = installDocument();
      const theme = BUILT_IN_APPEARANCE_THEMES[activeThemeId];
      for (const property of APPEARANCE_MANAGED_SEMANTIC_PROPERTIES) {
        style.setProperty(property, "stale");
      }

      applyAppearanceToDocument({ ...DEFAULT_APPEARANCE_SETTINGS, activeThemeId }, "light");

      for (const property of APPEARANCE_MANAGED_SEMANTIC_PROPERTIES) {
        expect(style.getPropertyValue(property)).toBe("");
      }
      expect(style.getPropertyValue("--app-ui-font-family")).toBe(theme.uiFontFamily);
      expect(style.getPropertyValue("--app-mono-font-family")).toBe(theme.monoFontFamily);
      expect(style.getPropertyValue("--app-terminal-font-family")).toBe(theme.terminalFontFamily);
      expect(style.getPropertyValue("--app-ui-font-size")).toBe(`${theme.uiFontSizePx}px`);
      expect(style.getPropertyValue("--app-chat-font-size")).toBe(`${theme.chatFontSizePx}px`);
      expect(style.getPropertyValue("--app-code-font-size")).toBe(`${theme.codeFontSizePx}px`);
      expect(style.getPropertyValue("--app-terminal-font-size")).toBe(
        `${theme.terminalFontSizePx}px`,
      );
      expect(style.getPropertyValue("--app-density-scale")).toBe(
        theme.density === "compact" ? "0.85" : theme.density === "comfortable" ? "1.2" : "1",
      );
    },
  );

  it("treats a pristine Default duplicate as semantically baseline-equivalent", () => {
    const style = installDocument();
    for (const property of APPEARANCE_MANAGED_SEMANTIC_PROPERTIES) {
      style.setProperty(property, "stale");
    }
    applyAppearanceToDocument(DEFAULT_APPEARANCE_SETTINGS, "light");
    const defaultSemanticState = semanticState(style);

    for (const property of APPEARANCE_MANAGED_SEMANTIC_PROPERTIES) {
      style.setProperty(property, "stale");
    }
    style.setProperty("--app-ui-font-size", "stale");
    const duplicate = defaultDuplicateAppearance();

    applyAppearanceToDocument(duplicate, "light");

    expect(semanticState(style)).toEqual(defaultSemanticState);
    for (const property of APPEARANCE_MANAGED_SEMANTIC_PROPERTIES) {
      expect(style.getPropertyValue(property)).toBe("");
    }
    expect(style.getPropertyValue("--app-ui-font-size")).toBe("14px");
    expect(style.getPropertyValue("--app-density-scale")).toBe("1");
  });

  it("applies custom typography, density, and the static semantic allowlist", () => {
    const style = installDocument();
    const appearance = customAppearance();
    const theme = appearance.customThemes[appearance.activeThemeId]!;
    const variant = theme.variants.light;
    const derived = deriveVariantTokens(variant);

    applyAppearanceToDocument(appearance, "light");

    expect(style.getPropertyValue("--app-ui-font-family")).toBe(theme.uiFontFamily);
    expect(style.getPropertyValue("--app-ui-font-size")).toBe("14px");
    expect(style.getPropertyValue("--app-density-scale")).toBe("1");
    expect(style.getPropertyValue("--background")).toBe(variant.background);
    expect(style.getPropertyValue("--primary")).toBe(variant.accent);
    expect(style.getPropertyValue("--primary-foreground")).toBe(derived.primaryForeground);
    expect(style.getPropertyValue("--border")).toBe(derived.border);
    expect(style.getPropertyValue("--app-chrome-background")).toBe(derived.chromeBackground);
    expect([...style.values.keys()].filter((property) => property.startsWith("--"))).toEqual(
      expect.arrayContaining([...APPEARANCE_MANAGED_SEMANTIC_PROPERTIES]),
    );
  });

  it("applies readable neutral accent and secondary pairs for custom variants", () => {
    const style = installDocument();
    const appearance = customAppearance();
    const theme = appearance.customThemes[appearance.activeThemeId]!;

    for (const scheme of ["light", "dark"] as const) {
      const variant = theme.variants[scheme];
      const derived = deriveVariantTokens(variant);

      applyAppearanceToDocument(appearance, scheme);

      expect(style.getPropertyValue("--accent")).toBe(derived.accent);
      expect(style.getPropertyValue("--accent-foreground")).toBe(variant.foreground);
      expect(style.getPropertyValue("--secondary")).toBe(variant.muted);
      expect(style.getPropertyValue("--secondary-foreground")).toBe(derived.secondaryForeground);
      expect(
        contrastRatio(
          style.getPropertyValue("--accent-foreground"),
          style.getPropertyValue("--accent"),
        ),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(
          style.getPropertyValue("--secondary-foreground"),
          style.getPropertyValue("--secondary"),
        ),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("applies semantic tokens after a Default duplicate's variant is edited", () => {
    const style = installDocument();
    const duplicate = defaultDuplicateAppearance();
    const original = duplicate.customThemes[duplicate.activeThemeId]!;
    const editedTheme: AppearanceTheme = {
      ...original,
      variants: {
        ...original.variants,
        light: { ...original.variants.light, accent: "#234567" },
      },
    };
    const editedAppearance: AppearanceSettings = {
      ...duplicate,
      customThemes: { [editedTheme.id]: editedTheme },
    };

    applyAppearanceToDocument(editedAppearance, "light");

    for (const property of APPEARANCE_MANAGED_SEMANTIC_PROPERTIES) {
      expect(style.getPropertyValue(property)).not.toBe("");
    }
    expect(style.getPropertyValue("--accent")).toBe(
      deriveVariantTokens(editedTheme.variants.light).accent,
    );
  });

  it("selects semantic colors from the resolved light or dark variant", () => {
    const style = installDocument();
    const appearance = customAppearance();
    const theme = appearance.customThemes[appearance.activeThemeId]!;

    applyAppearanceToDocument(appearance, "light");
    expect(style.getPropertyValue("--background")).toBe(theme.variants.light.background);

    applyAppearanceToDocument(appearance, "dark");
    expect(style.getPropertyValue("--background")).toBe(theme.variants.dark.background);
    expect(style.getPropertyValue("--primary")).toBe(theme.variants.dark.accent);
  });

  it("never changes status semantic colors", () => {
    const style = installDocument();
    const statusProperties = ["--success", "--warning", "--destructive", "--info"];
    for (const property of statusProperties) {
      style.setProperty(property, `original-${property}`);
    }

    applyAppearanceToDocument(customAppearance(), "dark");

    for (const property of statusProperties) {
      expect(style.getPropertyValue(property)).toBe(`original-${property}`);
    }
  });

  it("is safe without a document", () => {
    expect(() => applyAppearanceToDocument(customAppearance(), "dark")).not.toThrow();
  });
});
