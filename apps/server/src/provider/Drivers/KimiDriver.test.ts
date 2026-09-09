import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import type { ProviderMaintenanceResolutionContext } from "../providerMaintenance.ts";
import { KIMI_MAINTENANCE_RESOLVER, KimiDriver } from "./KimiDriver.ts";

const maintenanceContext = (
  overrides: Partial<ProviderMaintenanceResolutionContext>,
): ProviderMaintenanceResolutionContext => ({
  binaryPath: "kimi",
  resolvedCommandPath: "/usr/local/bin/kimi",
  realCommandPath: "/usr/local/bin/kimi",
  env: {},
  platform: "linux",
  ...overrides,
});

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

  it.layer(NodeServices.layer)("maintenance ownership", (it) => {
    it.effect("keeps missing and custom installations manual", () =>
      Effect.gen(function* () {
        const missing = yield* KIMI_MAINTENANCE_RESOLVER.resolve(null);
        expect(missing.packageName).toBe("@moonshot-ai/kimi-code");
        expect(missing.update).toBeNull();

        const custom = yield* KIMI_MAINTENANCE_RESOLVER.resolve(
          maintenanceContext({
            binaryPath: "/opt/custom/kimi",
            resolvedCommandPath: "/opt/custom/kimi",
            realCommandPath: "/opt/custom/kimi",
          }),
        );
        expect(custom.packageName).toBe("@moonshot-ai/kimi-code");
        expect(custom.update).toBeNull();
      }),
    );

    it.effect("updates an npm-owned installation through its proven prefix", () =>
      Effect.gen(function* () {
        const npmGlobal = yield* KIMI_MAINTENANCE_RESOLVER.resolve(
          maintenanceContext({
            resolvedCommandPath: "/usr/local/bin/kimi",
            realCommandPath: "/usr/local/lib/node_modules/@moonshot-ai/kimi-code/bin/kimi.js",
          }),
        );
        expect(npmGlobal.update?.command).toBe(
          "npm install -g --prefix /usr/local --allow-scripts=@moonshot-ai/kimi-code @moonshot-ai/kimi-code@latest",
        );
      }),
    );

    it.effect("updates a native macOS or Linux installation with `kimi upgrade`", () =>
      Effect.gen(function* () {
        for (const platform of ["darwin", "linux"] as const) {
          const native = yield* KIMI_MAINTENANCE_RESOLVER.resolve(
            maintenanceContext({
              platform,
              resolvedCommandPath: "/home/user/.kimi-code/bin/kimi",
              realCommandPath: "/home/user/.kimi-code/bin/kimi",
            }),
          );
          expect(native.update?.command).toBe("/home/user/.kimi-code/bin/kimi upgrade");
          expect(native.update?.lockKey).toBe("kimi-native");
        }
      }),
    );

    it.effect("shows the install script for a native Windows install", () =>
      Effect.gen(function* () {
        const native = yield* KIMI_MAINTENANCE_RESOLVER.resolve(
          maintenanceContext({
            platform: "win32",
            resolvedCommandPath: "C:\\Users\\user\\.kimi-code\\bin\\kimi.exe",
            realCommandPath: "C:\\Users\\user\\.kimi-code\\bin\\kimi.exe",
          }),
        );
        expect(native.update).toBeNull();
        expect(native.manualCommand).toBe("irm https://code.kimi.com/kimi-code/install.ps1 | iex");

        const viaShim = yield* KIMI_MAINTENANCE_RESOLVER.resolve(
          maintenanceContext({
            platform: "win32",
            resolvedCommandPath:
              "C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Links\\kimi.exe",
            realCommandPath: "C:\\Users\\user\\.kimi-code\\bin\\kimi.exe",
          }),
        );
        expect(viaShim.update).toBeNull();
        expect(viaShim.manualCommand).toBe("irm https://code.kimi.com/kimi-code/install.ps1 | iex");
      }),
    );

    it.effect("updates a WinGet-managed install with `winget upgrade`", () =>
      Effect.gen(function* () {
        const viaLinksShim = yield* KIMI_MAINTENANCE_RESOLVER.resolve(
          maintenanceContext({
            platform: "win32",
            resolvedCommandPath:
              "C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Links\\kimi.exe",
            realCommandPath:
              "C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Packages\\MoonshotAI.KimiCodeCLI_Microsoft.Winget.Source_8wekyb3d8bbwe\\kimi.exe",
          }),
        );
        expect(viaLinksShim.update?.executable).toBe("winget");
        expect(viaLinksShim.update?.args).toContain("MoonshotAI.KimiCodeCLI");
        expect(viaLinksShim.update?.lockKey).toBe("winget");
      }),
    );

    it.effect("recognizes a Windows npm shim only when its package manifest exists", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const prefix = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kimi-npm-" });
          const packageDirectory = path.join(prefix, "node_modules", "@moonshot-ai", "kimi-code");
          yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(packageDirectory, "package.json"), "{}");

          const npmGlobal = yield* KIMI_MAINTENANCE_RESOLVER.resolve(
            maintenanceContext({
              platform: "win32",
              resolvedCommandPath: path.join(prefix, "kimi.cmd"),
              realCommandPath: path.join(prefix, "kimi.cmd"),
            }),
          );
          expect(npmGlobal.update?.executable).toBe("npm");
          expect(npmGlobal.update?.args).toContain(prefix);
        }),
      ),
    );
  });
});
