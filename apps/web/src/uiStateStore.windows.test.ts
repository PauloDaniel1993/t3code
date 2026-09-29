import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("repairs simultaneous window writes and adopts newer per-thread preferences", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T01:10:00Z"));
  let saved: string | null = null;
  let staleRead = false;
  const storageListeners: Array<(event: { key: string; newValue: string }) => void> = [];
  const unloadListeners: Array<() => void> = [];
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => (staleRead ? null : saved),
      setItem: (_key: string, value: string) => {
        saved = value;
      },
      removeItem() {},
    },
    addEventListener: (type: string, listener: never) => {
      if (type === "storage") storageListeners.push(listener);
      if (type === "beforeunload") unloadListeners.push(listener);
    },
  });
  vi.resetModules();
  const first = await import("./uiStateStore");
  vi.resetModules();
  const second = await import("./uiStateStore");
  first.useUiStateStore.getState().markThreadVisited("local:parent", "2026-09-29T00:09:00Z");
  first.useUiStateStore.getState().setSidebarTaskGroupExpanded("local:parent", false);
  unloadListeners[0]!();

  // Both windows read the old storage value before either write was visible.
  vi.setSystemTime(new Date("2026-09-29T01:09:00Z"));
  staleRead = true;
  second.useUiStateStore.getState().markThreadVisited("local:child", "2026-09-29T00:08:00Z");
  second.useUiStateStore.getState().setSidebarTaskGroupExpanded("local:parent", true);
  unloadListeners[1]!();
  staleRead = false;
  storageListeners[0]!({ key: first.PERSISTED_STATE_KEY, newValue: saved! });
  unloadListeners[0]!();
  storageListeners[1]!({ key: first.PERSISTED_STATE_KEY, newValue: saved! });

  const restored = first.parsePersistedState(JSON.parse(saved!));
  expect(restored.threadLastVisitedAtById).toEqual({
    "local:parent": "2026-09-29T00:09:00Z",
    "local:child": "2026-09-29T00:08:00Z",
  });
  expect(restored.sidebarTaskGroupsExpandedById["local:parent"]).toBe(false);
  expect(first.useUiStateStore.getState().threadLastVisitedAtById).toEqual(
    restored.threadLastVisitedAtById,
  );
  expect(second.useUiStateStore.getState().sidebarTaskGroupsExpandedById["local:parent"]).toBe(
    false,
  );
});
