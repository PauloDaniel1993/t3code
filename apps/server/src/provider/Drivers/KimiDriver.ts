import { KimiSettings, ProviderDriverKind } from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { withAgentDeviceEnvironment } from "../../mcp/McpProviderSession.ts";
import { IdAllocatorV2 } from "../../orchestration-v2/IdAllocator.ts";
import { makeKimiAdapterV2 } from "../../orchestration-v2/Adapters/KimiAdapterV2.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeKimiTextGeneration } from "../../textGeneration/KimiTextGeneration.ts";
import { makeKimiAcpRuntime, type KimiAcpRuntimeInput } from "../acp/KimiAcpSupport.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { ProviderDriverError } from "../Errors.ts";
import { buildKimiModels } from "../KimiModels.ts";
import { makeKimiModelCatalog } from "../KimiModelCatalog.ts";
import {
  buildInitialKimiProviderSnapshot,
  checkKimiProviderStatus,
} from "../Layers/KimiProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilitiesResolver,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { makeKimiEnvironment } from "./KimiHome.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);
const DRIVER_KIND = ProviderDriverKind.make("kimi");
/**
 * The native installer places the executable in `~/.kimi-code/bin`, alongside
 * the `.bak` copy `kimi upgrade` leaves behind when it replaces itself.
 */
function isKimiNativeCommandPath(path: string): boolean {
  return normalizeCommandPath(path).includes("/.kimi-code/bin/");
}

/**
 * WinGet installs the CLI as a portable package and exposes it through a
 * symlink in its `Links` directory, so either path identifies the same
 * winget-managed install. `winget upgrade` supervises non-interactively and is
 * the only updater that rewrites the package WinGet actually owns.
 */
const KIMI_WINGET_PACKAGE_ID = "MoonshotAI.KimiCodeCLI";

function isKimiWingetCommandPath(path: string): boolean {
  const normalized = normalizeCommandPath(path);
  return normalized.includes("/winget/packages/") || normalized.includes("/winget/links/");
}

const PACKAGE_MANAGED_KIMI = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@moonshot-ai/kimi-code",
  // On macOS and Linux `kimi upgrade` self-updates without prompting, so it
  // supervises exactly like `claude update` and `opencode upgrade`.
  nativeUpdate: {
    args: ["upgrade"],
    isCommandPath: isKimiNativeCommandPath,
  },
});

export const KIMI_MAINTENANCE_RESOLVER: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) => {
    const resolvedPaths = context ? [context.resolvedCommandPath, context.realCommandPath] : [];
    const isNativeInstall = resolvedPaths.some((path) => isKimiNativeCommandPath(path));

    if (isNativeInstall && context?.platform === "win32") {
      // Native Windows `kimi upgrade` exits successfully without updating.
      // Keep the manual installation guidance in docs/user/kimi.md.
      return Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: "@moonshot-ai/kimi-code",
        }),
      );
    }

    // Checked after the native branch: when a WinGet shim resolves into
    // `~/.kimi-code/bin`, the real executable is the native install and WinGet
    // does not own it.
    if (!isNativeInstall && resolvedPaths.some((path) => isKimiWingetCommandPath(path))) {
      return Effect.succeed(
        makeProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: "@moonshot-ai/kimi-code",
          updateExecutable: "winget",
          updateArgs: [
            "upgrade",
            "--id",
            KIMI_WINGET_PACKAGE_ID,
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--disable-interactivity",
          ],
          updateLockKey: "winget",
          platform: context!.platform,
        }),
      );
    }

    // The shared resolver proves package-manager ownership and remains
    // manual-only for every unrecognized location.
    return PACKAGE_MANAGED_KIMI.resolve(context);
  },
};

