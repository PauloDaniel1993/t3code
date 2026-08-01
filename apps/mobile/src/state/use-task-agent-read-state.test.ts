import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("../lib/runtime", async () => {
  const Layer = await import("effect/Layer");
  return {
    runtime: { runPromise: vi.fn() },
    runtimeContextLayer: Layer.empty,
  };
});

import {
  MAX_TASK_AGENT_READ_MARKERS,
  MobilePreferencesLoadError,
  MobilePreferencesSaveError,
  MobilePreferencesStore,
  type Preferences,
} from "../persistence/mobile-preferences";
import {
  DEFAULT_TASK_AGENT_COLD_START_POLICY,
  hasUnreadTaskResultForThread,
  type MarkTaskAgentThreadsVisitedInput,
} from "./task-agent-read-state";
import { resolveThreadTasksEnabled } from "./preferences";
import {
  createTaskAgentReadStateState,
  taskAgentReadStateFromPreferences,
} from "./use-task-agent-read-state";

const parentThreadId = ThreadId.make("parent-thread");
const taskThreadId = ThreadId.make("task-thread");
const deliveredAt = "2026-07-31T12:05:00.000Z";
const laterVisitedAt = "2026-07-31T12:10:00.000Z";
const earlierVisitedAt = "2026-07-31T12:00:00.000Z";

const visitInput: MarkTaskAgentThreadsVisitedInput = {
  parentThreadId,
  taskThreadId,
  visitedAt: deliveredAt,
};

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resume) => {
    resolve = resume;
  });
  return { promise, resolve } as const;
}

function makeMemoryPreferences(initial: Preferences = {}) {
  let preferences = initial;
  const service = MobilePreferencesStore.of({
    load: Effect.sync(() => preferences),
    savePatch: (patch) =>
      Effect.sync(() => {
        preferences = { ...preferences, ...patch };
        return preferences;
      }),
    update: (transform) =>
      Effect.sync(() => {
        preferences = { ...preferences, ...transform(preferences) };
        return preferences;
      }),
  });

  return { service, getPreferences: () => preferences } as const;
}

function makeState(service: MobilePreferencesStore["Service"]) {
  return createTaskAgentReadStateState(
    Atom.runtime(Layer.succeed(MobilePreferencesStore, service)),
  );
}

function marker(state: ReturnType<typeof taskAgentReadStateFromPreferences>, threadId: ThreadId) {
  return state.lastVisitedAtByThreadId.get(threadId);
}

