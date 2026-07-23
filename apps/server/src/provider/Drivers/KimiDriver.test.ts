import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { KIMI_MAINTENANCE_RESOLVER, KimiDriver } from "./KimiDriver.ts";

describe("KimiDriver", () => {
  it("registers a disabled, multi-instance Kimi driver", () => {
    expect(KimiDriver.driverKind).toBe("kimi");
    expect(KimiDriver.metadata).toEqual({
      displayName: "Kimi",
      supportsMultipleInstances: true,
    });
    expect(KimiDriver.defaultConfig()).toEqual({
      enabled: false,
      binaryPath: "kimi",
      homePath: "",
      customModels: [],
    });
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain("kimi");
  });

  it("uses package-manager updates conservatively and keeps custom paths manual", () => {
    const packageManaged = KIMI_MAINTENANCE_RESOLVER.resolve({ binaryPath: "kimi" });
    expect(packageManaged.packageName).toBe("@moonshot-ai/kimi-code");
    expect(packageManaged.update?.command).toBe("npm install -g @moonshot-ai/kimi-code@latest");

    const custom = KIMI_MAINTENANCE_RESOLVER.resolve({
      binaryPath: "/opt/custom/kimi",
      resolvedCommandPath: "/opt/custom/kimi",
    });
    expect(custom.packageName).toBe("@moonshot-ai/kimi-code");
    expect(custom.update).toBeNull();

    const nativeOnPath = KIMI_MAINTENANCE_RESOLVER.resolve({
      binaryPath: "kimi",
      resolvedCommandPath: "/usr/local/bin/kimi",
    });
    expect(nativeOnPath.update).toBeNull();
  });
});
