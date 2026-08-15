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
    // npm 12 blocks install scripts by default, so provider maintenance allowlists the
    // package being updated. Kimi is installed the same way, so it inherits the flag.
    expect(packageManaged.update?.command).toBe(
      "npm install -g --allow-scripts=@moonshot-ai/kimi-code @moonshot-ai/kimi-code@latest",
    );

    const custom = KIMI_MAINTENANCE_RESOLVER.resolve({
      binaryPath: "/opt/custom/kimi",
      resolvedCommandPath: "/opt/custom/kimi",
    });
    expect(custom.packageName).toBe("@moonshot-ai/kimi-code");
    expect(custom.update).toBeNull();

    const unknownOnPath = KIMI_MAINTENANCE_RESOLVER.resolve({
      binaryPath: "kimi",
      resolvedCommandPath: "/usr/local/bin/kimi",
    });
    expect(unknownOnPath.update).toBeNull();
  });

  it("updates a native macOS or Linux installation with `kimi upgrade`", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const native = KIMI_MAINTENANCE_RESOLVER.resolve({
        binaryPath: "kimi",
        platform,
        resolvedCommandPath: "/home/user/.kimi-code/bin/kimi",
      });
      expect(native.update?.command).toBe("kimi upgrade");
      expect(native.update?.lockKey).toBe("kimi-native");
    }
  });

  it("shows the install script for a native Windows install instead of a no-op action", () => {
    // `kimi upgrade` exits 0 on native Windows without upgrading, so a runnable
    // action would just return the user to "Update now".
    const native = KIMI_MAINTENANCE_RESOLVER.resolve({
      binaryPath: "kimi",
      platform: "win32",
      resolvedCommandPath: "C:\\Users\\user\\.kimi-code\\bin\\kimi.exe",
    });
    expect(native.update).toBeNull();
    expect(native.manualCommand).toBe("irm https://code.kimi.com/kimi-code/install.ps1 | iex");

    // A shim resolving into the native install is still a native install.
    const viaShim = KIMI_MAINTENANCE_RESOLVER.resolve({
      binaryPath: "kimi",
      platform: "win32",
      resolvedCommandPath: "C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Links\\kimi.exe",
      realCommandPath: "C:\\Users\\user\\.kimi-code\\bin\\kimi.exe",
    });
    expect(viaShim.update).toBeNull();
    expect(viaShim.manualCommand).toBe("irm https://code.kimi.com/kimi-code/install.ps1 | iex");
  });

  it("updates a WinGet-managed install with `winget upgrade`", () => {
    const viaLinksShim = KIMI_MAINTENANCE_RESOLVER.resolve({
      binaryPath: "kimi",
      platform: "win32",
      resolvedCommandPath: "C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Links\\kimi.exe",
      realCommandPath:
        "C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Packages\\MoonshotAI.KimiCodeCLI_Microsoft.Winget.Source_8wekyb3d8bbwe\\kimi.exe",
    });
    expect(viaLinksShim.update?.executable).toBe("winget");
    expect(viaLinksShim.update?.args).toContain("MoonshotAI.KimiCodeCLI");
    expect(viaLinksShim.update?.lockKey).toBe("winget");
  });

  it("still uses the package manager for a global install on Windows", () => {
    const npmGlobal = KIMI_MAINTENANCE_RESOLVER.resolve({
      binaryPath: "kimi",
      platform: "win32",
      resolvedCommandPath: "C:\\Users\\user\\AppData\\Roaming\\npm\\kimi.cmd",
      realCommandPath:
        "C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@moonshot-ai\\kimi-code\\bin\\kimi.js",
    });
    expect(npmGlobal.update?.command).toBe(
      "npm install -g --allow-scripts=@moonshot-ai/kimi-code @moonshot-ai/kimi-code@latest",
    );
  });
});
