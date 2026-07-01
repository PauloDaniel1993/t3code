import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { duplicateAppearanceTheme } from "~/appearance/appearanceThemes";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

async function renderAppearanceSettings(settings: UnifiedSettings = DEFAULT_UNIFIED_SETTINGS) {
  vi.doMock("~/hooks/useSettings", () => ({
    usePrimarySettings: () => settings,
    useUpdatePrimarySettings: () => vi.fn(),
  }));
  vi.doMock("~/hooks/useTheme", () => ({
    useTheme: () => ({
      theme: settings.appearance.colorScheme,
      resolvedTheme: "dark",
      setTheme: vi.fn(),
    }),
  }));
  vi.doMock("~/localApi", () => ({
    ensureLocalApi: () => ({ dialogs: { confirm: vi.fn().mockResolvedValue(true) } }),
    readLocalApi: () => null,
  }));

  const { AppearanceSettingsPanel } = await import("./AppearanceSettings");
  return renderToStaticMarkup(<AppearanceSettingsPanel />);
}

describe("Appearance settings", () => {
  it("adds Appearance after General in settings navigation", async () => {
    const { SETTINGS_NAV_ITEMS } = await import("./SettingsSidebarNav");

    expect(SETTINGS_NAV_ITEMS.slice(0, 2).map((item) => item.label)).toEqual([
      "General",
      "Appearance",
    ]);
    expect(SETTINGS_NAV_ITEMS[1]?.to).toBe("/settings/appearance");
  });

  it("renders built-in themes as read-only with a copy action", async () => {
    const html = await renderAppearanceSettings();

    expect(html).toContain("Active theme");
    expect(html).toContain("Built-in themes are read-only templates.");
    expect(html).toContain("Create editable copy");
    expect(html).toContain("UI font size");
    expect(html).toContain('aria-label="UI font size value"');
    expect(html).not.toContain('aria-label="Theme mode"');
    expect(html).toContain('type="color"');
    expect(html).toContain("14");
    expect(html).not.toContain("Delete theme");
  });

  it("renders custom theme lifecycle and edit controls", async () => {
    const appearance = duplicateAppearanceTheme(DEFAULT_UNIFIED_SETTINGS.appearance, "default", {
      id: "custom_default",
      name: "Default copy",
    });
    const html = await renderAppearanceSettings({
      ...DEFAULT_UNIFIED_SETTINGS,
      appearance,
    });

    expect(html).toContain("Default copy");
    expect(html).toContain("Delete theme");
    expect(html).toContain("Accent swatches");
    expect(html).toContain("Background");
    expect(html).toContain("#181818");
  });
});
