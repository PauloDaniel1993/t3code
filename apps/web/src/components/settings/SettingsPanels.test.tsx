import { DEFAULT_APPEARANCE_SETTINGS } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { AppearanceSettings, UnifiedSettings } from "@t3tools/contracts/settings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { duplicateAppearanceTheme } from "../../appearance/appearanceOperations";

type ElementNode = {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
};

const state = vi.hoisted(() => ({
  atomValueCalls: 0,
  settings: null as UnifiedSettings | null,
}));

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  updateSettings: vi.fn(),
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
    useState<T>(initialValue: T | (() => T)): [T, () => void] {
      nextIndex();
      return [
        typeof initialValue === "function" ? (initialValue as () => T)() : initialValue,
        () => {},
      ];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => {
    state.atomValueCalls += 1;
    return state.atomValueCalls === 1 ? undefined : [];
  },
}));

vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => state.settings!,
  useUpdatePrimarySettings: () => mocks.updateSettings,
}));

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }),
  readLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }),
}));

import { GeneralSettingsPanel, useSettingsRestore } from "./SettingsPanels";

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

function hasElement(node: unknown, predicate: (element: ElementNode) => boolean): boolean {
  let found = false;
  walk(node, (element) => {
    found ||= predicate(element);
  });
  return found;
}

function renderGeneralSettings(): ElementNode {
  hooks.beginRender();
  return GeneralSettingsPanel() as unknown as ElementNode;
}

function renderGeneralSettingsRestore() {
  hooks.beginRender();
  return useSettingsRestore();
}

beforeEach(() => {
  state.atomValueCalls = 0;
  hooks.reset();
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.updateSettings.mockReset();
  state.settings = DEFAULT_UNIFIED_SETTINGS;
});

describe("GeneralSettingsPanel", () => {
  it("does not render the Theme control while retaining non-appearance General settings", () => {
    const page = renderGeneralSettings();

    expect(hasElement(page, (element) => element.props.title === "Time format")).toBe(true);
    expect(hasElement(page, (element) => element.props.title === "Theme")).toBe(false);
    expect(hasElement(page, (element) => element.props["aria-label"] === "Theme preference")).toBe(
      false,
    );
  });
});

describe("useSettingsRestore", () => {
  it("does not modify Appearance or custom themes when restoring General settings", async () => {
    const appearance: AppearanceSettings = duplicateAppearanceTheme(
      DEFAULT_APPEARANCE_SETTINGS,
      "default",
      () => "custom-general-restore",
    );
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      timestampFormat: "24-hour",
      appearance,
    };

    const { changedSettingLabels, restoreDefaults } = renderGeneralSettingsRestore();
    await restoreDefaults();

    expect(changedSettingLabels).toEqual(["Time format"]);
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.updateSettings).toHaveBeenCalledOnce();
    expect(mocks.updateSettings.mock.calls[0]?.[0]).not.toHaveProperty("appearance");
    expect(state.settings.appearance).toBe(appearance);
    expect(state.settings.appearance.customThemes).toBe(appearance.customThemes);
    expect(state.settings.appearance.customThemeOrder).toBe(appearance.customThemeOrder);
  });
});
