import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  KimiSettings,
  ServerSettings,
  ServerSettingsPatch,
  resolveProviderInstanceEnabled,
} from "./settings.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER } from "./model.ts";

const decodeKimi = Schema.decodeSync(KimiSettings);
const decodeSettings = Schema.decodeSync(ServerSettings);
const decodePatch = Schema.decodeSync(ServerSettingsPatch);

it("keeps Kimi disabled by default and preserves saved fork configuration", () => {
  expect(decodeKimi({})).toEqual({
    enabled: false,
    binaryPath: "kimi",
    homePath: "",
    customModels: [],
  });
  const config = {
    enabled: true,
    binaryPath: "C:\\kimi.exe",
    homePath: "C:\\kimi-home",
    customModels: ["kimi-saved"],
  };
  const decoded = decodeSettings({
    providers: { kimi: config },
    providerInstances: { kimi: { driver: "kimi", config } },
  });
  expect(decoded.providers.kimi).toEqual(config);
  expect(decoded.providerInstances[ProviderInstanceId.make("kimi")]?.config).toEqual(config);
  expect(
    decodePatch({ providers: { kimi: { homePath: "C:\\other" } } }).providers?.kimi?.homePath,
  ).toBe("C:\\other");
  const driver = ProviderDriverKind.make("kimi");
  expect(resolveProviderInstanceEnabled({ driver, config: {} })).toBe(false);
  expect(DEFAULT_MODEL_BY_PROVIDER[driver]).toBe("kimi-default");
  expect(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver]).toBe("kimi-default");
});
