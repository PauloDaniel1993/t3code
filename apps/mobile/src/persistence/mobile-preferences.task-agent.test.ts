import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

import { MobileDatabase, MobileDatabaseError, type StoredPreferencesJson } from "./mobile-database";
import {
  MAX_TASK_AGENT_READ_MARKERS,
  make,
  normalizeTaskAgentReadMarkers,
  type Preferences,
} from "./mobile-preferences";
import { MobileSecureStorage, MobileSecureStorageError } from "./mobile-secure-storage";

const FALLBACK_KEY = "t3code.preferences.fallback";

interface HarnessOptions {
  readonly initialPreferences?: unknown;
  readonly databaseLoadFails?: boolean;
  readonly secureLoadFails?: boolean;
  readonly fallbackPreferences?: unknown;
}

function makeHarness(options: HarnessOptions = {}) {
  let stored: StoredPreferencesJson | null =
    options.initialPreferences === undefined
      ? null
      : { payload: JSON.stringify(options.initialPreferences), updatedAt: 10 };
  let saveCount = 0;
  const secureValues = new Map<string, string>();
  if (options.fallbackPreferences !== undefined) {
    secureValues.set(
      FALLBACK_KEY,
      JSON.stringify({
        payload: JSON.stringify(options.fallbackPreferences),
        updatedAt: 20,
      }),
    );
  }

  const databaseLoadError = new MobileDatabaseError({
    operation: "load-preferences",
    cause: new Error("database unavailable"),
  });
  const database = MobileDatabase.of({
    loadCache: () => Effect.succeed(Option.none()),
    listCache: () => Effect.succeed([]),
    saveCache: () => Effect.void,
    removeCache: () => Effect.void,
    clearCacheKind: () => Effect.void,
    clearEnvironmentCache: () => Effect.void,
    clearAllCaches: Effect.void,
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: options.databaseLoadFails
      ? Effect.fail(databaseLoadError)
      : Effect.sync(() => Option.fromNullishOr(stored)),
    savePreferencesJson: (payload, updatedAt) =>
      Effect.sync(() => {
        saveCount += 1;
        stored = { payload, updatedAt };
      }),
  });

  const secureReadError = new MobileSecureStorageError({
    operation: "read",
    key: FALLBACK_KEY,
    cause: new Error("secure storage unavailable"),
  });
  const secureStorage = MobileSecureStorage.of({
    getItem: (key) =>
      options.secureLoadFails
        ? Effect.fail(secureReadError)
        : Effect.succeed(secureValues.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        secureValues.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        secureValues.delete(key);
      }),
  });
  return make().pipe(
    Effect.provide(
      Layer.merge(
        Layer.succeed(MobileDatabase, database),
        Layer.succeed(MobileSecureStorage, secureStorage),
      ),
    ),
    Effect.map(
      (store) =>
        ({
          store,
          getSaveCount: () => saveCount,
          getStoredPayload: () => stored?.payload ?? null,
        }) as const,
    ),
  );
}

describe("task-agent mobile preferences", () => {
  it.effect("round-trips task markers through the preferences store", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const taskAgentReadMarkers = {
        parent: "2026-07-31T12:05:00.000Z",
        task: "2026-07-31T12:05:00.000Z",
      };

      yield* harness.store.savePatch({ taskAgentReadMarkers });

      expect(yield* harness.store.load).toEqual({ taskAgentReadMarkers });
    }),
  );

  it.effect("loads empty preferences on a cold start with no storage", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      expect(yield* harness.store.load).toEqual({});
    }),
  );

  it.effect("drops malformed and partial marker and beta values without throwing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialPreferences: {
          threadListV2Enabled: true,
          threadTasksEnabled: "yes",
          taskAgentReadMarkers: {
            parent: "2026-07-31T12:05:00.000Z",
            invalidDate: "not-a-date",
            invalidType: 42,
            "": "2026-07-31T12:06:00.000Z",
          },
        },
      });

      expect(yield* harness.store.load).toEqual({
        taskAgentReadMarkers: { parent: "2026-07-31T12:05:00.000Z" },
      });
    }),
  );

  it.effect("keeps the legacy-list and task flags persisted and independent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialPreferences: { legacyThreadListEnabled: true },
      });

      yield* harness.store.savePatch({ threadTasksEnabled: true });
      expect(yield* harness.store.load).toMatchObject({
        legacyThreadListEnabled: true,
        threadTasksEnabled: true,
      });

      yield* harness.store.savePatch({ legacyThreadListEnabled: false });
      expect(yield* harness.store.load).toMatchObject({
        legacyThreadListEnabled: false,
        threadTasksEnabled: true,
      });
    }),
  );

  it("retains only the newest 1,000 valid markers", () => {
    const markers = Object.fromEntries(
      Array.from({ length: MAX_TASK_AGENT_READ_MARKERS + 5 }, (_, index) => [
        `thread-${index}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      ]),
    );

    const normalized = normalizeTaskAgentReadMarkers(markers);

    expect(Object.keys(normalized)).toHaveLength(MAX_TASK_AGENT_READ_MARKERS);
    expect(normalized["thread-0"]).toBeUndefined();
    expect(normalized[`thread-${MAX_TASK_AGENT_READ_MARKERS + 4}`]).toBeDefined();
  });

  it.effect("loads the secure fallback when the database load fails", () =>
    Effect.gen(function* () {
      const fallbackPreferences: Preferences = {
        taskAgentReadMarkers: { task: "2026-07-31T12:05:00.000Z" },
      };
      const harness = yield* makeHarness({
        databaseLoadFails: true,
        fallbackPreferences,
      });

      expect(yield* harness.store.load).toEqual(fallbackPreferences);
    }),
  );

  it.effect("does not write or wipe the durable payload when every load path fails", () =>
    Effect.gen(function* () {
      const initialPreferences = {
        taskAgentReadMarkers: { task: "2026-07-31T12:05:00.000Z" },
      };
      const harness = yield* makeHarness({
        initialPreferences,
        databaseLoadFails: true,
        secureLoadFails: true,
      });
      const originalPayload = harness.getStoredPayload();

      const error = yield* Effect.flip(harness.store.load);
      expect(error).toMatchObject({ _tag: "MobilePreferencesLoadError" });
      expect(harness.getStoredPayload()).toBe(originalPayload);
      expect(harness.getSaveCount()).toBe(0);
    }),
  );
});
