import {
  APPEARANCE_FONT_SIZE_BOUNDS,
  DEFAULT_APPEARANCE_SETTINGS,
  type AppearanceSettings,
  type AppearanceTheme,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { BUILT_IN_APPEARANCE_THEMES } from "../../appearance/appearanceThemes.ts";
import {
  APPEARANCE_MONO_FONT_OPTIONS,
  APPEARANCE_UI_FONT_OPTIONS,
  buildThemeListModel,
  clampFontSize,
  createDebouncedCommit,
  validateHexInput,
} from "./AppearanceSettings.logic.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("Appearance settings logic", () => {
  it("clamps every font size kind to its contract bounds", () => {
    for (const [kind, bounds] of Object.entries(APPEARANCE_FONT_SIZE_BOUNDS)) {
      const typedKind = kind as keyof typeof APPEARANCE_FONT_SIZE_BOUNDS;
      expect(clampFontSize(typedKind, bounds.min - 5)).toBe(bounds.min);
      expect(clampFontSize(typedKind, bounds.max + 5)).toBe(bounds.max);
      expect(clampFontSize(typedKind, bounds.min + 0.5)).toBe(bounds.min + 0.5);
      expect(clampFontSize(typedKind, Number.NaN)).toBe(bounds.default);
    }
  });

  it("debounces to the latest value and supports explicit flush", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const debounced = createDebouncedCommit(commit, 400);

    debounced.set(1);
    vi.advanceTimersByTime(300);
    debounced.set(2);
    vi.advanceTimersByTime(399);
    expect(commit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenLastCalledWith(2);

    debounced.set(3);
    debounced.flush();
    expect(commit).toHaveBeenLastCalledWith(3);
    vi.runAllTimers();
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("can cancel or flush the pending value during unmount cleanup", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const debounced = createDebouncedCommit(commit);

    debounced.set("cancelled");
    debounced.cancel();
    vi.runAllTimers();
    expect(commit).not.toHaveBeenCalled();

    debounced.set("unmounted");
    debounced.flushOnUnmount();
    expect(commit).toHaveBeenCalledWith("unmounted");
    vi.runAllTimers();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("validates strict six-digit hex input", () => {
    expect(validateHexInput("#1b4eD8")).toEqual({ ok: true });
    expect(validateHexInput("#fff")).toEqual({
      ok: false,
      error: "Enter a six-digit hex color in #RRGGBB format.",
    });
    expect(validateHexInput(" #ffffff").ok).toBe(false);
  });

  it("provides the curated UI and mono font options", () => {
    expect(APPEARANCE_UI_FONT_OPTIONS.map((option) => option.label)).toEqual([
      "Default",
      "Atkinson Hyperlegible",
      "System UI",
    ]);
    expect(APPEARANCE_MONO_FONT_OPTIONS.map((option) => option.label)).toEqual([
      "Default",
      "JetBrains Mono",
      "System Mono",
    ]);
  });

  it("orders built-ins before custom themes and marks the active item", () => {
    const source = BUILT_IN_APPEARANCE_THEMES.default;
    const first: AppearanceTheme = {
      ...source,
      id: "custom-first-theme",
      name: "First",
      variants: {
        light: { ...source.variants.light },
        dark: { ...source.variants.dark },
      },
    };
    const second: AppearanceTheme = {
      ...first,
      id: "custom-second-theme",
      name: "Second",
    };
    const appearance: AppearanceSettings = {
      ...DEFAULT_APPEARANCE_SETTINGS,
      activeThemeId: second.id,
      customThemeOrder: [second.id, first.id],
      customThemes: { [first.id]: first, [second.id]: second },
    };

    expect(buildThemeListModel(appearance)).toEqual([
      { id: "default", name: "Default", isBuiltIn: true, isActive: false },
      { id: "readable", name: "Readable", isBuiltIn: true, isActive: false },
      { id: "compact", name: "Compact", isBuiltIn: true, isActive: false },
      { id: "terminal", name: "Terminal", isBuiltIn: true, isActive: false },
      { id: second.id, name: "Second", isBuiltIn: false, isActive: true },
      { id: first.id, name: "First", isBuiltIn: false, isActive: false },
    ]);
  });
});
