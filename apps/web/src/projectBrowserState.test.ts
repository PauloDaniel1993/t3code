import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PROJECT_BROWSER_RUNTIME_STATE,
  insertProjectBrowserTab,
  reconcileProjectBrowserGrouping,
  reconcileProjectBrowserTabs,
  removeProjectBrowserTab,
  reorderProjectBrowserTab,
  selectProjectBrowserTab,
  type ProjectBrowserTab,
} from "./projectBrowserState";

const ref = (environmentId: string, threadId: string) =>
  scopeThreadRef(environmentId as EnvironmentId, ThreadId.make(threadId));

const tab = (
  tabId: string,
  physicalProjectKey: string,
  threadId = `thread-${tabId}`,
): ProjectBrowserTab => ({
  tabId,
  physicalProjectKey,
  originThreadRef: ref("env-1", threadId),
  backingThreadRef: ref("env-1", threadId),
});

describe("projectBrowserState", () => {
  it("inserts idempotently and selects the inserted tab", () => {
    const once = insertProjectBrowserTab(EMPTY_PROJECT_BROWSER_RUNTIME_STATE, tab("a", "p1"));
    const twice = insertProjectBrowserTab(once, tab("a", "p1"));
    expect(twice).toBe(once);
    expect(twice).toEqual({ tabs: [tab("a", "p1")], activeTabId: "a" });
  });

  it("selects, reorders, and removes with a deterministic neighboring fallback", () => {
    let state = insertProjectBrowserTab(EMPTY_PROJECT_BROWSER_RUNTIME_STATE, tab("a", "p1"));
    state = insertProjectBrowserTab(state, tab("b", "p1"));
    state = insertProjectBrowserTab(state, tab("c", "p1"));
    state = selectProjectBrowserTab(state, "b");
    state = reorderProjectBrowserTab(state, "a", 2);
    expect(state.tabs.map((entry) => entry.tabId)).toEqual(["b", "c", "a"]);
    expect(removeProjectBrowserTab(state, "b")).toEqual({
      tabs: [tab("c", "p1"), tab("a", "p1")],
      activeTabId: "c",
    });
  });

  it("drops non-authoritative tabs and repairs active selection", () => {
    let state = insertProjectBrowserTab(EMPTY_PROJECT_BROWSER_RUNTIME_STATE, tab("a", "p1"));
    state = insertProjectBrowserTab(state, tab("b", "p1"));
    expect(reconcileProjectBrowserTabs(state, new Set(["a"]))).toEqual({
      tabs: [tab("a", "p1")],
      activeTabId: "a",
    });
  });

  it("splits tabs by physical origin and clones the source layout", () => {
    const result = reconcileProjectBrowserGrouping({
      runtimeByProjectKey: {
        repo: {
          tabs: [tab("a", "p1"), tab("b", "p2")],
          activeTabId: "b",
        },
      },
      layoutByProjectKey: { repo: { isOpen: true, width: 500, updateSequence: 4 } },
      transitions: [
        {
          physicalProjectKey: "p1",
          previousLogicalProjectKey: "repo",
          nextLogicalProjectKey: "p1",
        },
        {
          physicalProjectKey: "p2",
          previousLogicalProjectKey: "repo",
          nextLogicalProjectKey: "p2",
        },
      ],
      activePhysicalProjectKey: "p2",
    });
    expect(result.runtimeByProjectKey.p1?.tabs.map((entry) => entry.tabId)).toEqual(["a"]);
    expect(result.runtimeByProjectKey.p2?.tabs.map((entry) => entry.tabId)).toEqual(["b"]);
    expect(result.layoutByProjectKey).toEqual({
      p1: { isOpen: true, width: 500, updateSequence: 4 },
      p2: { isOpen: true, width: 500, updateSequence: 4 },
    });
  });

  it("merges tabs stably, deduplicates ids, and uses the active source width", () => {
    const result = reconcileProjectBrowserGrouping({
      runtimeByProjectKey: {
        left: { tabs: [tab("a", "p1"), tab("shared", "p1")], activeTabId: "a" },
        right: { tabs: [tab("b", "p2"), tab("shared", "p2")], activeTabId: "b" },
      },
      layoutByProjectKey: {
        left: { isOpen: false, width: 360, updateSequence: 9 },
        right: { isOpen: true, width: 640, updateSequence: 2 },
        stale: { isOpen: true, width: 900, updateSequence: 20 },
      },
      transitions: [
        {
          physicalProjectKey: "p1",
          previousLogicalProjectKey: "left",
          nextLogicalProjectKey: "repo",
        },
        {
          physicalProjectKey: "p2",
          previousLogicalProjectKey: "right",
          nextLogicalProjectKey: "repo",
        },
      ],
      activePhysicalProjectKey: "p2",
    });
    expect(result.runtimeByProjectKey.repo?.tabs.map((entry) => entry.tabId)).toEqual([
      "a",
      "shared",
      "b",
    ]);
    expect(result.layoutByProjectKey).toEqual({
      repo: { isOpen: true, width: 640, updateSequence: 9 },
    });
  });

  it("drops tabs whose physical origin disappeared", () => {
    const result = reconcileProjectBrowserGrouping({
      runtimeByProjectKey: { repo: { tabs: [tab("a", "missing")], activeTabId: "a" } },
      layoutByProjectKey: { repo: { isOpen: true, width: 420, updateSequence: 1 } },
      transitions: [],
      activePhysicalProjectKey: null,
    });
    expect(result).toEqual({ runtimeByProjectKey: {}, layoutByProjectKey: {} });
  });
});
