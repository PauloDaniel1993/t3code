import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DEFAULT_DEEPSEEK_HANDOFF_COMPRESSION_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
} from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import {
  AppearanceTheme,
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_APPEARANCE_ACTIVE_THEME_ID,
  DEFAULT_APPEARANCE_CHAT_FONT_SIZE_PX,
  DEFAULT_APPEARANCE_CODE_FONT_SIZE_PX,
  DEFAULT_APPEARANCE_COLOR_SCHEME,
  DEFAULT_APPEARANCE_DENSITY,
  DEFAULT_APPEARANCE_DIFF_MARKER_STYLE,
  DEFAULT_APPEARANCE_MONO_FONT_FAMILY,
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_APPEARANCE_TERMINAL_FONT_SIZE_PX,
  DEFAULT_APPEARANCE_UI_FONT_FAMILY,
  DEFAULT_APPEARANCE_UI_FONT_SIZE_PX,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_SIDEBAR_ORGANIZATION,
  DEFAULT_TERMINAL_FONT_FAMILY,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeAppearanceTheme = Schema.decodeUnknownSync(AppearanceTheme);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

const baseAppearanceVariants = {
  light: {
    accent: "#339CFF",
    background: "#FFFFFF",
    foreground: "#1A1C1F",
    surface: "#F7F7F7",
    muted: "#EDEDED",
    contrast: 45,
    translucentSidebar: true,
  },
  dark: {
    accent: "#339CFF",
    background: "#181818",
    foreground: "#FFFFFF",
    surface: "#202020",
    muted: "#303030",
    contrast: 60,
    translucentSidebar: true,
  },
};

function makeCustomAppearanceTheme(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const theme = {
    id: "custom_readable",
    name: "Readable Copy",
    uiFontFamily: DEFAULT_APPEARANCE_UI_FONT_FAMILY,
    monoFontFamily: DEFAULT_APPEARANCE_MONO_FONT_FAMILY,
    terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    uiFontSizePx: DEFAULT_APPEARANCE_UI_FONT_SIZE_PX,
    chatFontSizePx: DEFAULT_APPEARANCE_CHAT_FONT_SIZE_PX,
    codeFontSizePx: DEFAULT_APPEARANCE_CODE_FONT_SIZE_PX,
    terminalFontSizePx: DEFAULT_APPEARANCE_TERMINAL_FONT_SIZE_PX,
    density: DEFAULT_APPEARANCE_DENSITY,
    diffMarkerStyle: DEFAULT_APPEARANCE_DIFF_MARKER_STYLE,
    variants: baseAppearanceVariants,
  };

  return { ...theme, ...overrides };
}

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

describe("ClientSettings.appearance", () => {
  it("defaults missing appearance settings to built-in Default in System mode", () => {
    const decoded = decodeClientSettings({});

    expect(decoded.appearance).toEqual(DEFAULT_APPEARANCE_SETTINGS);
    expect(decoded.appearance.colorScheme).toBe(DEFAULT_APPEARANCE_COLOR_SCHEME);
    expect(decoded.appearance.activeThemeId).toBe(DEFAULT_APPEARANCE_ACTIVE_THEME_ID);
    expect(decoded.appearance.customThemeOrder).toEqual([]);
    expect(decoded.appearance.customThemes).toEqual({});
    expect(DEFAULT_CLIENT_SETTINGS.appearance).toEqual(DEFAULT_APPEARANCE_SETTINGS);
  });

  it("falls back to Default when the active theme id is missing or invalid", () => {
    const decoded = decodeClientSettings({
      appearance: {
        activeThemeId: "missing_custom",
        customThemeOrder: ["custom_readable"],
        customThemes: {
          custom_readable: makeCustomAppearanceTheme(),
        },
      },
    });

    expect(decoded.appearance.activeThemeId).toBe(DEFAULT_APPEARANCE_ACTIVE_THEME_ID);
    expect(decoded.appearance.customThemeOrder).toEqual(["custom_readable"]);
  });

  it("round-trips valid custom themes and normalizes custom order", () => {
    const decoded = decodeClientSettings({
      appearance: {
        colorScheme: "dark",
        activeThemeId: "custom_readable",
        customThemeOrder: ["missing", "custom_readable", "custom_readable"],
        customThemes: {
          custom_readable: makeCustomAppearanceTheme(),
        },
      },
    });

    expect(decoded.appearance.colorScheme).toBe("dark");
    expect(decoded.appearance.activeThemeId).toBe("custom_readable");
    expect(decoded.appearance.customThemeOrder).toEqual(["custom_readable"]);
    expect(decoded.appearance.customThemes.custom_readable?.name).toBe("Readable Copy");

    const encoded = encodeClientSettings(decoded);
    expect(encoded.appearance).toEqual({
      colorScheme: "dark",
      activeThemeId: "custom_readable",
      customThemeOrder: ["custom_readable"],
      customThemes: {
        custom_readable: decoded.appearance.customThemes.custom_readable,
      },
    });
  });

  it("discards invalid custom themes without discarding the rest of client settings", () => {
    const invalidColor = makeCustomAppearanceTheme({
      id: "custom_bad_color",
      variants: {
        ...baseAppearanceVariants,
        light: {
          ...baseAppearanceVariants.light,
          accent: "blue",
        },
      },
    });
    const invalidSize = makeCustomAppearanceTheme({
      id: "custom_bad_size",
      uiFontSizePx: 11,
    });
    const valid = makeCustomAppearanceTheme({ id: "custom_valid", name: "Valid" });

    const decoded = decodeClientSettings({
      appearance: {
        activeThemeId: "custom_bad_color",
        customThemeOrder: ["custom_bad_color", "custom_valid", "custom_bad_size"],
        customThemes: {
          custom_bad_color: invalidColor,
          custom_bad_size: invalidSize,
          "bad key": makeCustomAppearanceTheme({ id: "bad key" }),
          default: makeCustomAppearanceTheme({ id: "default" }),
          custom_valid: valid,
        },
      },
      wordWrap: false,
    });

    expect(decoded.wordWrap).toBe(false);
    expect(decoded.appearance.activeThemeId).toBe(DEFAULT_APPEARANCE_ACTIVE_THEME_ID);
    expect(decoded.appearance.customThemeOrder).toEqual(["custom_valid"]);
    expect(Object.keys(decoded.appearance.customThemes)).toEqual(["custom_valid"]);
  });

  it("rejects unsafe custom theme colors, sizes, density, variant data, and id shape", () => {
    for (const invalidTheme of [
      makeCustomAppearanceTheme({ id: "1bad" }),
      makeCustomAppearanceTheme({ uiFontSizePx: 11 }),
      makeCustomAppearanceTheme({ chatFontSizePx: 25 }),
      makeCustomAppearanceTheme({ codeFontSizePx: 10 }),
      makeCustomAppearanceTheme({ terminalFontSizePx: 23 }),
      makeCustomAppearanceTheme({ density: "wide" }),
      makeCustomAppearanceTheme({
        variants: {
          ...baseAppearanceVariants,
          light: {
            ...baseAppearanceVariants.light,
            accent: "#12345",
          },
        },
      }),
      makeCustomAppearanceTheme({
        variants: {
          light: baseAppearanceVariants.light,
        },
      }),
    ]) {
      expect(() => decodeAppearanceTheme(invalidTheme)).toThrow();
    }
  });
});

describe("ClientSettings.sidebarOrganization", () => {
  it("defaults to an empty sidebar organization so legacy client settings still decode", () => {
    const decoded = decodeClientSettings({});

    expect(decoded.sidebarOrganization).toEqual(DEFAULT_SIDEBAR_ORGANIZATION);
    expect(DEFAULT_CLIENT_SETTINGS.sidebarOrganization).toEqual(DEFAULT_SIDEBAR_ORGANIZATION);
  });

  it("filters invalid category references while decoding", () => {
    const decoded = decodeClientSettings({
      sidebarOrganization: {
        categoryOrder: ["keep", "missing", "keep", "renamed"],
        categories: {
          keep: {
            id: " keep ",
            name: " Work ",
            archivedAt: null,
          },
          stale: {
            id: " renamed ",
            name: " Renamed ",
            archivedAt: "2026-06-18T00:00:00.000Z",
          },
        },
        projectCategoryAssignments: {
          project_keep: {
            categoryId: " keep ",
            updatedAt: "2026-06-18T00:00:00.000Z",
          },
          project_missing: {
            categoryId: "missing",
            updatedAt: "2026-06-18T00:00:00.000Z",
          },
          project_renamed: {
            categoryId: " renamed ",
            updatedAt: "2026-06-18T00:00:00.000Z",
          },
        },
      },
    });

    expect(decoded.sidebarOrganization).toEqual({
      categoryOrder: ["keep", "renamed"],
      categories: {
        keep: {
          id: "keep",
          name: "Work",
          archivedAt: null,
        },
        renamed: {
          id: "renamed",
          name: "Renamed",
          archivedAt: "2026-06-18T00:00:00.000Z",
        },
      },
      projectCategoryAssignments: {
        project_keep: {
          categoryId: "keep",
          updatedAt: "2026-06-18T00:00:00.000Z",
        },
        project_renamed: {
          categoryId: "renamed",
          updatedAt: "2026-06-18T00:00:00.000Z",
        },
      },
    });
  });
});

describe("ClientSettings.terminalFontFamily", () => {
  it("defaults to a Powerline-capable terminal font stack for legacy client settings", () => {
    const decoded = decodeClientSettings({});

    expect(decoded.terminalFontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(decoded.terminalFontFamily).toContain("JetBrainsMono NFM");
    expect(decoded.terminalFontFamily).toContain("CaskaydiaCove Nerd Font Mono");
    expect(decoded.terminalFontFamily).toContain("JetBrainsMono Nerd Font");
    expect(DEFAULT_CLIENT_SETTINGS.terminalFontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
  });

  it("trims custom terminal font family values while decoding", () => {
    const decoded = decodeClientSettings({
      terminalFontFamily: '  "JetBrainsMono Nerd Font", "Cascadia Code PL", monospace  ',
    });

    expect(decoded.terminalFontFamily).toBe(
      '"JetBrainsMono Nerd Font", "Cascadia Code PL", monospace',
    );
  });

  it("falls back to the default terminal font stack for empty values", () => {
    expect(decodeClientSettings({ terminalFontFamily: "" }).terminalFontFamily).toBe(
      DEFAULT_TERMINAL_FONT_FAMILY,
    );
    expect(decodeClientSettings({ terminalFontFamily: "   " }).terminalFontFamily).toBe(
      DEFAULT_TERMINAL_FONT_FAMILY,
    );
  });

  it("accepts terminal font family updates in client settings patches", () => {
    const patch = decodeClientSettingsPatch({
      terminalFontFamily: '  "CaskaydiaCove Nerd Font", monospace  ',
    });

    expect(patch.terminalFontFamily).toBe('"CaskaydiaCove Nerd Font", monospace');
  });

  it("rejects excessively long terminal font family values", () => {
    expect(() =>
      decodeClientSettings({
        terminalFontFamily: "a".repeat(1025),
      }),
    ).toThrow();
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

describe("ServerSettings.providers.deepseek", () => {
  it("defaults DeepSeek to disabled with empty connection settings", () => {
    const decoded = decodeServerSettings({});
    const deepseek = decoded.providers.deepseek;

    expect(deepseek.enabled).toBe(false);
    expect(deepseek.baseUrl).toBe("");
    expect(deepseek.contextLimit).toBe(128_000);
    expect(deepseek.customModels).toEqual([]);
  });

  it("registers DeepSeek model defaults in provider model metadata", () => {
    const deepseek = ProviderDriverKind.make("deepseek");

    expect(DEFAULT_MODEL_BY_PROVIDER[deepseek]).toBe(DEFAULT_DEEPSEEK_MODEL);
    expect(DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[deepseek]).toBe(
      DEFAULT_DEEPSEEK_HANDOFF_COMPRESSION_MODEL,
    );
  });

  it("accepts DeepSeek provider patches", () => {
    const patch = decodeServerSettingsPatch({
      providers: {
        deepseek: {
          enabled: true,
          baseUrl: "  https://api.deepseek.example/v1  ",
          contextLimit: 64_000,
          customModels: ["deepseek-local"],
        },
      },
    });

    expect(patch.providers?.deepseek?.enabled).toBe(true);
    expect(patch.providers?.deepseek?.baseUrl).toBe("https://api.deepseek.example/v1");
    expect(patch.providers?.deepseek?.contextLimit).toBe(64_000);
    expect(patch.providers?.deepseek?.customModels).toEqual(["deepseek-local"]);
  });
});

describe("ServerSettings.handoffCompressionModelSelection", () => {
  it("defaults handoff compression model selection to automatic", () => {
    expect(decodeServerSettings({}).handoffCompressionModelSelection).toBeNull();
  });

  it("decodes explicit handoff compression model selection", () => {
    const decoded = decodeServerSettings({
      handoffCompressionModelSelection: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
      },
    });

    expect(decoded.handoffCompressionModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("deepseek"),
      model: "deepseek-v4-flash",
    });
  });

  it("accepts null and explicit handoff compression selection patches", () => {
    expect(decodeServerSettingsPatch({ handoffCompressionModelSelection: null })).toEqual({
      handoffCompressionModelSelection: null,
    });

    const explicit = decodeServerSettingsPatch({
      handoffCompressionModelSelection: {
        instanceId: "deepseek_work",
        model: "  deepseek-v4-flash  ",
      },
    });

    expect(explicit.handoffCompressionModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("deepseek_work"),
      model: "deepseek-v4-flash",
    });
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin off for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(false);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: true }).newWorktreesStartFromOrigin,
    ).toBe(true);
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
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
  });
});

describe("ClientSettingsPatch.sidebarOrganization", () => {
  it("treats sidebarOrganization as an optional whole-object replacement", () => {
    const emptyPatch = decodeClientSettingsPatch({});
    expect(emptyPatch.sidebarOrganization).toBeUndefined();

    const replacement = decodeClientSettingsPatch({
      sidebarOrganization: {
        categoryOrder: ["work", "missing"],
        categories: {
          work: { id: " work ", name: " Work ", archivedAt: null },
        },
        projectCategoryAssignments: {
          project_a: {
            categoryId: " work ",
            updatedAt: "2026-06-18T00:00:00.000Z",
          },
          project_b: {
            categoryId: "missing",
            updatedAt: "2026-06-18T00:00:00.000Z",
          },
        },
      },
    });

    expect(replacement.sidebarOrganization).toEqual({
      categoryOrder: ["work"],
      categories: {
        work: { id: "work", name: "Work", archivedAt: null },
      },
      projectCategoryAssignments: {
        project_a: {
          categoryId: "work",
          updatedAt: "2026-06-18T00:00:00.000Z",
        },
      },
    });
  });
});
