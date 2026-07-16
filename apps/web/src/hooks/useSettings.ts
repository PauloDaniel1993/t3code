/**
 * Environment-scoped settings hooks.
 *
 * Abstracts the split between server-authoritative settings (persisted in
 * `settings.json` on the server, fetched via `server.getConfig`) and
 * client-only settings (persisted in localStorage).
 *
 * Live server settings always require an environment id. Primary-environment
 * access is intentionally named as such so environment-sensitive consumers
 * cannot silently read the wrong server's settings.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  type AppearanceSettings,
  type ClientSettingsPatch,
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  StrictAppearanceSettingsSchema,
  type UnifiedSettings,
} from "@t3tools/contracts/settings";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { ensureLocalApi, readClientSettingsWithMeta } from "~/localApi";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { migrateLegacyAppearance } from "~/appearance/appearanceMigration";
import { THEME_STORAGE_KEY } from "~/appearance/legacyTheme";
import { primaryServerSettingsAtom, serverEnvironment } from "~/state/server";
import { usePrimaryEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";

const CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE = "[CLIENT_SETTINGS]";

const clientSettingsListeners = new Set<() => void>();
const clientSettingsHydrationListeners = new Set<() => void>();
let clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
let clientSettingsHydrated = false;
let clientSettingsHydrationPromise: Promise<void> | null = null;
let clientSettingsHydrationGeneration = 0;
let pendingHydrationPatch: ClientSettingsPatch = {};
let pendingHydrationNeedsPersist = false;
const pendingAppearanceMutations: Array<{
  readonly updater: (appearance: AppearanceSettings) => AppearanceSettings;
  readonly persist: boolean;
}> = [];
let clientSettingsPersistChain: Promise<void> = Promise.resolve();

const decodeStrictAppearance = Schema.decodeUnknownSync(StrictAppearanceSettingsSchema);

function emitClientSettingsChange() {
  for (const listener of clientSettingsListeners) {
    listener();
  }
}

function emitClientSettingsHydrationChange() {
  for (const listener of clientSettingsHydrationListeners) {
    listener();
  }
}

function getClientSettingsSnapshot(): ClientSettings {
  return clientSettingsSnapshot;
}

function replaceClientSettingsSnapshot(settings: ClientSettings): void {
  clientSettingsSnapshot = settings;
  emitClientSettingsChange();
}

function readLegacyThemeMode(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // useTheme owns user-visible storage diagnostics. Migration safely falls
    // back to the default system mode when the legacy mirror is unavailable.
    return null;
  }
}

function enqueueClientSettingsPersist(settings: ClientSettings): void {
  clientSettingsPersistChain = clientSettingsPersistChain
    .then(() => ensureLocalApi().persistence.setClientSettings(settings))
    .catch((error) => {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} persist failed`, {
        operation: "persist",
        ...safeErrorLogAttributes(error),
      });
    });
}

function subscribeClientSettings(listener: () => void): () => void {
  clientSettingsListeners.add(listener);
  void hydrateClientSettings();
  return () => {
    clientSettingsListeners.delete(listener);
  };
}

function getClientSettingsHydratedSnapshot(): boolean {
  return clientSettingsHydrated;
}

function subscribeClientSettingsHydration(listener: () => void): () => void {
  clientSettingsHydrationListeners.add(listener);
  void hydrateClientSettings();
  return () => {
    clientSettingsHydrationListeners.delete(listener);
  };
}

async function hydrateClientSettings(): Promise<void> {
  if (clientSettingsHydrated) {
    return;
  }
  if (clientSettingsHydrationPromise) {
    return clientSettingsHydrationPromise;
  }

  const hydrationGeneration = clientSettingsHydrationGeneration;
  const nextHydration = (async () => {
    let hydratedSnapshot = DEFAULT_CLIENT_SETTINGS;
    let migrationNeedsPersist = false;

    try {
      const { settings, appearanceWasPersisted } = await readClientSettingsWithMeta();
      if (hydrationGeneration !== clientSettingsHydrationGeneration) {
        return;
      }

      if (settings !== null) {
        hydratedSnapshot = { ...DEFAULT_CLIENT_SETTINGS, ...settings };
      }
      if (!appearanceWasPersisted) {
        hydratedSnapshot = {
          ...hydratedSnapshot,
          appearance: migrateLegacyAppearance({
            rawAppearancePresent: false,
            legacyThemeMode: readLegacyThemeMode(),
            legacyTerminalFontFamily: hydratedSnapshot.terminalFontFamily,
            defaults: hydratedSnapshot.appearance,
          }),
        };
        migrationNeedsPersist = true;
      }
    } catch (error) {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} hydrate failed`, {
        operation: "hydrate",
        ...safeErrorLogAttributes(error),
      });
      // A failed read is not equivalent to absent settings. Leave hydration
      // incomplete and retain optimistic mutations for a later retry.
      return;
    }

    if (hydrationGeneration !== clientSettingsHydrationGeneration) {
      return;
    }

    let replayedAppearance = hydratedSnapshot.appearance;
    let replayedAppearanceNeedsPersist = false;
    for (const { updater, persist } of pendingAppearanceMutations) {
      try {
        replayedAppearance = decodeStrictAppearance(updater(replayedAppearance));
        replayedAppearanceNeedsPersist ||= persist;
      } catch (error) {
        console.error(
          `${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} hydrate appearance mutation failed`,
          {
            operation: "hydrate-replay",
            ...safeErrorLogAttributes(error),
          },
        );
      }
    }
    const nextSnapshot: ClientSettings = {
      ...hydratedSnapshot,
      ...pendingHydrationPatch,
      appearance: replayedAppearance,
    };
    const shouldPersist =
      migrationNeedsPersist || pendingHydrationNeedsPersist || replayedAppearanceNeedsPersist;
    pendingHydrationPatch = {};
    pendingHydrationNeedsPersist = false;
    pendingAppearanceMutations.length = 0;

    // Mark hydrated and enqueue the hydration write before notifying snapshot
    // listeners. A synchronous listener mutation will therefore queue after
    // this state and remain the last logical persisted value.
    clientSettingsHydrated = true;
    if (shouldPersist) {
      enqueueClientSettingsPersist(nextSnapshot);
    }
    replaceClientSettingsSnapshot(nextSnapshot);
    emitClientSettingsHydrationChange();
  })();

  const hydrationPromise = nextHydration.finally(() => {
    if (clientSettingsHydrationPromise === hydrationPromise) {
      clientSettingsHydrationPromise = null;
    }
  });
  clientSettingsHydrationPromise = hydrationPromise;

  return clientSettingsHydrationPromise;
}

function normalizeClientSettingsPatch(patch: ClientSettingsPatch): ClientSettingsPatch {
  return patch.appearance === undefined
    ? patch
    : { ...patch, appearance: decodeStrictAppearance(patch.appearance) };
}

function updateClientSettingsSnapshot(
  patch: ClientSettingsPatch,
  options: { readonly persist: boolean },
): void {
  const normalizedPatch = normalizeClientSettingsPatch(patch);
  const nextSnapshot: ClientSettings = {
    ...getClientSettingsSnapshot(),
    ...normalizedPatch,
  };
  replaceClientSettingsSnapshot(nextSnapshot);

  if (clientSettingsHydrated) {
    if (options.persist) {
      enqueueClientSettingsPersist(nextSnapshot);
    }
    return;
  }

  const { appearance, ...nonAppearancePatch } = normalizedPatch;
  pendingHydrationPatch = { ...pendingHydrationPatch, ...nonAppearancePatch };
  if (Object.keys(nonAppearancePatch).length > 0) {
    pendingHydrationNeedsPersist ||= options.persist;
  }
  if (appearance !== undefined) {
    pendingAppearanceMutations.push({ updater: () => appearance, persist: options.persist });
  }
  void hydrateClientSettings();
}

function updateAppearanceSnapshot(
  updater: (appearance: AppearanceSettings) => AppearanceSettings,
  persist: boolean,
): void {
  const appearance = decodeStrictAppearance(updater(getClientSettingsSnapshot().appearance));
  const nextSnapshot = { ...getClientSettingsSnapshot(), appearance };
  replaceClientSettingsSnapshot(nextSnapshot);

  if (clientSettingsHydrated) {
    if (persist) {
      enqueueClientSettingsPersist(nextSnapshot);
    }
    return;
  }

  pendingAppearanceMutations.push({ updater, persist });
  void hydrateClientSettings();
}

// ── Key sets for routing patches ─────────────────────────────────────

const SERVER_SETTINGS_KEYS = new Set<string>(Struct.keys(ServerSettings.fields));

function splitPatch(patch: Partial<UnifiedSettings>): {
  serverPatch: ServerSettingsPatch;
  clientPatch: ClientSettingsPatch;
} {
  const serverPatch: Record<string, unknown> = {};
  const clientPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SERVER_SETTINGS_KEYS.has(key)) {
      serverPatch[key] = value;
    } else {
      clientPatch[key] = value;
    }
  }
  return {
    serverPatch: serverPatch as ServerSettingsPatch,
    clientPatch: clientPatch as ClientSettingsPatch,
  };
}

// ── Hooks ────────────────────────────────────────────────────────────

/**
 * Non-hook accessor for the current merged client settings snapshot.
 * Used by non-React code paths (e.g. runtime services) that need the latest
 * settings without subscribing.
 */
