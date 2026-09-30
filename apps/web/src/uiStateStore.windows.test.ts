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
  first.useUiStateStore.setState({
    sidebarProjectScopeKey: "first-scope",
    projectOrder: ["first-project"],
    defaultAdvertisedEndpointKey: "first-endpoint",
    pullRequestMergeMethod: "squash",
  });
  second.useUiStateStore.setState({
    sidebarProjectScopeKey: "second-scope",
    projectOrder: ["second-project"],
    defaultAdvertisedEndpointKey: "second-endpoint",
    pullRequestMergeMethod: "rebase",
  });
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

  expect(first.useUiStateStore.getState()).toMatchObject({
    sidebarProjectScopeKey: "first-scope",
    projectOrder: ["first-project"],
    defaultAdvertisedEndpointKey: "first-endpoint",
    pullRequestMergeMethod: "squash",
  });
  expect(second.useUiStateStore.getState()).toMatchObject({
    sidebarProjectScopeKey: "second-scope",
    projectOrder: ["second-project"],
    defaultAdvertisedEndpointKey: "second-endpoint",
    pullRequestMergeMethod: "rebase",
  });
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
  // A pending preference save must include task records received in the meantime.
  second.useUiStateStore.setState({ sidebarProjectScopeKey: "pending-scope" });
  first.useUiStateStore.getState().markThreadVisited("local:new-task", "2026-09-29T01:11:00Z");
  unloadListeners[0]!();
  storageListeners[1]!({ key: first.PERSISTED_STATE_KEY, newValue: saved! });
  unloadListeners[1]!();
  expect(
    second.parsePersistedState(JSON.parse(saved!)).threadLastVisitedAtById["local:new-task"],
  ).toBe("2026-09-29T01:11:00Z");
  expect(second.useUiStateStore.getState().sidebarProjectScopeKey).toBe("pending-scope");
});
