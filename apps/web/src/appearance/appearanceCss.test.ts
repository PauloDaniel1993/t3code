import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_APPEARANCE_SETTINGS } from "@t3tools/contracts/settings";
import { duplicateAppearanceTheme, setCustomAppearanceThemeVariantColor } from "./appearanceThemes";
import { applyAppearanceCssVariables, createAppearanceCssVariables } from "./appearanceCss";

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

describe("appearance css variables", () => {
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
