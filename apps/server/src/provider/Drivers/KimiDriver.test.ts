import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { layer as idAllocatorLayer } from "../../orchestration-v2/IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../../orchestration-v2/ProviderAdapter.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeKimiTestHarness } from "../acp/KimiTestHarness.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
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

const driverTestLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-kimi-driver-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(idAllocatorLayer),
  Layer.provideMerge(ServerSettingsService.layerTest({ enableProviderUpdateChecks: false })),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Kimi fixtures must not make HTTP requests.")),
    ),
  ),
);

const makeInstance = Effect.fn("KimiDriverTest.makeInstance")(function* (
  name: string,
  fixtureEnvironment: NodeJS.ProcessEnv = {},
  enabled = true,
) {
  const h = yield* makeKimiTestHarness(fixtureEnvironment);
  const instance = yield* KimiDriver.create({
    instanceId: ProviderInstanceId.make(name),
    displayName: name,
    enabled,
    config: {
      ...KimiDriver.defaultConfig(),
      binaryPath: process.execPath,
      homePath: h.home,
      customModels: [`${name}-model`],
    },
    environment: Object.entries(h.environment).flatMap(([name, value]) =>
      value === undefined ? [] : [{ name, value, sensitive: false }],
    ),
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, h.childProcessSpawner));
  return { ...h, instance };
});

it.layer(driverTestLayer, { excludeTestServices: true })("Kimi driver lifecycle", (it) => {
  it.effect("checks existing login without creating a native session", () =>
    Effect.gen(function* () {
      const h = yield* makeInstance("signed-in");
      expect(yield* h.instance.snapshot.refresh).toMatchObject({
        instanceId: "signed-in",
        driver: "kimi",
        displayName: "signed-in",
        version: "0.29.0",
        status: "ready",
        auth: { status: "authenticated" },
        supportsTextGeneration: true,
      });
      expect((yield* h.requests).every((request) => !request.method.startsWith("session/"))).toBe(
        true,
      );
      expect(yield* (yield* FileSystem.FileSystem).exists(h.home)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a signed-out account and leaves disabled accounts untouched", () =>
    Effect.gen(function* () {
      const h = yield* makeInstance("signed-out", { T3_KIMI_AUTH_FAIL: "1" });
      expect(yield* h.instance.snapshot.refresh).toMatchObject({
        status: "error",
        auth: { status: "unauthenticated" },
      });
      const disabled = yield* makeInstance("disabled", {}, false);
      expect(yield* disabled.instance.snapshot.refresh).toMatchObject({ status: "disabled" });
      expect(yield* (yield* FileSystem.FileSystem).exists(disabled.log)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps native homes, model catalogs and continuation identities per instance", () =>
    Effect.gen(function* () {
      const first = yield* makeInstance("account-one");
      const second = yield* makeInstance("account-two");
      yield* first.instance.snapshot.refresh;
      yield* second.instance.snapshot.refresh;
      const selection = { instanceId: first.instance.instanceId, model: "kimi-default" };
      const policy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: first.root,
      });
      const session = yield* first.instance.orchestrationAdapter.openSession({
        threadId: ThreadId.make("account-one-thread"),
        providerSessionId: ProviderSessionId.make("account-one-session"),
        modelSelection: selection,
        runtimePolicy: policy,
      });
      yield* session.ensureThread({
        threadId: ThreadId.make("account-one-thread"),
        modelSelection: selection,
        runtimePolicy: policy,
      });
      expect((yield* first.instance.snapshot.refresh).models.map((model) => model.slug)).toEqual([
        "kimi-default",
        "kimi-live",
        "kimi-saved",
        "account-one-model",
      ]);
      expect((yield* second.instance.snapshot.refresh).models.map((model) => model.slug)).toEqual([
        "kimi-default",
        "account-two-model",
      ]);
      expect(first.instance.continuationIdentity).not.toEqual(second.instance.continuationIdentity);
      const initialized = (yield* first.requests).filter(
        (request) => request.method === "initialize",
      );
      for (const request of initialized) {
        expect(request.params.environment).toEqual({
          KIMI_CODE_HOME: first.home,
          KIMI_CODE_NO_AUTO_UPDATE: "1",
        });
      }
      expect(yield* (yield* FileSystem.FileSystem).exists(second.home)).toBe(false);
    }).pipe(Effect.scoped),
  );
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

    it.effect("keeps a native Windows install manual instead of offering a no-op update", () =>
      Effect.gen(function* () {
        const native = yield* KIMI_MAINTENANCE_RESOLVER.resolve(
          maintenanceContext({
            platform: "win32",
            resolvedCommandPath: "C:\\Users\\user\\.kimi-code\\bin\\kimi.exe",
            realCommandPath: "C:\\Users\\user\\.kimi-code\\bin\\kimi.exe",
          }),
        );
        expect(native.update).toBeNull();

        const viaShim = yield* KIMI_MAINTENANCE_RESOLVER.resolve(
          maintenanceContext({
            platform: "win32",
            resolvedCommandPath:
              "C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Links\\kimi.exe",
            realCommandPath: "C:\\Users\\user\\.kimi-code\\bin\\kimi.exe",
          }),
        );
        expect(viaShim.update).toBeNull();
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
