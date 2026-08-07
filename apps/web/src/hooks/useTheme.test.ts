import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

function mockSettingsStore(
  initialMode: "light" | "dark" | "system",
  hydrated: boolean,
  appearanceOverrides: Partial<typeof DEFAULT_CLIENT_SETTINGS.appearance> = {},
) {
  let settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    appearance: {
      ...DEFAULT_CLIENT_SETTINGS.appearance,
      colorScheme: initialMode,
      ...appearanceOverrides,
    },
  };
  const updateAppearance = vi.fn(
    (updater: (appearance: typeof settings.appearance) => typeof settings.appearance) => {
      settings = { ...settings, appearance: updater(settings.appearance) };
    },
  );
  const reconcileAppearanceColorScheme = vi.fn((colorScheme: typeof initialMode) => {
    settings = { ...settings, appearance: { ...settings.appearance, colorScheme } };
  });
  vi.doMock("./useSettings", () => ({
    reconcileAppearanceColorScheme,
    updateAppearance,
    useClientSettings: <T>(selector: (value: typeof settings) => T) => selector(settings),
    useClientSettingsHydrated: () => hydrated,
  }));
  return {
    get settings() {
      return settings;
    },
    reconcileAppearanceColorScheme,
    updateAppearance,
  };
}

function installHookReactMock() {
  let subscribeToTheme: ((listener: () => void) => () => void) | undefined;
  vi.doMock("react", () => ({
    useCallback: <A>(callback: A) => callback,
    useEffect: (effect: () => void) => {
      effect();
    },
    useSyncExternalStore: (
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => unknown,
    ) => {
      subscribeToTheme = subscribe;
      return getSnapshot();
    },
  }));
  return {
    get subscribeToTheme() {
      return subscribeToTheme;
    },
  };
}

function classListStub() {
  return {
    add: vi.fn(),
    remove: vi.fn(),
    toggle: vi.fn(),
  };
}

function documentElementStub() {
  const classList = classListStub();
  const style = {
    backgroundColor: "",
    removeProperty: vi.fn(),
    setProperty: vi.fn(),
  };
  return {
    classList,
    element: {
      classList,
      dataset: {} as Record<string, string>,
      offsetHeight: 1,
      style,
    },
    style,
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.doUnmock("./useSettings");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme failure handling", () => {
  it("preserves exact storage causes and operation context", async () => {
    const readCause = new Error("storage read blocked");
    const writeCause = new Error("storage quota exceeded");
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw readCause;
        },
        setItem: () => {
          throw writeCause;
        },
      }),
    });

    const { readThemePreference, ThemeStorageError, writeThemePreference } =
      await import("./useTheme");

    try {
      readThemePreference();
      expect.unreachable("expected the theme read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "t3code:theme",
        cause: readCause,
      });
    }

    try {
      writeThemePreference("dark");
      expect.unreachable("expected the theme write to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "write",
        storageKey: "t3code:theme",
        theme: "dark",
        cause: writeCause,
      });
    }
  });

  it("reads the persisted T3 Chat theme preference", async () => {
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => "t3-chat",
      }),
    });

    const { readThemePreference } = await import("./useTheme");

    expect(readThemePreference()).toBe("t3-chat");
  });

  it("falls back during initial theme application and logs only safe attributes", async () => {
    const cause = new Error("private browsing storage failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw cause;
        },
      }),
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle: vi.fn() },
      },
    });

    await expect(import("./useTheme")).resolves.toBeDefined();

    expect(errorLog).toHaveBeenCalledWith(
      "Failed to read theme preference for t3code:theme.",
      expect.objectContaining({
        operation: "read",
        storageKey: "t3code:theme",
        errorTag: "ThemeStorageError",
      }),
    );
    const attributes = errorLog.mock.calls[0]?.[1];
    expect(attributes).not.toHaveProperty("cause");
    expect(JSON.stringify(attributes)).not.toContain(cause.message);
  });

  it("retries a failed storage read only after a relevant storage event", async () => {
    const cause = new Error("persistent storage failure");
    const themeGetItem = vi.fn((): string | null => {
      throw cause;
    });
    const getItem = vi.fn((key: string) => (key === "t3code:theme" ? themeGetItem() : null));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let readSnapshot: (() => unknown) | undefined;
    let subscribeToTheme: ((listener: () => void) => () => void) | undefined;
    let storageHandler: ((event: StorageEvent) => void) | undefined;
    mockSettingsStore("system", false);
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => {
        subscribeToTheme = subscribe;
        readSnapshot = getSnapshot;
        return getSnapshot();
      },
    }));
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === "storage") storageHandler = listener;
      },
      localStorage: createStorage({ getItem }),
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });

    const { useTheme } = await import("./useTheme");
    useTheme();
    readSnapshot?.();
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);

    const unsubscribe = subscribeToTheme?.(() => undefined);
    storageHandler?.({ key: "t3code:theme" } as StorageEvent);
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(2);
    unsubscribe?.();
  });

  it("preserves desktop sync causes and retries after a failed cosmetic sync", async () => {
    const cause = new Error("desktop IPC unavailable");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const setTheme = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", { desktopBridge: { setTheme } });

    const { DesktopThemeSyncError, syncDesktopTheme, syncDesktopThemePreference } =
      await import("./useTheme");

    const error = await syncDesktopThemePreference({ setTheme }, "dark").then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DesktopThemeSyncError);
    expect(error).toMatchObject({ theme: "dark", cause });

    setTheme.mockClear();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();

    expect(setTheme).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to sync the dark theme to the desktop shell.",
      expect.objectContaining({
        theme: "dark",
        errorTag: "DesktopThemeSyncError",
      }),
    );
    for (const [, attributes] of errorLog.mock.calls) {
      expect(attributes).not.toHaveProperty("cause");
      expect(JSON.stringify(attributes)).not.toContain(cause.message);
    }
  });
});

