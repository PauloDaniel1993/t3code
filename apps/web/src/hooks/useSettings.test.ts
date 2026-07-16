import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { duplicateAppearanceTheme } from "../appearance/appearanceOperations";

const persistenceMocks = vi.hoisted(() => ({
  read: vi.fn(),
  set: vi.fn(),
}));

function persistedCustomAppearance() {
  return duplicateAppearanceTheme(
    DEFAULT_CLIENT_SETTINGS.appearance,
    "default",
    () => "custom-saved-theme",
  );
}

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      setClientSettings: persistenceMocks.set,
    },
  }),
  readClientSettingsWithMeta: persistenceMocks.read,
}));

import {
  __getClientSettingsHydratedForTests,
  __hydrateClientSettingsForTests,
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  __waitForClientSettingsPersistenceForTests,
  getClientSettings,
  mergeEnvironmentSettings,
  reconcileAppearanceColorScheme,
  resolveEnvironmentIdentificationMode,
  updateAppearance,
} from "./useSettings";

beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
  persistenceMocks.read.mockReset();
  persistenceMocks.set.mockReset().mockResolvedValue(undefined);
  persistenceMocks.read.mockResolvedValue({
    settings: DEFAULT_CLIENT_SETTINGS,
    appearanceWasPersisted: true,
  });
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveEnvironmentIdentificationMode", () => {
  it("keeps identification hidden until client settings hydrate", () => {
    expect(resolveEnvironmentIdentificationMode({ mode: "artwork", settingsHydrated: false })).toBe(
      "none",
    );
    expect(resolveEnvironmentIdentificationMode({ mode: "pill", settingsHydrated: true })).toBe(
      "pill",
    );
  });
});

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });
});

