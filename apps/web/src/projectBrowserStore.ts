import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import {
  clampProjectBrowserWidth,
  DEFAULT_PROJECT_BROWSER_LAYOUT_STATE,
  EMPTY_PROJECT_BROWSER_RUNTIME_STATE,
  findProjectBrowserTab,
  insertProjectBrowserTab,
  reconcileProjectBrowserGrouping,
  reconcileProjectBrowserTabs,
  removeProjectBrowserTab,
  reorderProjectBrowserTab,
  selectProjectBrowserTab,
  type ProjectBrowserLayoutState,
  type ProjectBrowserRegroupingTransition,
  type ProjectBrowserRuntimeState,
  type ProjectBrowserTab,
  type ProjectBrowserTabActivity,
} from "./projectBrowserState";

const PROJECT_BROWSER_STORAGE_KEY = "t3code:project-browser-layout:v1";
const PROJECT_BROWSER_STORAGE_VERSION = 1;

export interface ProjectBrowserRoute {
  readonly logicalProjectKey: string;
  readonly backingThreadRef: ScopedThreadRef;
}

interface ProjectBrowserStoreState {
  readonly runtimeByProjectKey: Record<string, ProjectBrowserRuntimeState>;
  readonly layoutByProjectKey: Record<string, ProjectBrowserLayoutState>;
  readonly activityByTabId: Record<string, ProjectBrowserTabActivity>;
  readonly routeByTabId: Record<string, ProjectBrowserRoute>;
  readonly nextLayoutSequence: number;
  readonly toggle: (logicalProjectKey: string) => void;
  readonly show: (logicalProjectKey: string) => void;
  readonly close: (logicalProjectKey: string) => void;
  readonly setWidth: (logicalProjectKey: string, width: number) => void;
  readonly promote: (logicalProjectKey: string, tab: ProjectBrowserTab) => void;
  readonly remove: (tabId: string) => ProjectBrowserTab | null;
  readonly select: (logicalProjectKey: string, tabId: string) => void;
  readonly reorder: (logicalProjectKey: string, tabId: string, targetIndex: number) => void;
  readonly setActivity: (tabId: string, activity: ProjectBrowserTabActivity | null) => void;
  readonly reconcileAuthoritativeTabs: (
    backingThreadRef: ScopedThreadRef,
    tabIds: ReadonlySet<string>,
  ) => void;
  readonly reconcileGrouping: (input: {
    readonly transitions: readonly ProjectBrowserRegroupingTransition[];
    readonly activePhysicalProjectKey: string | null;
  }) => void;
  readonly resetRuntime: () => void;
}

function updateLayout(
  state: Pick<ProjectBrowserStoreState, "layoutByProjectKey" | "nextLayoutSequence">,
  logicalProjectKey: string,
  update: (current: ProjectBrowserLayoutState) => Omit<ProjectBrowserLayoutState, "updateSequence">,
): Pick<ProjectBrowserStoreState, "layoutByProjectKey" | "nextLayoutSequence"> {
  const current =
    state.layoutByProjectKey[logicalProjectKey] ?? DEFAULT_PROJECT_BROWSER_LAYOUT_STATE;
  const nextLayoutSequence = state.nextLayoutSequence + 1;
  return {
    layoutByProjectKey: {
      ...state.layoutByProjectKey,
      [logicalProjectKey]: { ...update(current), updateSequence: nextLayoutSequence },
    },
    nextLayoutSequence,
  };
}

function runtimeRoutes(
  runtimeByProjectKey: Readonly<Record<string, ProjectBrowserRuntimeState>>,
): Record<string, ProjectBrowserRoute> {
  return Object.fromEntries(
    Object.entries(runtimeByProjectKey).flatMap(([logicalProjectKey, runtime]) =>
      runtime.tabs.map((tab) => [
        tab.tabId,
        { logicalProjectKey, backingThreadRef: tab.backingThreadRef },
      ]),
    ),
  );
}

