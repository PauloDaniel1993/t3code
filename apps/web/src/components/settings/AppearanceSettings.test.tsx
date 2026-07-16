import type { Dispatch, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  type AppearanceSettings as AppearanceSettingsState,
} from "@t3tools/contracts";

import { duplicateAppearanceTheme } from "../../appearance/appearanceOperations";

type ElementNode = {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
};

const store = vi.hoisted(() => ({
  appearance: null as AppearanceSettingsState | null,
  theme: "system" as "system" | "light" | "dark",
  updateAppearance: vi.fn(),
  setTheme: vi.fn(),
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];

  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useCallback<T>(callback: T): T {
      nextIndex();
      return callback;
    },
    useEffect() {
      nextIndex();
    },
    useMemo<T>(factory: () => T): T {
      nextIndex();
      return factory();
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: { appearance: AppearanceSettingsState }) => unknown) =>
    selector({ appearance: store.appearance! }),
  useUpdateAppearance: () => store.updateAppearance,
}));

vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: store.theme,
    resolvedTheme: "light" as const,
    setTheme: store.setTheme,
  }),
}));

import { AppearanceSettings } from "./AppearanceSettings";

function isElementNode(value: unknown): value is ElementNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "props" in value &&
    typeof (value as { props?: unknown }).props === "object"
  );
}

function walk(node: unknown, visit: (element: ElementNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isElementNode(node)) return;

  visit(node);
  walk(node.props.children, visit);
  walk(node.props.control, visit);
  walk(node.props.headerAction, visit);
}

function findElement(node: unknown, predicate: (element: ElementNode) => boolean): ElementNode {
  let match: ElementNode | undefined;
  walk(node, (element) => {
    if (!match && predicate(element)) match = element;
  });
  if (!match) throw new Error("Expected to find an element.");
  return match;
}

function componentName(element: ElementNode): string | undefined {
  return typeof element.type === "function" ? element.type.name : undefined;
}

function renderAppearanceSettings(): ElementNode {
  hooks.beginRender();
  return AppearanceSettings() as unknown as ElementNode;
}

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isElementNode(node)) return textContent(node.props.children);
  return "";
}

function renderColorControls(page: ElementNode, variantName: "light" | "dark"): ElementNode {
  const controls = findElement(
    page,
    (element) =>
      componentName(element) === "ColorVariantControls" &&
      element.props.variantName === variantName,
  );
  return (controls.type as (props: Record<string, unknown>) => ElementNode)(controls.props);
}

function renderPreview(page: ElementNode): ElementNode {
  const preview = findElement(page, (element) => componentName(element) === "AppearancePreview");
  return (preview.type as (props: Record<string, unknown>) => ElementNode)(preview.props);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  hooks.reset();
  store.appearance = DEFAULT_APPEARANCE_SETTINGS;
  store.theme = "system";
  store.updateAppearance.mockReset();
  store.updateAppearance.mockImplementation(
    (updater: (appearance: AppearanceSettingsState) => AppearanceSettingsState) => {
      store.appearance = updater(store.appearance!);
    },
  );
  store.setTheme.mockReset();
});

