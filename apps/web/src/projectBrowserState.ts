import type { ScopedThreadRef } from "@t3tools/contracts";

export const PROJECT_BROWSER_DEFAULT_WIDTH = 420;
export const PROJECT_BROWSER_MIN_WIDTH = 320;

export interface ProjectBrowserTabActivity {
  readonly requestId: string;
  readonly operation: string;
  readonly controllerThreadRef: ScopedThreadRef;
}

export interface ProjectBrowserTab {
  readonly tabId: string;
  readonly originThreadRef: ScopedThreadRef;
  readonly backingThreadRef: ScopedThreadRef;
  readonly physicalProjectKey: string;
}

export interface ProjectBrowserRuntimeState {
  readonly tabs: readonly ProjectBrowserTab[];
  readonly activeTabId: string | null;
}

export interface ProjectBrowserLayoutState {
  readonly isOpen: boolean;
  readonly width: number;
  readonly updateSequence: number;
}

export interface ProjectBrowserRegroupingTransition {
  readonly physicalProjectKey: string;
  readonly previousLogicalProjectKey: string;
  readonly nextLogicalProjectKey: string;
}

export const EMPTY_PROJECT_BROWSER_RUNTIME_STATE: ProjectBrowserRuntimeState = {
  tabs: [],
  activeTabId: null,
};

export const DEFAULT_PROJECT_BROWSER_LAYOUT_STATE: ProjectBrowserLayoutState = {
  isOpen: false,
  width: PROJECT_BROWSER_DEFAULT_WIDTH,
  updateSequence: 0,
};

// Like the thread right panel (useResizableWidth without maxWidth), width has
// a floor but no ceiling — the user may grow the panel as wide as they like.
export function clampProjectBrowserWidth(width: number): number {
  if (!Number.isFinite(width)) return PROJECT_BROWSER_DEFAULT_WIDTH;
  return Math.max(PROJECT_BROWSER_MIN_WIDTH, width);
}

function runtimeStateEquals(
  left: ProjectBrowserRuntimeState,
  right: ProjectBrowserRuntimeState,
): boolean {
  return left.activeTabId === right.activeTabId && left.tabs === right.tabs;
}

export function insertProjectBrowserTab(
  state: ProjectBrowserRuntimeState,
  tab: ProjectBrowserTab,
): ProjectBrowserRuntimeState {
  const existingIndex = state.tabs.findIndex((candidate) => candidate.tabId === tab.tabId);
  if (existingIndex >= 0) {
    const existing = state.tabs[existingIndex]!;
    const sameTab =
      existing.physicalProjectKey === tab.physicalProjectKey &&
      existing.originThreadRef.environmentId === tab.originThreadRef.environmentId &&
      existing.originThreadRef.threadId === tab.originThreadRef.threadId &&
      existing.backingThreadRef.environmentId === tab.backingThreadRef.environmentId &&
      existing.backingThreadRef.threadId === tab.backingThreadRef.threadId;
    if (sameTab && state.activeTabId === tab.tabId) return state;
    const tabs = sameTab
      ? state.tabs
      : state.tabs.map((candidate, index) => (index === existingIndex ? tab : candidate));
    return { tabs, activeTabId: tab.tabId };
  }
  return { tabs: [...state.tabs, tab], activeTabId: tab.tabId };
}

export function selectProjectBrowserTab(
  state: ProjectBrowserRuntimeState,
  tabId: string,
): ProjectBrowserRuntimeState {
  if (state.activeTabId === tabId || !state.tabs.some((tab) => tab.tabId === tabId)) return state;
  return { ...state, activeTabId: tabId };
}

export function reorderProjectBrowserTab(
  state: ProjectBrowserRuntimeState,
  tabId: string,
  targetIndex: number,
): ProjectBrowserRuntimeState {
  const currentIndex = state.tabs.findIndex((tab) => tab.tabId === tabId);
  if (currentIndex < 0 || state.tabs.length < 2) return state;
  const boundedIndex = Math.min(state.tabs.length - 1, Math.max(0, Math.trunc(targetIndex)));
  if (boundedIndex === currentIndex) return state;
  const tabs = [...state.tabs];
  const [tab] = tabs.splice(currentIndex, 1);
  tabs.splice(boundedIndex, 0, tab!);
  return { ...state, tabs };
}

export function removeProjectBrowserTab(
  state: ProjectBrowserRuntimeState,
  tabId: string,
): ProjectBrowserRuntimeState {
  const index = state.tabs.findIndex((tab) => tab.tabId === tabId);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.tabId !== tabId);
  const activeTabId =
    state.activeTabId === tabId
      ? (tabs[Math.min(index, tabs.length - 1)]?.tabId ?? null)
      : state.activeTabId;
  return { tabs, activeTabId };
}

export function reconcileProjectBrowserTabs(
  state: ProjectBrowserRuntimeState,
  authoritativeTabIds: ReadonlySet<string>,
): ProjectBrowserRuntimeState {
  const tabs = state.tabs.filter((tab) => authoritativeTabIds.has(tab.tabId));
  if (tabs.length === state.tabs.length) return state;
  const activeTabId = tabs.some((tab) => tab.tabId === state.activeTabId)
    ? state.activeTabId
    : (tabs[0]?.tabId ?? null);
  return { tabs, activeTabId };
}