export function migrateProjectBrowserLayoutState(persisted: unknown): {
  layoutByProjectKey: Record<string, ProjectBrowserLayoutState>;
  nextLayoutSequence: number;
} {
  if (!persisted || typeof persisted !== "object") {
    return { layoutByProjectKey: {}, nextLayoutSequence: 0 };
  }
  const candidate = persisted as {
    layoutByProjectKey?: Record<string, Partial<ProjectBrowserLayoutState>>;
    nextLayoutSequence?: number;
  };
  const layoutByProjectKey = Object.fromEntries(
    Object.entries(candidate.layoutByProjectKey ?? {}).flatMap(([key, layout]) => {
      if (!key || !layout || typeof layout !== "object") return [];
      return [
        [
          key,
          {
            isOpen: layout.isOpen === true,
            width: clampProjectBrowserWidth(layout.width ?? Number.NaN),
            updateSequence:
              typeof layout.updateSequence === "number" &&
              Number.isSafeInteger(layout.updateSequence) &&
              layout.updateSequence >= 0
                ? layout.updateSequence
                : 0,
          },
        ],
      ];
    }),
  );
  const maxSequence = Math.max(
    0,
    ...Object.values(layoutByProjectKey).map((layout) => layout.updateSequence),
  );
  return {
    layoutByProjectKey,
    nextLayoutSequence: Math.max(
      maxSequence,
      typeof candidate.nextLayoutSequence === "number" &&
        Number.isSafeInteger(candidate.nextLayoutSequence)
        ? candidate.nextLayoutSequence
        : 0,
    ),
  };
}

