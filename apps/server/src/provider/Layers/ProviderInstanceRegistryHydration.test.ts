import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);

describe("ProviderInstanceRegistryHydration Kimi defaults", () => {
  it("hydrates the disabled legacy Kimi provider into the default instance", () => {
    const configMap = deriveProviderInstanceConfigMap(decodeServerSettings({}));
    expect(configMap[ProviderInstanceId.make("kimi")]).toEqual({
      driver: "kimi",
      config: {
        enabled: false,
        binaryPath: "kimi",
        homePath: "",
        customModels: [],
      },
    });
  });

  it("preserves independently configured Kimi instances and homes", () => {
    const configMap = deriveProviderInstanceConfigMap(
      decodeServerSettings({
        providerInstances: {
          "kimi-personal": {
            driver: "kimi",
            displayName: "Personal Kimi",
            enabled: true,
            config: { homePath: "/accounts/personal", binaryPath: "kimi" },
          },
          "kimi-work": {
            driver: "kimi",
            displayName: "Work Kimi",
            enabled: true,
            config: { homePath: "/accounts/work", binaryPath: "/tools/kimi" },
          },
        },
      }),
    );

    const personalId = ProviderInstanceId.make("kimi-personal");
    const workId = ProviderInstanceId.make("kimi-work");

    expect(configMap[personalId]?.config).toEqual({
      homePath: "/accounts/personal",
      binaryPath: "kimi",
    });
    expect(configMap[workId]?.config).toEqual({
      homePath: "/accounts/work",
      binaryPath: "/tools/kimi",
    });
    expect(configMap[personalId]?.driver).toBe("kimi");
    expect(configMap[workId]?.driver).toBe("kimi");
    // Explicit non-default ids coexist with the disabled legacy default.
    expect(configMap[ProviderInstanceId.make("kimi")]?.driver).toBe("kimi");
  });
});
