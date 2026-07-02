import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_APPEARANCE_SETTINGS } from "@t3tools/contracts/settings";
import indexCss from "../index.css?raw";
import {
  BUILT_IN_APPEARANCE_THEMES,
  duplicateAppearanceTheme,
  setCustomAppearanceThemeVariantColor,
} from "./appearanceThemes";
import { applyAppearanceCssVariables, createAppearanceCssVariables } from "./appearanceCss";

const INDEX_CSS = indexCss;

function createRootStub(): HTMLElement & {
  readonly styles: Map<string, string>;
  readonly dataset: Record<string, string>;
} {
  const styles = new Map<string, string>();
  const dataset: Record<string, string> = {};
  return {
    dataset,
    styles,
    style: {
      getPropertyValue: (name: string) => styles.get(name) ?? "",
      removeProperty: (name: string) => {
        const value = styles.get(name) ?? "";
        styles.delete(name);
        return value;
      },
      setProperty: (name: string, value: string) => {
        styles.set(name, value);
      },
    },
  } as HTMLElement & {
    readonly styles: Map<string, string>;
    readonly dataset: Record<string, string>;
  };
}

function normalizeCssValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readCustomProperties(block: string): Record<string, string> {
  const properties: Record<string, string> = {};
  const declarationPattern = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  for (const match of block.matchAll(declarationPattern)) {
    const [, name, value] = match;
    if (name && value) {
      properties[name] = normalizeCssValue(value);
    }
  }
  return properties;
}

function readThemeProperties(): Record<string, string> {
  const themeStart = INDEX_CSS.indexOf("@theme inline");
  const themeOpen = INDEX_CSS.indexOf("{", themeStart);
  const themeEnd = INDEX_CSS.indexOf("@keyframes skeleton", themeOpen);
  return readCustomProperties(INDEX_CSS.slice(themeOpen + 1, themeEnd));
}

function readRootAppearanceProperties(): Record<string, string> {
  const colorSchemeIndex = INDEX_CSS.indexOf("color-scheme: light;");
  const rootStart = INDEX_CSS.lastIndexOf(":root", colorSchemeIndex);
  const rootOpen = INDEX_CSS.indexOf("{", rootStart);
  const rootDarkVariantStart = INDEX_CSS.indexOf("@variant dark", rootOpen);
  return readCustomProperties(INDEX_CSS.slice(rootOpen + 1, rootDarkVariantStart));
}

describe("appearance css variables", () => {
  it("aliases Tailwind font tokens to appearance font variables", () => {
    const themeProperties = readThemeProperties();

    expect(themeProperties["--font-sans"]).toBe("var(--app-ui-font-family)");
    expect(themeProperties["--font-mono"]).toBe("var(--app-mono-font-family)");
  });

  it("routes custom mono font themes through the font-mono token chain", () => {
    const appearance = duplicateAppearanceTheme(DEFAULT_APPEARANCE_SETTINGS, "default", {
      id: "custom_mono",
      name: "Mono",
    });
    const customTheme = appearance.customThemes.custom_mono;
    if (!customTheme) {
      throw new Error("Expected duplicateAppearanceTheme to create custom_mono.");
    }
    const withCustomMono = {
      ...appearance,
      customThemes: {
        ...appearance.customThemes,
        custom_mono: {
          ...customTheme,
          monoFontFamily: '"Commit Mono", monospace',
        },
      },
    };
    const result = createAppearanceCssVariables(withCustomMono, "light");
    const themeProperties = readThemeProperties();

    expect(result.variables["--app-mono-font-family"]).toBe('"Commit Mono", monospace');
    expect(themeProperties["--font-mono"]).toBe("var(--app-mono-font-family)");
  });

  it("binds root appearance defaults to the built-in Default theme", () => {
    const rootProperties = readRootAppearanceProperties();
    const defaultTheme = BUILT_IN_APPEARANCE_THEMES.default;

    expect(rootProperties["--app-ui-font-family"]).toBe(
      normalizeCssValue(defaultTheme.uiFontFamily),
    );
    expect(rootProperties["--app-mono-font-family"]).toBe(
      normalizeCssValue(defaultTheme.monoFontFamily),
    );
    expect(rootProperties["--app-terminal-font-family"]).toBe(
      normalizeCssValue(defaultTheme.terminalFontFamily),
    );
    expect(rootProperties["--app-ui-font-size"]).toBe(`${defaultTheme.uiFontSizePx}px`);
    expect(rootProperties["--app-chat-font-size"]).toBe(`${defaultTheme.chatFontSizePx}px`);
    expect(rootProperties["--app-code-font-size"]).toBe(`${defaultTheme.codeFontSizePx}px`);
    expect(rootProperties["--app-terminal-font-size"]).toBe(`${defaultTheme.terminalFontSizePx}px`);
    expect(rootProperties["--app-density-scale"]).toBe("1");
    expect(rootProperties["--app-density-gap"]).toBe("0.5rem");
    expect(rootProperties["--app-density-padding-y"]).toBe("0.5rem");
  });

  it("keeps the built-in Default visual baseline by not overriding core colors", () => {
    const result = createAppearanceCssVariables(DEFAULT_APPEARANCE_SETTINGS, "dark");

    expect(result.appliesCoreColors).toBe(false);
    expect(result.activeThemeId).toBe("default");
    expect(result.variables["--app-ui-font-size"]).toBe("14px");
    expect(result.variables).not.toHaveProperty("--background");
    expect(result.variables).not.toHaveProperty("--primary");
  });

  it("applies typography while clearing prior managed core color overrides for Default", () => {
    const root = createRootStub();
    root.style.setProperty("--background", "#000000");
    root.style.setProperty("--primary", "#000000");

    applyAppearanceCssVariables(root, DEFAULT_APPEARANCE_SETTINGS, "light");

    expect(root.style.getPropertyValue("--app-chat-font-size")).toBe("14px");
    expect(root.style.getPropertyValue("--background")).toBe("");
    expect(root.style.getPropertyValue("--primary")).toBe("");
    expect(root.dataset.appearanceTheme).toBe("default");
    expect(root.dataset.appearanceCoreColors).toBe("default");
  });

  it("applies custom theme core colors and derived foregrounds", () => {
    const appearance = setCustomAppearanceThemeVariantColor(
      duplicateAppearanceTheme(DEFAULT_APPEARANCE_SETTINGS, "default", {
        id: "custom_accessible",
        name: "Accessible",
      }),
      "custom_accessible",
      "light",
      "accent",
      "#2563eb",
    );

    const result = createAppearanceCssVariables(appearance, "light");

    expect(result.appliesCoreColors).toBe(true);
    expect(result.activeThemeId).toBe("custom_accessible");
    expect(result.variables["--primary"]).toBe("#2563EB");
    expect(result.variables["--primary-foreground"]).toBe("#FFFFFF");
    expect(result.variables["--accent"]).toBe("color-mix(in srgb, #262626 4%, transparent)");
    expect(result.variables["--ring"]).toBe("#2563EB");
  });
});
