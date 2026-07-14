import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { migrateProjectBrowserLayoutState, useProjectBrowserStore } from "./projectBrowserStore";

const backingThreadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));
const tab = {
  tabId: "tab-1",
  originThreadRef: backingThreadRef,
  backingThreadRef,
  physicalProjectKey: "physical-1",
};

beforeEach(() => {
  useProjectBrowserStore.setState({
    runtimeByProjectKey: {},
    layoutByProjectKey: {},
    activityByTabId: {},
    routeByTabId: {},
    nextLayoutSequence: 0,
  });
});

describe("projectBrowserStore", () => {
  it("promotes idempotently, opens the project, and creates a route", () => {
    useProjectBrowserStore.getState().promote("repo", tab);
    useProjectBrowserStore.getState().promote("repo", tab);
    expect(useProjectBrowserStore.getState().runtimeByProjectKey.repo).toEqual({
      tabs: [tab],
      activeTabId: "tab-1",
    });
    expect(useProjectBrowserStore.getState().layoutByProjectKey.repo?.isOpen).toBe(true);
    expect(useProjectBrowserStore.getState().routeByTabId["tab-1"]).toEqual({
      logicalProjectKey: "repo",
      backingThreadRef,
    });
  });

  it("persists only sanitized layout state", () => {
    expect(
      migrateProjectBrowserLayoutState({
        layoutByProjectKey: {
          // Width has no ceiling (parity with the right panel), only a floor.
          repo: { isOpen: true, width: 20_000, updateSequence: 3 },
          narrow: { isOpen: false, width: 10, updateSequence: 1 },
          invalid: null,
        },
        runtimeByProjectKey: { repo: { tabs: [tab], activeTabId: "tab-1" } },
      }),
    ).toEqual({
      layoutByProjectKey: {
        repo: { isOpen: true, width: 20_000, updateSequence: 3 },
        narrow: { isOpen: false, width: 320, updateSequence: 1 },
      },
      nextLayoutSequence: 3,
    });
  });

  it("keeps layout while resetting all runtime ownership", () => {
    useProjectBrowserStore.getState().promote("repo", tab);
    useProjectBrowserStore.getState().resetRuntime();
    expect(useProjectBrowserStore.getState().runtimeByProjectKey).toEqual({});
    expect(useProjectBrowserStore.getState().routeByTabId).toEqual({});
    expect(useProjectBrowserStore.getState().layoutByProjectKey.repo?.isOpen).toBe(true);
  });

  it("reconciles only tabs owned by the authoritative backing thread", () => {
    useProjectBrowserStore.getState().promote("repo", tab);
    useProjectBrowserStore.getState().reconcileAuthoritativeTabs(backingThreadRef, new Set());
    expect(useProjectBrowserStore.getState().runtimeByProjectKey).toEqual({});
    expect(useProjectBrowserStore.getState().routeByTabId).toEqual({});
  });

  it("moves the same tab without duplicating it", () => {
    useProjectBrowserStore.getState().promote("left", tab);
    useProjectBrowserStore.getState().promote("right", tab);
    expect(useProjectBrowserStore.getState().runtimeByProjectKey.left).toBeUndefined();
    expect(useProjectBrowserStore.getState().runtimeByProjectKey.right?.tabs).toEqual([tab]);
  });
});