describe("contract appearance compatibility", () => {
  it("uses the contract color scheme when no modular preference has been persisted", async () => {
    const store = mockSettingsStore("dark", true);
    installHookReactMock();
    const localStorage = createStorage();
    const setItem = vi.spyOn(localStorage, "setItem");
    const { classList, element } = documentElementStub();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      localStorage,
      matchMedia: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", { documentElement: element });

    const { useTheme } = await import("./useTheme");
    useTheme();

    expect(setItem).toHaveBeenCalledWith("t3code:theme-appearance-mode", "dark");
    expect(store.updateAppearance).not.toHaveBeenCalled();
    expect(classList.toggle).toHaveBeenCalledWith("dark", true);
  });

  it("lets an explicit modular preference reconcile the contract without a persistence echo", async () => {
    const store = mockSettingsStore("dark", true);
    installHookReactMock();
    const localStorage = createStorage();
    localStorage.setItem("t3code:theme-appearance-mode", "light");
    const setItem = vi.spyOn(localStorage, "setItem");
    const { element } = documentElementStub();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      localStorage,
      matchMedia: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", { documentElement: element });

    const { useTheme } = await import("./useTheme");
    useTheme();

    expect(store.settings.appearance.colorScheme).toBe("light");
    expect(store.updateAppearance).toHaveBeenCalledOnce();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("exposes the resolved contract density without owning theme colors", async () => {
    mockSettingsStore("system", true, { activeThemeId: "compact" });
    installHookReactMock();
    const localStorage = createStorage();
    const { element, style } = documentElementStub();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      localStorage,
      matchMedia: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", { documentElement: element });

    const { useTheme } = await import("./useTheme");
    useTheme();

    expect(element.dataset.appearanceDensity).toBe("compact");
    expect(style.setProperty).toHaveBeenCalledWith("--app-density-scale", "0.85");
  });

  it("reconciles modular appearance storage events without a persistence echo", async () => {
    const store = mockSettingsStore("system", true);
    const react = installHookReactMock();
    const localStorage = createStorage();
    const setItem = vi.spyOn(localStorage, "setItem");
    const { classList, element } = documentElementStub();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      localStorage,
      matchMedia: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", { documentElement: element });

    const { useTheme } = await import("./useTheme");
    useTheme();
    const unsubscribe = react.subscribeToTheme?.(() => undefined);
    const storageListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([type]) => type === "storage")?.[1] as EventListener | undefined;
    setItem.mockClear();
    store.updateAppearance.mockClear();
    classList.toggle.mockClear();

    localStorage.setItem("t3code:theme-appearance-mode", "dark");
    setItem.mockClear();
    storageListener?.({
      key: "t3code:theme-appearance-mode",
      newValue: "dark",
    } as unknown as Event);

    expect(store.reconcileAppearanceColorScheme).toHaveBeenCalledWith("dark");
    expect(store.updateAppearance).not.toHaveBeenCalled();
    expect(classList.toggle).toHaveBeenCalledWith("dark", true);
    expect(setItem).not.toHaveBeenCalled();
    unsubscribe?.();
  });
});