describe("AppearanceSettings", () => {
  it("renders the built-in themes in their required order", () => {
    const page = renderAppearanceSettings();
    const themeList = findElement(
      page,
      (element) => element.props["aria-label"] === "Appearance themes",
    );

    expect(textContent(themeList)).toContain(
      "DefaultBuilt-inReadableBuilt-inCompactBuilt-inTerminalBuilt-in",
    );
    expect(themeList.type).toBe("ul");

    const themeButton = findElement(
      themeList,
      (element) => element.type === "button" && element.props["aria-pressed"] !== undefined,
    );
    expect(themeButton.props.role).toBeUndefined();
    expect(themeButton.props["aria-pressed"]).toBe(true);
  });

  it("keeps built-in controls disabled while allowing duplication", () => {
    const page = renderAppearanceSettings();
    const duplicate = findElement(page, (element) => element.props.children === "Duplicate");
    const nameInput = findElement(
      page,
      (element) =>
        componentName(element) === "Input" && element.props.id === "appearance-theme-name",
    );
    const fontSlider = findElement(
      page,
      (element) => element.type === "input" && element.props.type === "range",
    );
    const colors = findElement(
      page,
      (element) =>
        componentName(element) === "ColorVariantControls" && element.props.variantName === "light",
    );

    expect(duplicate.props.disabled).toBeUndefined();
    expect(nameInput.props.disabled).toBe(true);
    expect(fontSlider.props.disabled).toBe(true);
    expect(colors.props.disabled).toBe(true);
  });

  it("duplicates the selected built-in into an active, editable custom theme", () => {
    const page = renderAppearanceSettings();
    const duplicate = findElement(page, (element) => element.props.children === "Duplicate");

    (duplicate.props.onClick as () => void)();

    expect(store.appearance!.activeThemeId).toMatch(/^custom-/);
    expect(store.appearance!.customThemes[store.appearance!.activeThemeId]).toBeDefined();

    const customPage = renderAppearanceSettings();
    const nameInput = findElement(
      customPage,
      (element) =>
        componentName(element) === "Input" && element.props.id === "appearance-theme-name",
    );
    const fontSlider = findElement(
      customPage,
      (element) => element.type === "input" && element.props.type === "range",
    );

    expect(nameInput.props.disabled).toBe(false);
    expect(fontSlider.props.disabled).toBe(false);
  });

  it("replays duplication against hydrated appearance instead of replacing it", () => {
    let capturedUpdater:
      | ((appearance: AppearanceSettingsState) => AppearanceSettingsState)
      | undefined;
    store.updateAppearance.mockImplementation(
      (updater: (appearance: AppearanceSettingsState) => AppearanceSettingsState) => {
        capturedUpdater = updater;
      },
    );
    const page = renderAppearanceSettings();
    const duplicate = findElement(page, (element) => element.props.children === "Duplicate");

    (duplicate.props.onClick as () => void)();

    const hydratedAppearance = duplicateAppearanceTheme(
      DEFAULT_APPEARANCE_SETTINGS,
      "default",
      () => "custom-persisted-theme",
    );
    const replayedAppearance = capturedUpdater!(hydratedAppearance);
    const duplicatedThemeId = replayedAppearance.activeThemeId;

    expect(replayedAppearance.customThemes["custom-persisted-theme"]).toBeDefined();
    expect(duplicatedThemeId).not.toBe("custom-persisted-theme");
    expect(replayedAppearance.customThemes[duplicatedThemeId]).toBeDefined();
    expect(replayedAppearance.customThemeOrder).toEqual([
      "custom-persisted-theme",
      duplicatedThemeId,
    ]);
  });

  it("replays a rename against the current appearance state", () => {
    const selectedThemeId = "custom-selected-theme";
    store.appearance = duplicateAppearanceTheme(
      store.appearance!,
      "default",
      () => selectedThemeId,
    );
    let capturedUpdater:
      | ((appearance: AppearanceSettingsState) => AppearanceSettingsState)
      | undefined;
    store.updateAppearance.mockImplementation(
      (updater: (appearance: AppearanceSettingsState) => AppearanceSettingsState) => {
        capturedUpdater = updater;
      },
    );
    const page = renderAppearanceSettings();
    const nameInput = findElement(
      page,
      (element) =>
        componentName(element) === "Input" && element.props.id === "appearance-theme-name",
    );

    (nameInput.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "Renamed theme" },
    });
    const renamedPage = renderAppearanceSettings();
    const rename = findElement(renamedPage, (element) => element.props.children === "Rename");
    (rename.props.onClick as () => void)();

    const hydratedAppearance = duplicateAppearanceTheme(
      store.appearance!,
      "default",
      () => "custom-persisted-theme",
    );
    const replayedAppearance = capturedUpdater!(hydratedAppearance);

    expect(replayedAppearance.customThemes["custom-persisted-theme"]).toBeDefined();
    expect(replayedAppearance.customThemes[selectedThemeId]!.name).toBe("Renamed theme");
  });

  it("replays a delete against the current appearance state", () => {
    const selectedThemeId = "custom-selected-theme";
    store.appearance = duplicateAppearanceTheme(
      store.appearance!,
      "default",
      () => selectedThemeId,
    );
    let capturedUpdater:
      | ((appearance: AppearanceSettingsState) => AppearanceSettingsState)
      | undefined;
    store.updateAppearance.mockImplementation(
      (updater: (appearance: AppearanceSettingsState) => AppearanceSettingsState) => {
        capturedUpdater = updater;
      },
    );
    const page = renderAppearanceSettings();
    const deleteButton = findElement(page, (element) => element.props.children === "Delete");

    (deleteButton.props.onClick as () => void)();

    const hydratedAppearance = duplicateAppearanceTheme(
      store.appearance!,
      "default",
      () => "custom-persisted-theme",
    );
    const replayedAppearance = capturedUpdater!(hydratedAppearance);

    expect(replayedAppearance.customThemes[selectedThemeId]).toBeUndefined();
    expect(replayedAppearance.customThemes["custom-persisted-theme"]).toBeDefined();
    expect(replayedAppearance.customThemeOrder).toEqual(["custom-persisted-theme"]);
  });

  it("validates and persists a custom mono font family", () => {
    const customThemeId = "custom-mono-theme";
    store.appearance = duplicateAppearanceTheme(store.appearance!, "default", () => customThemeId);
    const customTheme = store.appearance.customThemes[customThemeId]!;
    store.appearance = {
      ...store.appearance,
      customThemes: {
        ...store.appearance.customThemes,
        [customThemeId]: {
          ...customTheme,
          monoFontFamily: "Iosevka, Consolas, monospace",
        },
      },
    };

    const page = renderAppearanceSettings();
    const monoSelect = findElement(
      page,
      (element) => element.type === "select" && element.props.id === "appearance-mono-font",
    );
    const customMonoInput = findElement(
      page,
      (element) =>
        componentName(element) === "Input" && element.props.id === "appearance-mono-font-custom",
    );

    expect(textContent(monoSelect)).toContain("Custom");
    expect(customMonoInput.props.value).toBe("Iosevka, Consolas, monospace");

    (customMonoInput.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "   " },
    });

    expect(store.updateAppearance).not.toHaveBeenCalled();

    const invalidPage = renderAppearanceSettings();
    const invalidCustomMonoInput = findElement(
      invalidPage,
      (element) =>
        componentName(element) === "Input" && element.props.id === "appearance-mono-font-custom",
    );
    const invalidError = findElement(
      invalidPage,
      (element) => element.props.id === "appearance-mono-font-custom-error",
    );

    expect(invalidCustomMonoInput.props["aria-invalid"]).toBe(true);
    expect(textContent(invalidError)).toContain("Enter a mono font family.");

    (invalidCustomMonoInput.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "Iosevka, Consolas, monospace" },
    });

    expect(store.updateAppearance).toHaveBeenCalledTimes(1);
    expect(store.appearance!.customThemes[customThemeId]!.monoFontFamily).toBe(
      "Iosevka, Consolas, monospace",
    );
  });

  it("shows the current pixel value beside each font-size slider", () => {
    const page = renderAppearanceSettings();
    const fontSlider = findElement(
      page,
      (element) =>
        element.type === "input" &&
        element.props.type === "range" &&
        element.props.id === "appearance-uiFontSizePx-range",
    );

    expect(fontSlider.props.value).toBe(14);
  });

  it("shows invalid hex feedback without persisting the invalid value", () => {
    store.appearance = duplicateAppearanceTheme(
      store.appearance!,
      "default",
      () => "custom-default-theme",
    );
    const page = renderAppearanceSettings();
    const lightColors = renderColorControls(page, "light");
    const accentInput = findElement(
      lightColors,
      (element) =>
        componentName(element) === "Input" && element.props.id === "appearance-light-accent",
    );

    (accentInput.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "#fff" },
    });

    expect(store.updateAppearance).not.toHaveBeenCalled();

    const invalidPage = renderAppearanceSettings();
    const invalidLightColors = renderColorControls(invalidPage, "light");
    const invalidAccentInput = findElement(
      invalidLightColors,
      (element) =>
        componentName(element) === "Input" && element.props.id === "appearance-light-accent",
    );
    const invalidError = findElement(
      invalidLightColors,
      (element) => element.props.id === "appearance-light-accent-error",
    );

    expect(invalidAccentInput.props["aria-invalid"]).toBe(true);
    expect(textContent(invalidError)).toContain("six-digit hex color");
  });

  it("restores the default theme and system mode without deleting custom themes", () => {
    store.appearance = {
      ...duplicateAppearanceTheme(store.appearance!, "default", () => "custom-default-theme"),
      colorScheme: "dark",
    };
    store.theme = "dark";
    const originalCustomThemes = store.appearance.customThemes;
    const originalCustomThemeOrder = store.appearance.customThemeOrder;
    const localStorageValues = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => {
      localStorageValues.set(key, value);
    });
    vi.stubGlobal("window", { localStorage: { setItem } });
    store.setTheme.mockImplementation((colorScheme: "system" | "light" | "dark") => {
      window.localStorage.setItem("t3code:theme", colorScheme);
      store.theme = colorScheme;
      store.appearance = { ...store.appearance!, colorScheme };
    });

    const page = renderAppearanceSettings();
    const restore = findElement(
      page,
      (element) => element.props.children === "Restore appearance defaults",
    );
    (restore.props.onClick as () => void)();

    expect(store.setTheme).toHaveBeenCalledWith("system");
    expect(store.appearance).toMatchObject({ activeThemeId: "default", colorScheme: "system" });
    expect(store.appearance!.customThemes).toBe(originalCustomThemes);
    expect(store.appearance!.customThemeOrder).toBe(originalCustomThemeOrder);
    expect(setItem).toHaveBeenCalledWith("t3code:theme", "system");
  });

  it("deletes an active custom theme and returns to Default", () => {
    store.appearance = duplicateAppearanceTheme(
      store.appearance!,
      "default",
      () => "custom-default-theme",
    );
    const page = renderAppearanceSettings();
    const deleteButton = findElement(page, (element) => element.props.children === "Delete");

    (deleteButton.props.onClick as () => void)();

    expect(store.appearance!.activeThemeId).toBe("default");
    expect(store.appearance!.customThemeOrder).toEqual([]);
  });

  it("derives a dark primary foreground for a light preview accent", () => {
    const customThemeId = "custom-light-accent-theme";
    store.appearance = duplicateAppearanceTheme(store.appearance!, "default", () => customThemeId);
    const customTheme = store.appearance.customThemes[customThemeId]!;
    store.appearance = {
      ...store.appearance,
      customThemes: {
        ...store.appearance.customThemes,
        [customThemeId]: {
          ...customTheme,
          variants: {
            ...customTheme.variants,
            light: { ...customTheme.variants.light, accent: "#ffffff" },
          },
        },
      },
    };

    const preview = renderPreview(renderAppearanceSettings());
    const previewSurface = findElement(preview, (element) => {
      const style = element.props.style as Record<string, string> | undefined;
      return style?.["--primary-foreground"] !== undefined;
    });

    expect((previewSurface.props.style as Record<string, string>)["--primary-foreground"]).toBe(
      "#111111",
    );
  });

  it("includes all required samples in the appearance preview", () => {
    const page = renderAppearanceSettings();
    const preview = renderPreview(page);

    for (const testId of [
      "appearance-preview-settings",
      "appearance-preview-chat",
      "appearance-preview-code",
      "appearance-preview-diff",
      "appearance-preview-terminal",
    ]) {
      expect(
        findElement(preview, (element) => element.props["data-testid"] === testId),
      ).toBeDefined();
    }
    expect(
      findElement(preview, (element) => element.props.children === "Primary action"),
    ).toBeDefined();
  });
});
