import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_SIDEBAR_ORGANIZATION,
  DEFAULT_TERMINAL_FONT_FAMILY,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

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