export function findProjectBrowserTab(
  runtimeByProjectKey: Readonly<Record<string, ProjectBrowserRuntimeState>>,
  tabId: string,
): { readonly logicalProjectKey: string; readonly tab: ProjectBrowserTab } | null {
  for (const [logicalProjectKey, state] of Object.entries(runtimeByProjectKey)) {
    const tab = state.tabs.find((candidate) => candidate.tabId === tabId);
    if (tab) return { logicalProjectKey, tab };
  }
  return null;
}

function chooseMergedLayout(input: {
  readonly destinationKey: string;
  readonly sourceKeys: readonly string[];
  readonly layoutByProjectKey: Readonly<Record<string, ProjectBrowserLayoutState>>;
  readonly activeSourceKey: string | null;
}): ProjectBrowserLayoutState {
  const candidates = [...new Set(input.sourceKeys)]
    .map((key) => ({ key, layout: input.layoutByProjectKey[key] }))
    .filter(
      (candidate): candidate is { key: string; layout: ProjectBrowserLayoutState } =>
        candidate.layout !== undefined,
    );
  if (candidates.length === 0) return DEFAULT_PROJECT_BROWSER_LAYOUT_STATE;
  const widthSource =
    candidates.find((candidate) => candidate.key === input.activeSourceKey) ??
    candidates.toSorted(
      (left, right) =>
        right.layout.updateSequence - left.layout.updateSequence ||
        left.key.localeCompare(right.key),
    )[0]!;
  return {
    isOpen: candidates.some((candidate) => candidate.layout.isOpen),
    width: clampProjectBrowserWidth(widthSource.layout.width),
    updateSequence: Math.max(...candidates.map((candidate) => candidate.layout.updateSequence)),
  };
}

export function reconcileProjectBrowserGrouping(input: {
  readonly runtimeByProjectKey: Readonly<Record<string, ProjectBrowserRuntimeState>>;
  readonly layoutByProjectKey: Readonly<Record<string, ProjectBrowserLayoutState>>;
  readonly transitions: readonly ProjectBrowserRegroupingTransition[];
  readonly activePhysicalProjectKey: string | null;
}): {
  readonly runtimeByProjectKey: Record<string, ProjectBrowserRuntimeState>;
  readonly layoutByProjectKey: Record<string, ProjectBrowserLayoutState>;
} {
  const destinationByPhysicalKey = new Map(
    input.transitions.map((transition) => [
      transition.physicalProjectKey,
      transition.nextLogicalProjectKey,
    ]),
  );
  const runtimeByProjectKey: Record<string, ProjectBrowserRuntimeState> = {};
  const seenTabIds = new Set<string>();

  for (const sourceKey of Object.keys(input.runtimeByProjectKey)) {
    const source = input.runtimeByProjectKey[sourceKey]!;
    for (const tab of source.tabs) {
      if (seenTabIds.has(tab.tabId)) continue;
      const destinationKey = destinationByPhysicalKey.get(tab.physicalProjectKey);
      if (!destinationKey) continue;
      seenTabIds.add(tab.tabId);
      const destination =
        runtimeByProjectKey[destinationKey] ?? EMPTY_PROJECT_BROWSER_RUNTIME_STATE;
      const next = insertProjectBrowserTab(destination, tab);
      runtimeByProjectKey[destinationKey] = {
        tabs: next.tabs,
        activeTabId:
          destination.activeTabId ??
          (source.activeTabId === tab.tabId ? tab.tabId : next.activeTabId),
      };
    }
  }

  for (const [key, state] of Object.entries(runtimeByProjectKey)) {
    const validActive = state.tabs.some((tab) => tab.tabId === state.activeTabId);
    if (!validActive)
      runtimeByProjectKey[key] = { ...state, activeTabId: state.tabs[0]?.tabId ?? null };
  }

  const destinationKeys = [
    ...new Set(input.transitions.map((entry) => entry.nextLogicalProjectKey)),
  ];
  const activeTransition = input.transitions.find(
    (entry) => entry.physicalProjectKey === input.activePhysicalProjectKey,
  );
  const layoutByProjectKey: Record<string, ProjectBrowserLayoutState> = {};
  for (const destinationKey of destinationKeys) {
    const sourceKeys = input.transitions
      .filter((entry) => entry.nextLogicalProjectKey === destinationKey)
      .map((entry) => entry.previousLogicalProjectKey);
    layoutByProjectKey[destinationKey] = chooseMergedLayout({
      destinationKey,
      sourceKeys,
      layoutByProjectKey: input.layoutByProjectKey,
      activeSourceKey:
        activeTransition?.nextLogicalProjectKey === destinationKey
          ? activeTransition.previousLogicalProjectKey
          : null,
    });
  }

  return { runtimeByProjectKey, layoutByProjectKey };
}

export function projectBrowserRuntimeStateEquals(
  left: ProjectBrowserRuntimeState,
  right: ProjectBrowserRuntimeState,
): boolean {
  return runtimeStateEquals(left, right);
}
