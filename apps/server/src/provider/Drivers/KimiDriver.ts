import { KimiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeKimiTextGeneration } from "../../textGeneration/KimiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeKimiModelState } from "../KimiModelState.ts";
import { makeKimiAdapter } from "../Layers/KimiAdapter.ts";
import {
  buildInitialKimiProviderSnapshot,
  checkKimiProviderStatus,
  enrichKimiSnapshot,
} from "../Layers/KimiProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilitiesResolver,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeKimiEnvironment } from "./KimiHome.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);
const DRIVER_KIND = ProviderDriverKind.make("kimi");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const PACKAGE_MANAGED_KIMI = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@moonshot-ai/kimi-code",
  homebrewFormula: null,
  // Native and custom installs remain manual-only until `kimi upgrade` can
  // be supervised non-interactively on every supported platform.
  nativeUpdate: null,
});

function isKnownPackageManagedKimiPath(path: string): boolean {
  const normalized = normalizeCommandPath(path);
  return [
    "/node_modules/",
    "/.bun/bin/",
    "/.vite-plus/bin/",
    "/pnpm/",
    "/appdata/roaming/npm/",
  ].some((marker) => normalized.includes(marker));
}

export const KIMI_MAINTENANCE_RESOLVER: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (options) => {
    const resolvedPaths = [options?.resolvedCommandPath, options?.realCommandPath].filter(
      (path): path is string => typeof path === "string" && path.length > 0,
    );
    if (
      resolvedPaths.length > 0 &&
      !resolvedPaths.some((path) => isKnownPackageManagedKimiPath(path))
    ) {
      return makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: "@moonshot-ai/kimi-code",
      });
    }
    return PACKAGE_MANAGED_KIMI.resolve(options);
  },
};

export type KimiDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const KimiDriver: ProviderDriver<KimiSettings, KimiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Kimi",
    supportsMultipleInstances: true,
  },
  configSchema: KimiSettings,
  defaultConfig: (): KimiSettings => decodeKimiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const effectiveConfig = { ...config, enabled } satisfies KimiSettings;
      const mergedEnvironment = mergeProviderInstanceEnvironment(environment);
      const processEnvironment = yield* makeKimiEnvironment(effectiveConfig, mergedEnvironment);
      const modelState = yield* makeKimiModelState(effectiveConfig.customModels);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        KIMI_MAINTENANCE_RESOLVER,
        {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnvironment,
        },
      );

      const adapter = yield* makeKimiAdapter(effectiveConfig, {
        environment: processEnvironment,
        instanceId,
        modelState,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeKimiTextGeneration(effectiveConfig, processEnvironment);
      const checkProvider = checkKimiProviderStatus(
        effectiveConfig,
        processEnvironment,
        modelState,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<KimiSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () =>
          Effect.gen(function* () {
            const currentModelState = yield* modelState.getSnapshot;
            return stampIdentity(
              yield* buildInitialKimiProviderSnapshot(effectiveConfig, currentModelState),
            );
          }),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, getSnapshot, publishSnapshot }) =>
          enrichKimiSnapshot({
            snapshot: currentSnapshot,
            modelState,
            maintenanceCapabilities,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            getSnapshot,
            publishSnapshot,
            stampIdentity,
            httpClient,
          }),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Kimi snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
