import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderSummary,
  getProviderVersionAdvisoryPresentation,
  getProviderVersionLabel,
} from "./providerStatus";

function kimiProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("kimi"),
    driver: ProviderDriverKind.make("kimi"),
    displayName: "Kimi",
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: "ready",
    auth: { status: "authenticated", type: "Kimi Code membership" },
    checkedAt: "2026-07-22T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("Kimi provider status presentation", () => {
  it("shows Kimi membership authentication and version", () => {
    expect(getProviderSummary(kimiProvider())).toEqual({
      headline: "Authenticated · Kimi Code membership",
      detail: null,
    });
    expect(getProviderVersionLabel("1.2.3")).toBe("v1.2.3");
  });

  it("preserves actionable Kimi installation, login, and compatibility guidance", () => {
    expect(
      getProviderSummary(
        kimiProvider({
          installed: false,
          status: "error",
          auth: { status: "unknown" },
          message: "Install the current Kimi Code CLI and refresh provider status.",
        }),
      ),
    ).toMatchObject({
      headline: "Not found",
      detail: "Install the current Kimi Code CLI and refresh provider status.",
    });

    expect(
      getProviderSummary(
        kimiProvider({
          status: "error",
          auth: { status: "unauthenticated" },
          message: "Run `kimi login` for this KIMI_CODE_HOME, then refresh status.",
        }),
      ),
    ).toMatchObject({
      headline: "Not authenticated",
      detail: "Run `kimi login` for this KIMI_CODE_HOME, then refresh status.",
    });

    expect(
      getProviderSummary(
        kimiProvider({
          status: "error",
          auth: { status: "unknown" },
          message: "This Kimi Code CLI does not expose the required ACP capabilities.",
        }),
      ),
    ).toMatchObject({
      headline: "Unavailable",
      detail: "This Kimi Code CLI does not expose the required ACP capabilities.",
    });
  });

  it("renders a non-blocking Kimi update advisory", () => {
    expect(
      getProviderVersionAdvisoryPresentation({
        status: "behind_latest",
        currentVersion: "1.2.3",
        latestVersion: "1.3.0",
        updateCommand: "npm install -g @moonshot-ai/kimi-code@latest",
        canUpdate: true,
        checkedAt: "2026-07-22T00:00:00.000Z",
        message: null,
      }),
    ).toEqual({
      detail: "Update available: install v1.3.0.",
      updateCommand: "npm install -g @moonshot-ai/kimi-code@latest",
      emphasis: "normal",
    });
  });
});

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", label: "ChatGPT" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getProviderSummary", () => {
  it("reports ready providers with unknown authentication as available", () => {
    expect(getProviderSummary({ ...provider, auth: { status: "unknown" } })).toEqual({
      headline: "Available",
      detail: null,
    });
  });

  it("does not hide a provider error behind a previous authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        message: "The provider process failed to start.",
      }),
    ).toEqual({
      headline: "Unavailable",
      detail: "The provider process failed to start.",
    });
  });

  it("does not hide a provider warning behind an authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "warning",
        message: "The provider version is unsupported.",
      }),
    ).toEqual({
      headline: "Needs attention",
      detail: "The provider version is unsupported.",
    });
  });

  it("keeps authentication failures actionable when their provider status is error", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Run codex login.",
      }),
    ).toEqual({
      headline: "Not authenticated",
      detail: "Run codex login.",
    });
  });

  it("treats a disabled provider status as disabled even before its enabled flag updates", () => {
    expect(getProviderSummary({ ...provider, status: "disabled" }).headline).toBe("Disabled");
  });
});