export function getClientSettings(): ClientSettings {
  return getClientSettingsSnapshot();
}

export function updateAppearance(
  updater: (appearance: AppearanceSettings) => AppearanceSettings,
): void {
  updateAppearanceSnapshot(updater, true);
}

export function reconcileAppearanceColorScheme(
  colorScheme: AppearanceSettings["colorScheme"],
): void {
  updateAppearanceSnapshot((appearance) => ({ ...appearance, colorScheme }), false);
}

export function useUpdateAppearance() {
  return useCallback(updateAppearance, []);
}

export function useClientSettingsHydrated(): boolean {
  return useSyncExternalStore(
    subscribeClientSettingsHydration,
    getClientSettingsHydratedSnapshot,
    () => false,
  );
}

function useClientSettingsValue(): ClientSettings {
  return useSyncExternalStore(
    subscribeClientSettings,
    getClientSettingsSnapshot,
    () => DEFAULT_CLIENT_SETTINGS,
  );
}

export function mergeEnvironmentSettings(
  serverSettings: ServerSettings,
  clientSettings: ClientSettings,
): UnifiedSettings {
  return { ...serverSettings, ...clientSettings };
}

function useMergedSettings<T>(
  serverSettings: ServerSettings,
  selector: ((settings: UnifiedSettings) => T) | undefined,
): T {
  const clientSettings = useClientSettingsValue();

  const merged = useMemo<UnifiedSettings>(
    () => mergeEnvironmentSettings(serverSettings, clientSettings),
    [clientSettings, serverSettings],
  );

  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

export function useClientSettings<T = ClientSettings>(
  selector?: (settings: ClientSettings) => T,
): T {
  const settings = useClientSettingsValue();
  return useMemo(() => (selector ? selector(settings) : (settings as T)), [selector, settings]);
}

/** Read current settings for one environment, merged with client-local preferences. */
export function useEnvironmentSettings<T = UnifiedSettings>(
  environmentId: EnvironmentId,
  selector?: (settings: UnifiedSettings) => T,
): T {
  const serverSettings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  return useMergedSettings(serverSettings ?? DEFAULT_SERVER_SETTINGS, selector);
}

/** Primary-only settings access for the settings UI and other explicitly global surfaces. */
export function usePrimarySettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  return useMergedSettings(useAtomValue(primaryServerSettingsAtom), selector);
}