describe("client settings hydration", () => {
  it("migrates raw settings without Appearance exactly once and persists the result", async () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "dark" },
    });
    persistenceMocks.read.mockResolvedValue({
      settings: DEFAULT_CLIENT_SETTINGS,
      appearanceWasPersisted: false,
    });

    await __hydrateClientSettingsForTests();
    await __hydrateClientSettingsForTests();
    await __waitForClientSettingsPersistenceForTests();

    expect(persistenceMocks.read).toHaveBeenCalledOnce();
    expect(persistenceMocks.set).toHaveBeenCalledOnce();
    expect(getClientSettings().appearance).toMatchObject({
      colorScheme: "dark",
      activeThemeId: "default",
      customThemeOrder: [],
    });
  });

  it("retains queued updates after a read failure and retries without overwriting settings", async () => {
    const appearance = persistedCustomAppearance();
    const expectedAppearance = { ...appearance, colorScheme: "dark" };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    persistenceMocks.read
      .mockRejectedValueOnce(new Error("persistence unavailable"))
      .mockResolvedValueOnce({
        settings: { ...DEFAULT_CLIENT_SETTINGS, appearance },
        appearanceWasPersisted: true,
      });

    updateAppearance((current) => ({ ...current, colorScheme: "dark" }));
    await __hydrateClientSettingsForTests();
    await __waitForClientSettingsPersistenceForTests();

    expect(consoleError).toHaveBeenCalledWith(
      "[CLIENT_SETTINGS] hydrate failed",
      expect.objectContaining({ operation: "hydrate" }),
    );
    expect(__getClientSettingsHydratedForTests()).toBe(false);
    expect(persistenceMocks.read).toHaveBeenCalledOnce();
    expect(persistenceMocks.set).not.toHaveBeenCalled();

    await __hydrateClientSettingsForTests();
    await __waitForClientSettingsPersistenceForTests();

    expect(__getClientSettingsHydratedForTests()).toBe(true);
    expect(persistenceMocks.read).toHaveBeenCalledTimes(2);
    expect(getClientSettings().appearance).toEqual(expectedAppearance);
    expect(persistenceMocks.set).toHaveBeenCalledOnce();
    expect(persistenceMocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ appearance: expectedAppearance }),
    );
  });

  it("replays a pending Appearance mutation over a late hydrated custom theme", async () => {
    const appearance = persistedCustomAppearance();
    let resolveRead!: (value: {
      settings: typeof DEFAULT_CLIENT_SETTINGS;
      appearanceWasPersisted: boolean;
    }) => void;
    persistenceMocks.read.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    updateAppearance((current) => ({ ...current, colorScheme: "dark" }));
    expect(getClientSettings().appearance.colorScheme).toBe("dark");
    expect(persistenceMocks.set).not.toHaveBeenCalled();

    resolveRead({
      settings: {
        ...DEFAULT_CLIENT_SETTINGS,
        timestampFormat: "24-hour",
        appearance,
      },
      appearanceWasPersisted: true,
    });
    await __hydrateClientSettingsForTests();
    await __waitForClientSettingsPersistenceForTests();

    const expectedAppearance = { ...appearance, colorScheme: "dark" };
    expect(getClientSettings().timestampFormat).toBe("24-hour");
    expect(getClientSettings().appearance).toEqual(expectedAppearance);
    expect(persistenceMocks.set).toHaveBeenCalledOnce();
    expect(persistenceMocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        timestampFormat: "24-hour",
        appearance: expectedAppearance,
      }),
    );
  });

  it("replays a pending reconciliation without persisting it", async () => {
    const appearance = persistedCustomAppearance();
    let resolveRead!: (value: {
      settings: typeof DEFAULT_CLIENT_SETTINGS;
      appearanceWasPersisted: boolean;
    }) => void;
    persistenceMocks.read.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    reconcileAppearanceColorScheme("dark");

    resolveRead({
      settings: { ...DEFAULT_CLIENT_SETTINGS, appearance },
      appearanceWasPersisted: true,
    });
    await __hydrateClientSettingsForTests();
    await __waitForClientSettingsPersistenceForTests();

    expect(getClientSettings().appearance).toEqual({ ...appearance, colorScheme: "dark" });
    expect(persistenceMocks.set).not.toHaveBeenCalled();
  });

  it("replays multiple pending Appearance mutations in call order", async () => {
    const appearance = persistedCustomAppearance();
    let resolveRead!: (value: {
      settings: typeof DEFAULT_CLIENT_SETTINGS;
      appearanceWasPersisted: boolean;
    }) => void;
    persistenceMocks.read.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    updateAppearance((current) => ({ ...current, colorScheme: "dark" }));
    updateAppearance((current) => ({
      ...current,
      colorScheme: current.colorScheme === "dark" ? "light" : "system",
    }));

    resolveRead({
      settings: { ...DEFAULT_CLIENT_SETTINGS, appearance },
      appearanceWasPersisted: true,
    });
    await __hydrateClientSettingsForTests();
    await __waitForClientSettingsPersistenceForTests();

    const expectedAppearance = { ...appearance, colorScheme: "light" };
    expect(getClientSettings().appearance).toEqual(expectedAppearance);
    expect(persistenceMocks.set).toHaveBeenCalledOnce();
    expect(persistenceMocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ appearance: expectedAppearance }),
    );
  });

  it("drops a failed replay mutation without blocking hydration or persistence", async () => {
    const appearance = persistedCustomAppearance();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolveRead!: (value: {
      settings: typeof DEFAULT_CLIENT_SETTINGS;
      appearanceWasPersisted: boolean;
    }) => void;
    persistenceMocks.read.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    reconcileAppearanceColorScheme("dark");
    updateAppearance((current) => {
      if (current.activeThemeId !== "default") {
        throw new Error("Expected the default appearance theme");
      }
      return { ...current, colorScheme: "light" };
    });

    resolveRead({
      settings: { ...DEFAULT_CLIENT_SETTINGS, appearance },
      appearanceWasPersisted: true,
    });
    await __hydrateClientSettingsForTests();
    await __waitForClientSettingsPersistenceForTests();

    expect(__getClientSettingsHydratedForTests()).toBe(true);
    expect(getClientSettings().appearance).toEqual({ ...appearance, colorScheme: "dark" });
    expect(consoleError).toHaveBeenCalledWith(
      "[CLIENT_SETTINGS] hydrate appearance mutation failed",
      expect.objectContaining({ operation: "hydrate-replay" }),
    );
    expect(persistenceMocks.set).not.toHaveBeenCalled();

    updateAppearance((current) => ({ ...current, colorScheme: "light" }));
    await __waitForClientSettingsPersistenceForTests();

    expect(persistenceMocks.set).toHaveBeenCalledOnce();
    expect(persistenceMocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ appearance: { ...appearance, colorScheme: "light" } }),
    );
  });

  it("serializes writes so the last logical state is persisted last", async () => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    const resolvers: Array<() => void> = [];
    persistenceMocks.set.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    updateAppearance((appearance) => ({ ...appearance, colorScheme: "dark" }));
    updateAppearance((appearance) => ({ ...appearance, colorScheme: "light" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(persistenceMocks.set).toHaveBeenCalledOnce();
    expect(persistenceMocks.set.mock.calls[0]?.[0].appearance.colorScheme).toBe("dark");

    resolvers[0]?.();
    await vi.waitFor(() => expect(persistenceMocks.set).toHaveBeenCalledTimes(2));
    expect(persistenceMocks.set.mock.calls[1]?.[0].appearance.colorScheme).toBe("light");

    resolvers[1]?.();
    await __waitForClientSettingsPersistenceForTests();
  });
});

describe("Appearance store updates", () => {
  it("validates the complete updater result before replacing or persisting it", () => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

    expect(() => updateAppearance(() => ({ customThemes: 42 }) as never)).toThrow();
    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);
    expect(persistenceMocks.set).not.toHaveBeenCalled();
  });

  it("reconciles a cross-tab mode without echoing to persistence", () => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

    reconcileAppearanceColorScheme("dark");

    expect(getClientSettings().appearance.colorScheme).toBe("dark");
    expect(persistenceMocks.set).not.toHaveBeenCalled();
  });
});
