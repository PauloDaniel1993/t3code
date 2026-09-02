import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { KimiIcon } from "../Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("provider icon presentation", () => {
  it("registers Kimi with its own icon", () => {
    const kimi = ProviderDriverKind.make("kimi");

    expect(PROVIDER_ICON_BY_PROVIDER[kimi]).toBe(KimiIcon);
  });

  it("leaves unknown drivers without an incorrect provider icon", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("future-provider")]).toBeUndefined();
  });
});