/**
 * Returns an updater that routes each key to the correct backing store.
 *
 * Server keys are optimistically patched in atom-backed server state, then
 * persisted via RPC. Client keys go through client persistence.
 */
function useUpdateSettingsTarget(environmentId: EnvironmentId | null) {
  const persistServerSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "server settings update",
  );
  const updateSettings = useCallback(
    (patch: Partial<UnifiedSettings>) => {
      const { serverPatch, clientPatch } = splitPatch(patch);

      if (Object.keys(serverPatch).length > 0) {
        if (environmentId) {
          void persistServerSettings({
            environmentId,
            input: { patch: serverPatch },
          });
        }
      }

      if (Object.keys(clientPatch).length > 0) {
        updateClientSettingsSnapshot(clientPatch, { persist: true });
      }
    },
    [environmentId, persistServerSettings],
  );

  return updateSettings;
}

export function useUpdateEnvironmentSettings(environmentId: EnvironmentId) {
  return useUpdateSettingsTarget(environmentId);
}

export function useUpdatePrimarySettings() {
  return useUpdateSettingsTarget(usePrimaryEnvironment()?.environmentId ?? null);
}

export function useUpdateClientSettings() {
  return useCallback((patch: ClientSettingsPatch) => {
    updateClientSettingsSnapshot(patch, { persist: true });
  }, []);
}

export function __resetClientSettingsPersistenceForTests(): void {
  clientSettingsHydrationGeneration += 1;
  clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
  clientSettingsHydrated = false;
  clientSettingsHydrationPromise = null;
  pendingHydrationPatch = {};
  pendingHydrationNeedsPersist = false;
  pendingAppearanceMutations.length = 0;
  clientSettingsPersistChain = Promise.resolve();
  clientSettingsListeners.clear();
  clientSettingsHydrationListeners.clear();
}

export function __setClientSettingsForTests(settings: ClientSettings): void {
  clientSettingsHydrationGeneration += 1;
  clientSettingsSnapshot = settings;
  clientSettingsHydrated = true;
  clientSettingsHydrationPromise = null;
  pendingHydrationPatch = {};
  pendingHydrationNeedsPersist = false;
  pendingAppearanceMutations.length = 0;
}

export async function __hydrateClientSettingsForTests(): Promise<void> {
  await hydrateClientSettings();
}

export function __getClientSettingsHydratedForTests(): boolean {
  return clientSettingsHydrated;
}

export async function __waitForClientSettingsPersistenceForTests(): Promise<void> {
  await clientSettingsPersistChain;
}