export type KimiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocatorV2
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const KimiDriver: ProviderDriver<KimiSettings, KimiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Kimi Code (supported)", supportsMultipleInstances: true },
  configSchema: KimiSettings,
  defaultConfig: () => decodeKimiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const idAllocator = yield* IdAllocatorV2;
      const eventLoggers = yield* ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      const selfInvocation = yield* resolveSelfInvocation();
      const settings = { ...config, enabled } satisfies KimiSettings;
      const processEnvironment = yield* makeKimiEnvironment(
        settings,
        mergeProviderInstanceEnvironment(environment),
      );
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const { catalog, publish: publishCatalog } = yield* makeKimiModelCatalog({
        cacheDir: serverConfig.providerStatusCacheDir,
        instanceId,
        binaryPath: settings.binaryPath,
        environment: environment ?? [],
        processEnvironment,
      });
      const provideRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        );
      const makeRuntime = (
        input: Omit<KimiAcpRuntimeInput, "kimiSettings" | "environment" | "childProcessSpawner">,
      ) =>
        makeKimiAcpRuntime({
          ...input,
          kimiSettings: settings,
          environment: withAgentDeviceEnvironment(processEnvironment, input),
          childProcessSpawner,
        }).pipe(provideRuntime);
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(KIMI_MAINTENANCE_RESOLVER, {
          binaryPath: settings.binaryPath,
          env: processEnvironment,
        }).pipe(provideRuntime),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(settings, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<KimiSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () =>
          SubscriptionRef.get(catalog).pipe(
            Effect.flatMap((options) => buildInitialKimiProviderSnapshot(settings, options)),
            Effect.map((draft) => stampIdentity({ ...draft, supportsTextGeneration: true })),
          ),
        checkProvider: checkKimiProviderStatus(
          settings,
          processEnvironment,
          SubscriptionRef.get(catalog),
        ).pipe(
          provideRuntime,
          Effect.map((draft) => stampIdentity({ ...draft, supportsTextGeneration: true })),
        ),
        enrichSnapshot: ({
          settings: currentSettings,
          snapshot: currentSnapshot,
          getSnapshot,
          publishSnapshot,
        }) =>
          Effect.all(
            [
              resolveMaintenance().pipe(
                Effect.flatMap((capabilities) =>
                  enrichProviderSnapshotWithVersionAdvisory(currentSnapshot, capabilities, {
                    enableProviderUpdateChecks: currentSettings.enableProviderUpdateChecks,
                  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
                ),
                Effect.flatMap((enriched) =>
                  getSnapshot.pipe(
                    Effect.flatMap((current) =>
                      publishSnapshot({ ...current, versionAdvisory: enriched.versionAdvisory }),
                    ),
                  ),
                ),
                Effect.catchCause(() =>
                  Effect.logWarning("Kimi version advisory enrichment failed."),
                ),
              ),
              SubscriptionRef.changes(catalog).pipe(
                Stream.runForEach((options) =>
                  getSnapshot.pipe(
                    Effect.flatMap((current) =>
                      publishSnapshot({
                        ...current,
                        models: buildKimiModels(settings.customModels, options),
                      }),
                    ),
                  ),
                ),
              ),
            ],
            { concurrency: "unbounded", discard: true },
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Could not prepare the Kimi provider snapshot.",
              cause,
            }),
        ),
      );
      const orchestrationAdapter = makeKimiAdapterV2({
        instanceId,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        selfInvocation,
        makeRuntime,
        onSessionConfigurationUpdate: (options) => publishCatalog(options),
        onSessionEvent: (event) =>
          event._tag === "ConfigOptionsUpdated" ? publishCatalog(event.configOptions) : Effect.void,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: eventLoggers.native,
            provider: DRIVER_KIND,
            threadId,
          }),
      });
      const textGeneration = yield* makeKimiTextGeneration({
        makeRuntime: (cwd) =>
          makeRuntime({
            cwd,
            clientInfo: { name: "t3-code-text", version: "0.0.0" },
            supervisionGuidance: false,
            mcpServers: [],
            acpMcpServers: [],
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
          }),
      });
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
