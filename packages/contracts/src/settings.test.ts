import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  KIMI_DEFAULT_MODEL,
  KIMI_DEFAULT_MODEL_NAME,
  PROVIDER_DISPLAY_NAMES,
} from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodeServerSettingsPatch = Schema.encodeSync(ServerSettingsPatch);

const validTheme = (id = "custom-valid", name = "Valid") => ({
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
});

const decodeAppearanceWithThemes = (customThemes: Record<string, unknown>) =>
  decodeClientSettings({
    appearance: {
      colorScheme: "system",
      activeThemeId: "custom-valid",
      customThemeOrder: Object.keys(customThemes),
      customThemes,
    },
  }).appearance;

describe("ClientSettings word wrap", () => {
  it("defaults word wrap on", () => {
    expect(decodeClientSettings({}).wordWrap).toBe(true);
  });

  it("ignores obsolete wrapping preferences", () => {
    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    });

    expect(decoded.wordWrap).toBe(true);
    expect(decoded).not.toHaveProperty("chatWordWrap");
    expect(decoded).not.toHaveProperty("diffWordWrap");
  });
});

describe("ClientSettings appearance", () => {
  it("decodes a missing appearance field to the complete default state", () => {
    expect(decodeClientSettings({}).appearance).toEqual(DEFAULT_APPEARANCE_SETTINGS);
    expect(decodeClientSettings({}).appearance.activeThemeId).toBe("default");
  });

  it.each(["#FFF", "#11223344", "rgb(1, 2, 3)"])(
    "discards a custom theme with invalid hex color %s while preserving a valid sibling",
    (accent) => {
      const invalid = validTheme("custom-invalid", "Invalid");
      invalid.variants.light.accent = accent;
      const appearance = decodeAppearanceWithThemes({
        "custom-invalid": invalid,
        "custom-valid": validTheme(),
      });

      expect(appearance.customThemes).not.toHaveProperty("custom-invalid");
      expect(appearance.customThemes).toHaveProperty("custom-valid");
    },
  );

  it.each([
    ["uiFontSizePx", 11],
    ["chatFontSizePx", 25],
    ["codeFontSizePx", 10],
    ["terminalFontSizePx", 23],
  ] as const)("discards a theme with out-of-bounds %s", (field, value) => {
    const invalid = { ...validTheme("custom-invalid", "Invalid"), [field]: value };
    const appearance = decodeAppearanceWithThemes({
      "custom-invalid": invalid,
      "custom-valid": validTheme(),
    });

    expect(appearance.customThemes).not.toHaveProperty("custom-invalid");
    expect(appearance.customThemes).toHaveProperty("custom-valid");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "discards a theme with non-finite font size %s",
    (uiFontSizePx) => {
      const appearance = decodeAppearanceWithThemes({
        "custom-invalid": { ...validTheme("custom-invalid", "Invalid"), uiFontSizePx },
        "custom-valid": validTheme(),
      });
      expect(appearance.customThemes).not.toHaveProperty("custom-invalid");
      expect(appearance.customThemes).toHaveProperty("custom-valid");
    },
  );

  it("discards a theme with invalid density", () => {
    const appearance = decodeAppearanceWithThemes({
      "custom-invalid": { ...validTheme("custom-invalid", "Invalid"), density: "dense" },
      "custom-valid": validTheme(),
    });
    expect(appearance.customThemes).not.toHaveProperty("custom-invalid");
    expect(appearance.customThemes).toHaveProperty("custom-valid");
  });

  it("discards a theme with a missing variant field", () => {
    const invalid = validTheme("custom-invalid", "Invalid");
    const { surface: _surface, ...incompleteLight } = invalid.variants.light;
    const appearance = decodeAppearanceWithThemes({
      "custom-invalid": {
        ...invalid,
        variants: { ...invalid.variants, light: incompleteLight },
      },
      "custom-valid": validTheme(),
    });
    expect(appearance.customThemes).not.toHaveProperty("custom-invalid");
    expect(appearance.customThemes).toHaveProperty("custom-valid");
  });

  it.each([
    ["bad-id", "bad-id"],
    ["Default", "Default"],
    ["custom-key", "custom-other"],
  ])("discards invalid or mismatched custom id %s/%s", (key, id) => {
    const appearance = decodeAppearanceWithThemes({
      [key]: validTheme(id, "Invalid"),
      "custom-valid": validTheme(),
    });
    expect(appearance.customThemes).not.toHaveProperty(key);
    expect(appearance.customThemes).toHaveProperty("custom-valid");
  });

  it("falls back to default for an unknown active theme id", () => {
    const decoded = decodeClientSettings({
      appearance: {
        colorScheme: "dark",
        activeThemeId: "custom-missing",
        customThemeOrder: ["custom-valid"],
        customThemes: { "custom-valid": validTheme() },
      },
    });
    expect(decoded.appearance.activeThemeId).toBe("default");
    expect(decoded.appearance.colorScheme).toBe("dark");
  });

  it("deduplicates and prunes order, then appends missing themes lexicographically", () => {
    const decoded = decodeClientSettings({
      appearance: {
        colorScheme: "system",
        activeThemeId: "custom-beta",
        customThemeOrder: ["custom-beta", "custom-missing", "custom-beta", "custom-alpha"],
        customThemes: {
          "custom-zulu": validTheme("custom-zulu", "Zulu"),
          "custom-beta": validTheme("custom-beta", "Beta"),
          "custom-alpha": validTheme("custom-alpha", "Alpha"),
          "custom-charlie": validTheme("custom-charlie", "Charlie"),
        },
      },
    });
    expect(decoded.appearance.customThemeOrder).toEqual([
      "custom-beta",
      "custom-alpha",
      "custom-charlie",
      "custom-zulu",
    ]);
  });

  it("round-trips a complete valid custom theme", () => {
    const decoded = decodeClientSettings({
      appearance: {
        colorScheme: "light",
        activeThemeId: "custom-valid",
        customThemeOrder: ["custom-valid"],
        customThemes: { "custom-valid": validTheme() },
      },
    });
    const encoded = encodeClientSettings(decoded);
    expect(decodeClientSettings(encoded)).toEqual(decoded);
  });
});

describe("ClientSettingsPatch appearance", () => {
  it.each([
    { customThemes: 42 },
    {},
    {
      colorScheme: "system",
      activeThemeId: "default",
      customThemeOrder: [],
      customThemes: 42,
    },
    {
      colorScheme: "system",
      activeThemeId: "custom-missing",
      customThemeOrder: [],
      customThemes: {},
    },
  ])("rejects malformed appearance patch %#", (appearance) => {
    expect(() => decodeClientSettingsPatch({ appearance })).toThrow();
  });

  it("accepts a complete valid appearance replacement", () => {
    const appearance = {
      colorScheme: "dark" as const,
      activeThemeId: "custom-valid",
      customThemeOrder: ["custom-valid"],
      customThemes: { "custom-valid": validTheme() },
    };
    expect(decodeClientSettingsPatch({ appearance }).appearance).toEqual(appearance);
  });
});

describe("ClientSettings legacy terminal font", () => {
  it("defaults the deprecated field", () => {
    expect(decodeClientSettings({}).terminalFontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
  });

  it("decodes and trims a persisted legacy value", () => {
    expect(
      decodeClientSettings({ terminalFontFamily: "  Consolas, monospace  " }).terminalFontFamily,
    ).toBe("Consolas, monospace");
    expect(decodeClientSettingsPatch({ terminalFontFamily: "  Menlo  " }).terminalFontFamily).toBe(
      "Menlo",
    );
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
    expect(decoded.providers.kimi).toEqual({
      enabled: false,
      binaryPath: "kimi",
      homePath: "",
      customModels: [],
    });
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("ServerSettings Kimi provider", () => {
  const kimiDriver = ProviderDriverKind.make("kimi");

  it("exposes the synthetic default model identity and display metadata", () => {
    expect(KIMI_DEFAULT_MODEL).toBe("kimi-default");
    expect(KIMI_DEFAULT_MODEL_NAME).toBe("Kimi default");
    expect(DEFAULT_MODEL_BY_PROVIDER[kimiDriver]).toBe(KIMI_DEFAULT_MODEL);
    expect(DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[kimiDriver]).toBe(KIMI_DEFAULT_MODEL);
    expect(PROVIDER_DISPLAY_NAMES[kimiDriver]).toBe("Kimi");
  });

  it("decodes, normalizes, and round-trips a Kimi settings patch", () => {
    const decoded = decodeServerSettingsPatch({
      providers: {
        kimi: {
          enabled: true,
          binaryPath: "  /opt/homebrew/bin/kimi  ",
          homePath: "  ~/.kimi-code-work  ",
          customModels: ["kimi-k2-custom"],
        },
      },
    });

    expect(decoded.providers?.kimi).toEqual({
      enabled: true,
      binaryPath: "/opt/homebrew/bin/kimi",
      homePath: "~/.kimi-code-work",
      customModels: ["kimi-k2-custom"],
    });
    expect(decodeServerSettingsPatch(encodeServerSettingsPatch(decoded))).toEqual(decoded);
  });

  it("round-trips explicit Kimi instances without narrowing unknown drivers", () => {
    const decoded = decodeServerSettings({
      providers: {
        kimi: {
          enabled: true,
          binaryPath: "kimi-preview",
          homePath: "~/.kimi-code-preview",
          customModels: ["kimi-preview-model"],
        },
      },
      providerInstances: {
        kimi_work: {
          driver: "kimi",
          displayName: "Kimi Work",
          config: { homePath: "~/.kimi-code-work", customModels: ["kimi-work-model"] },
        },
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const roundTripped = decodeServerSettings(encodeServerSettings(decoded));

    expect(roundTripped.providers.kimi).toEqual({
      enabled: true,
      binaryPath: "kimi-preview",
      homePath: "~/.kimi-code-preview",
      customModels: ["kimi-preview-model"],
    });
    expect(roundTripped.providerInstances[ProviderInstanceId.make("kimi_work")]).toEqual({
      driver: "kimi",
      displayName: "Kimi Work",
      config: { homePath: "~/.kimi-code-work", customModels: ["kimi-work-model"] },
    });
    expect(roundTripped.providerInstances[ProviderInstanceId.make("ollama_local")]).toEqual({
      driver: "ollama",
      config: { endpoint: "http://localhost:11434" },
    });
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin on for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(true);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false);
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});

describe("ServerSettingsPatch string normalization", () => {
  it("trims string settings while decoding patches", () => {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: "  ~/Development  ",
      textGenerationModelSelection: { model: "  gpt-5.4-mini  " },
      observability: {
        otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
      },
      providers: {
        codex: {
          binaryPath: "  /opt/homebrew/bin/codex  ",
          homePath: "  ~/.codex  ",
          launchArgs: "  --strict-config --enable foo  ",
        },
      },
      providerInstances: {
        codex_personal: {
          driver: "  codex  ",
          displayName: "  Codex Personal  ",
          config: { homePath: "  ~/.codex-personal  " },
        },
      },
    });

    expect(patch.addProjectBaseDirectory).toBe("~/Development");
    expect(patch.textGenerationModelSelection?.model).toBe("gpt-5.4-mini");
    expect(patch.observability?.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(patch.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(patch.providers?.codex?.homePath).toBe("~/.codex");
    expect(patch.providers?.codex?.launchArgs).toBe("--strict-config --enable foo");
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.displayName).toBe(
      "Codex Personal",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.config).toEqual({
      homePath: "  ~/.codex-personal  ",
    });
  });

  it("trims encoded server settings values before validation", () => {
    const defaultSettings = decodeServerSettings({});
    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: "  ~/Development  ",
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: "  /opt/homebrew/bin/codex  ",
          launchArgs: "  --strict-config  ",
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(encoded.providers?.codex?.launchArgs).toBe("--strict-config");
  });
});