export const useProjectBrowserStore = create<ProjectBrowserStoreState>()(
  persist(
    (set) => ({
      runtimeByProjectKey: {},
      layoutByProjectKey: {},
      activityByTabId: {},
      routeByTabId: {},
      nextLayoutSequence: 0,
      toggle: (logicalProjectKey) =>
        set((state) =>
          updateLayout(state, logicalProjectKey, (current) => ({
            isOpen: !current.isOpen,
            width: current.width,
          })),
        ),
      show: (logicalProjectKey) =>
        set((state) =>
          (state.layoutByProjectKey[logicalProjectKey]?.isOpen ?? false)
            ? state
            : updateLayout(state, logicalProjectKey, (current) => ({
                isOpen: true,
                width: current.width,
              })),
        ),
      close: (logicalProjectKey) =>
        set((state) =>
          !(state.layoutByProjectKey[logicalProjectKey]?.isOpen ?? false)
            ? state
            : updateLayout(state, logicalProjectKey, (current) => ({
                isOpen: false,
                width: current.width,
              })),
        ),
      setWidth: (logicalProjectKey, width) =>
        set((state) =>
          updateLayout(state, logicalProjectKey, (current) => ({
            isOpen: current.isOpen,
            width: clampProjectBrowserWidth(width),
          })),
        ),
      promote: (logicalProjectKey, tab) =>
        set((state) => {
          const existing = findProjectBrowserTab(state.runtimeByProjectKey, tab.tabId);
          let runtimeByProjectKey = state.runtimeByProjectKey;
          if (existing && existing.logicalProjectKey !== logicalProjectKey) {
            const source = removeProjectBrowserTab(
              runtimeByProjectKey[existing.logicalProjectKey]!,
              tab.tabId,
            );
            const { [existing.logicalProjectKey]: _source, ...rest } = runtimeByProjectKey;
            runtimeByProjectKey =
              source.tabs.length > 0 ? { ...rest, [existing.logicalProjectKey]: source } : rest;
          }
          const current =
            runtimeByProjectKey[logicalProjectKey] ?? EMPTY_PROJECT_BROWSER_RUNTIME_STATE;
          const next = insertProjectBrowserTab(current, tab);
          const layout = updateLayout(state, logicalProjectKey, (currentLayout) => ({
            isOpen: true,
            width: currentLayout.width,
          }));
          const nextRuntime = { ...runtimeByProjectKey, [logicalProjectKey]: next };
          return {
            ...layout,
            runtimeByProjectKey: nextRuntime,
            routeByTabId: runtimeRoutes(nextRuntime),
          };
        }),
      remove: (tabId) => {
        let removed: ProjectBrowserTab | null = null;
        set((state) => {
          const existing = findProjectBrowserTab(state.runtimeByProjectKey, tabId);
          if (!existing) return state;
          removed = existing.tab;
          const nextProject = removeProjectBrowserTab(
            state.runtimeByProjectKey[existing.logicalProjectKey]!,
            tabId,
          );
          const { [existing.logicalProjectKey]: _project, ...rest } = state.runtimeByProjectKey;
          const runtimeByProjectKey =
            nextProject.tabs.length > 0
              ? { ...rest, [existing.logicalProjectKey]: nextProject }
              : rest;
          const { [tabId]: _activity, ...activityByTabId } = state.activityByTabId;
          return {
            runtimeByProjectKey,
            routeByTabId: runtimeRoutes(runtimeByProjectKey),
            activityByTabId,
          };
        });
        return removed;
      },
      select: (logicalProjectKey, tabId) =>
        set((state) => {
          const current = state.runtimeByProjectKey[logicalProjectKey];
          if (!current) return state;
          const next = selectProjectBrowserTab(current, tabId);
          return next === current
            ? state
            : { runtimeByProjectKey: { ...state.runtimeByProjectKey, [logicalProjectKey]: next } };
        }),
      reorder: (logicalProjectKey, tabId, targetIndex) =>
        set((state) => {
          const current = state.runtimeByProjectKey[logicalProjectKey];
          if (!current) return state;
          const next = reorderProjectBrowserTab(current, tabId, targetIndex);
          return next === current
            ? state
            : { runtimeByProjectKey: { ...state.runtimeByProjectKey, [logicalProjectKey]: next } };
        }),
      setActivity: (tabId, activity) =>
        set((state) => {
          if (activity === null) {
            if (!(tabId in state.activityByTabId)) return state;
            const { [tabId]: _removed, ...activityByTabId } = state.activityByTabId;
            return { activityByTabId };
          }
          return { activityByTabId: { ...state.activityByTabId, [tabId]: activity } };
        }),
      reconcileAuthoritativeTabs: (backingThreadRef, tabIds) =>
        set((state) => {
          let changed = false;
          const runtimeByProjectKey = Object.fromEntries(
            Object.entries(state.runtimeByProjectKey).flatMap(([key, runtime]) => {
              const ownedIds = new Set(
                runtime.tabs
                  .filter(
                    (tab) =>
                      tab.backingThreadRef.environmentId === backingThreadRef.environmentId &&
                      tab.backingThreadRef.threadId === backingThreadRef.threadId,
                  )
                  .map((tab) => tab.tabId),
              );
              const allowed = new Set(
                runtime.tabs
                  .filter((tab) => !ownedIds.has(tab.tabId) || tabIds.has(tab.tabId))
                  .map((tab) => tab.tabId),
              );
              const next = reconcileProjectBrowserTabs(runtime, allowed);
              changed ||= next !== runtime;
              return next.tabs.length > 0 ? [[key, next]] : [];
            }),
          );
          if (!changed) return state;
          const routeByTabId = runtimeRoutes(runtimeByProjectKey);
          const activityByTabId = Object.fromEntries(
            Object.entries(state.activityByTabId).filter(([tabId]) => routeByTabId[tabId]),
          );
          return { runtimeByProjectKey, routeByTabId, activityByTabId };
        }),
      reconcileGrouping: ({ transitions, activePhysicalProjectKey }) =>
        set((state) => {
          const reconciled = reconcileProjectBrowserGrouping({
            runtimeByProjectKey: state.runtimeByProjectKey,
            layoutByProjectKey: state.layoutByProjectKey,
            transitions,
            activePhysicalProjectKey,
          });
          const routeByTabId = runtimeRoutes(reconciled.runtimeByProjectKey);
          const activityByTabId = Object.fromEntries(
            Object.entries(state.activityByTabId).filter(([tabId]) => routeByTabId[tabId]),
          );
          return { ...reconciled, routeByTabId, activityByTabId };
        }),
      resetRuntime: () => set({ runtimeByProjectKey: {}, activityByTabId: {}, routeByTabId: {} }),
    }),
    {
      name: PROJECT_BROWSER_STORAGE_KEY,
      version: PROJECT_BROWSER_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        layoutByProjectKey: state.layoutByProjectKey,
        nextLayoutSequence: state.nextLayoutSequence,
      }),
      migrate: migrateProjectBrowserLayoutState,
    },
  ),
);

export function selectProjectBrowserRuntime(
  runtimeByProjectKey: Readonly<Record<string, ProjectBrowserRuntimeState>>,
  logicalProjectKey: string | null | undefined,
): ProjectBrowserRuntimeState {
  return logicalProjectKey
    ? (runtimeByProjectKey[logicalProjectKey] ?? EMPTY_PROJECT_BROWSER_RUNTIME_STATE)
    : EMPTY_PROJECT_BROWSER_RUNTIME_STATE;
}

export function selectProjectBrowserLayout(
  layoutByProjectKey: Readonly<Record<string, ProjectBrowserLayoutState>>,
  logicalProjectKey: string | null | undefined,
): ProjectBrowserLayoutState {
  return logicalProjectKey
    ? (layoutByProjectKey[logicalProjectKey] ?? DEFAULT_PROJECT_BROWSER_LAYOUT_STATE)
    : DEFAULT_PROJECT_BROWSER_LAYOUT_STATE;
}
