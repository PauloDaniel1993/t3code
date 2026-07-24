import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import { buildModelOptions } from "./modelOptions";

describe("mobile model options", () => {
  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });

  it("uses Kimi identity for configured models without a custom display name", () => {
    const config = {
      providers: [
        {
          instanceId: "kimi_work",
          driver: "kimi",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "kimi-default",
              name: "Kimi default",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(buildModelOptions(config, null)).toEqual([
      expect.objectContaining({
        label: "Kimi default",
        providerKey: "kimi_work",
        providerLabel: "Kimi",
        providerDriver: "kimi",
      }),
    ]);
  });

  it("uses Kimi identity for a fallback selection before provider discovery", () => {
    expect(
      buildModelOptions(null, {
        instanceId: ProviderInstanceId.make("kimi"),
        model: "kimi-default",
      }),
    ).toEqual([
      expect.objectContaining({
        label: "kimi-default",
        providerLabel: "Kimi",
        providerDriver: "kimi",
      }),
    ]);
  });
});