describe("persistent task-agent read state", () => {
  it.effect("persists and rehydrates the parent and task markers together", () =>
    Effect.gen(function* () {
      const memory = makeMemoryPreferences();
      const state = makeState(memory.service);
      const registry = AtomRegistry.make();
      const unmountReadState = registry.mount(state.readStateAtom);
      const unmountCommand = registry.mount(state.markThreadsVisitedAtom);

      yield* AtomRegistry.getResult(registry, state.readStateAtom, { suspendOnWaiting: true });
      registry.set(state.markThreadsVisitedAtom, visitInput);
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(memory.getPreferences().taskAgentReadMarkers).toMatchObject({
            [parentThreadId]: deliveredAt,
            [taskThreadId]: deliveredAt,
          });
        }),
      );

      const current = yield* AtomRegistry.getResult(registry, state.readStateAtom, {
        suspendOnWaiting: true,
      });
      expect(marker(current, parentThreadId)).toBe(deliveredAt);
      expect(marker(current, taskThreadId)).toBe(deliveredAt);

      unmountCommand();
      unmountReadState();
      registry.dispose();

      const rehydratedState = makeState(memory.service);
      const rehydratedRegistry = AtomRegistry.make();
      const unmountRehydrated = rehydratedRegistry.mount(rehydratedState.readStateAtom);
      const rehydrated = yield* AtomRegistry.getResult(
        rehydratedRegistry,
        rehydratedState.readStateAtom,
        { suspendOnWaiting: true },
      );

      expect(marker(rehydrated, parentThreadId)).toBe(deliveredAt);
      expect(marker(rehydrated, taskThreadId)).toBe(deliveredAt);

      unmountRehydrated();
      rehydratedRegistry.dispose();
    }),
  );

  it.effect("uses the named unread policy when cold storage has no marker", () =>
    Effect.gen(function* () {
      const state = makeState(makeMemoryPreferences().service);
      const registry = AtomRegistry.make();
      const unmount = registry.mount(state.readStateAtom);
      const readState = yield* AtomRegistry.getResult(registry, state.readStateAtom, {
        suspendOnWaiting: true,
      });

      expect(readState.lastVisitedAtByThreadId.size).toBe(0);
      expect(DEFAULT_TASK_AGENT_COLD_START_POLICY).toBe("unread");
      expect(
        hasUnreadTaskResultForThread({
          readState,
          threadId: taskThreadId,
          taskSummary: { total: 1, running: 0, latestDeliveredAt: deliveredAt },
          coldStartPolicy: DEFAULT_TASK_AGENT_COLD_START_POLICY,
        }),
      ).toBe(true);

      unmount();
      registry.dispose();
    }),
  );

  it.effect("replays an optimistic visit over hydration that arrives later", () =>
    Effect.gen(function* () {
      const hydration = deferred<Preferences>();
      let persisted: Preferences = {};
      const service = MobilePreferencesStore.of({
        load: Effect.promise(() => hydration.promise),
        savePatch: (patch) =>
          Effect.promise(() => hydration.promise).pipe(
            Effect.map((loaded) => {
              persisted = { ...loaded, ...patch };
              return persisted;
            }),
          ),
        update: (transform) =>
          Effect.promise(() => hydration.promise).pipe(
            Effect.map((loaded) => {
              persisted = { ...loaded, ...transform(loaded) };
              return persisted;
            }),
          ),
      });
      const state = makeState(service);
      const registry = AtomRegistry.make();
      const unmountReadState = registry.mount(state.readStateAtom);
      const unmountCommand = registry.mount(state.markThreadsVisitedAtom);

      registry.set(state.markThreadsVisitedAtom, visitInput);
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          const optimistic = Option.getOrThrow(
            AsyncResult.value(registry.get(state.readStateAtom)),
          );
          expect(marker(optimistic, parentThreadId)).toBe(deliveredAt);
          expect(marker(optimistic, taskThreadId)).toBe(deliveredAt);
        }),
      );

      hydration.resolve({
        taskAgentReadMarkers: { existing: earlierVisitedAt },
      });
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(persisted.taskAgentReadMarkers).toMatchObject({
            existing: earlierVisitedAt,
            [parentThreadId]: deliveredAt,
            [taskThreadId]: deliveredAt,
          });
          expect(registry.get(state.markThreadsVisitedAtom).waiting).toBe(false);
        }),
      );

      const hydrated = yield* AtomRegistry.getResult(registry, state.readStateAtom, {
        suspendOnWaiting: true,
      });
      expect(marker(hydrated, ThreadId.make("existing"))).toBe(earlierVisitedAt);
      expect(marker(hydrated, parentThreadId)).toBe(deliveredAt);
      expect(marker(hydrated, taskThreadId)).toBe(deliveredAt);

      unmountCommand();
      unmountReadState();
      registry.dispose();
    }),
  );

  it.effect("preserves monotonic markers across persistence", () =>
    Effect.gen(function* () {
      const memory = makeMemoryPreferences({
        taskAgentReadMarkers: {
          [parentThreadId]: laterVisitedAt,
          [taskThreadId]: laterVisitedAt,
        },
      });
      const state = makeState(memory.service);
      const registry = AtomRegistry.make();
      const unmountReadState = registry.mount(state.readStateAtom);
      const unmountCommand = registry.mount(state.markThreadsVisitedAtom);

      yield* AtomRegistry.getResult(registry, state.readStateAtom, { suspendOnWaiting: true });
      registry.set(state.markThreadsVisitedAtom, {
        ...visitInput,
        visitedAt: earlierVisitedAt,
      });
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(registry.get(state.markThreadsVisitedAtom).waiting).toBe(false)),
      );

      expect(memory.getPreferences().taskAgentReadMarkers).toMatchObject({
        [parentThreadId]: laterVisitedAt,
        [taskThreadId]: laterVisitedAt,
      });

      unmountCommand();
      unmountReadState();
      registry.dispose();
    }),
  );

  it.effect("keeps the just-visited parent/task pair when pruning a full map", () =>
    Effect.gen(function* () {
      const taskAgentReadMarkers = Object.fromEntries(
        Array.from({ length: MAX_TASK_AGENT_READ_MARKERS }, (_, index) => [
          `existing-${index}`,
          new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        ]),
      );
      const memory = makeMemoryPreferences({ taskAgentReadMarkers });
      const state = makeState(memory.service);
      const registry = AtomRegistry.make();
      const unmountReadState = registry.mount(state.readStateAtom);
      const unmountCommand = registry.mount(state.markThreadsVisitedAtom);

      yield* AtomRegistry.getResult(registry, state.readStateAtom, { suspendOnWaiting: true });
      registry.set(state.markThreadsVisitedAtom, {
        ...visitInput,
        visitedAt: "2020-01-01T00:00:00.000Z",
      });
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(registry.get(state.markThreadsVisitedAtom).waiting).toBe(false)),
      );

      const persistedMarkers = memory.getPreferences().taskAgentReadMarkers ?? {};
      expect(Object.keys(persistedMarkers)).toHaveLength(MAX_TASK_AGENT_READ_MARKERS);
      expect(persistedMarkers[parentThreadId]).toBe("2020-01-01T00:00:00.000Z");
      expect(persistedMarkers[taskThreadId]).toBe("2020-01-01T00:00:00.000Z");

      unmountCommand();
      unmountReadState();
      registry.dispose();
    }),
  );

  it.effect("handles a load failure without overwriting durable markers", () =>
    Effect.gen(function* () {
      const durableMarkers = { task: deliveredAt };
      const update = vi.fn(() =>
        Effect.fail(new MobilePreferencesSaveError({ cause: new Error("load still unavailable") })),
      );
      const service = MobilePreferencesStore.of({
        load: Effect.fail(
          new MobilePreferencesLoadError({ cause: new Error("storage unavailable") }),
        ),
        savePatch: () =>
          Effect.fail(new MobilePreferencesSaveError({ cause: new Error("load unavailable") })),
        update,
      });
      const state = makeState(service);
      const registry = AtomRegistry.make();
      const unmountReadState = registry.mount(state.readStateAtom);
      const unmountCommand = registry.mount(state.markThreadsVisitedAtom);

      const loaded = yield* AtomRegistry.getResult(registry, state.readStateAtom, {
        suspendOnWaiting: true,
      });
      expect(loaded.lastVisitedAtByThreadId.size).toBe(0);

      registry.set(state.markThreadsVisitedAtom, visitInput);
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(update).toHaveBeenCalledTimes(1);
          expect(registry.get(state.markThreadsVisitedAtom).waiting).toBe(false);
          const readState = Option.getOrThrow(AsyncResult.value(registry.get(state.readStateAtom)));
          expect(readState.lastVisitedAtByThreadId.size).toBe(0);
        }),
      );

      expect(durableMarkers).toEqual({ task: deliveredAt });

      unmountCommand();
      unmountReadState();
      registry.dispose();
    }),
  );
});

describe("mobile thread-tasks beta selector", () => {
  it("defaults false and does not inherit the thread-list flag", () => {
    expect(resolveThreadTasksEnabled(undefined)).toBe(false);
    expect(resolveThreadTasksEnabled(false)).toBe(false);
    expect(resolveThreadTasksEnabled(true)).toBe(true);
    expect(resolveThreadTasksEnabled(undefined)).not.toBe(true);
  });
});
