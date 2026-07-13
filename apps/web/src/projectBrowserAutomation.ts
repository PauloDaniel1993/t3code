import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type {
  PreviewAutomationProjectTabSummary,
  PreviewAutomationTabList,
  ScopedThreadRef,
} from "@t3tools/contracts";

import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "./logicalProject";
import {
  findProjectBrowserTab,
  type ProjectBrowserRuntimeState,
  type ProjectBrowserTab,
} from "./projectBrowserState";
import { useProjectBrowserStore } from "./projectBrowserStore";

export interface ProjectBrowserTabMetadata {
  readonly title: string;
  readonly url: string | null;
}

export function resolveLogicalProjectKeyForThread(input: {
  readonly threadRef: ScopedThreadRef;
  readonly projects: readonly EnvironmentProject[];
  readonly threads: readonly EnvironmentThreadShell[];
  readonly settings: ProjectGroupingSettings;
}): string | null {
  const thread = input.threads.find(
    (candidate) =>
      candidate.environmentId === input.threadRef.environmentId &&
      candidate.id === input.threadRef.threadId,
  );
  if (!thread) return null;
  const projectKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
  const project = input.projects.find(
    (candidate) =>
      scopedProjectKey(scopeProjectRef(candidate.environmentId, candidate.id)) === projectKey,
  );
  return project ? deriveLogicalProjectKeyFromSettings(project, input.settings) : null;
}

export function resolveAuthorizedProjectBrowserTab(input: {
  readonly tabId: string;
  readonly requestingThreadRef: ScopedThreadRef;
  readonly runtimeByProjectKey: Readonly<Record<string, ProjectBrowserRuntimeState>>;
  readonly projects: readonly EnvironmentProject[];
  readonly threads: readonly EnvironmentThreadShell[];
  readonly settings: ProjectGroupingSettings;
}): ProjectBrowserTab | null {
  const found = findProjectBrowserTab(input.runtimeByProjectKey, input.tabId);
  if (!found) return null;
  const requestingLogicalKey = resolveLogicalProjectKeyForThread({
    threadRef: input.requestingThreadRef,
    projects: input.projects,
    threads: input.threads,
    settings: input.settings,
  });
  return requestingLogicalKey === found.logicalProjectKey ? found.tab : null;
}

export function resolveActiveProjectBrowserTab(input: {
  readonly requestingThreadRef: ScopedThreadRef;
  readonly runtimeByProjectKey: Readonly<Record<string, ProjectBrowserRuntimeState>>;
  readonly projects: readonly EnvironmentProject[];
  readonly threads: readonly EnvironmentThreadShell[];
  readonly settings: ProjectGroupingSettings;
}): ProjectBrowserTab | null {
  const logicalProjectKey = resolveLogicalProjectKeyForThread({
    threadRef: input.requestingThreadRef,
    projects: input.projects,
    threads: input.threads,
    settings: input.settings,
  });
  if (!logicalProjectKey) return null;
  const runtime = input.runtimeByProjectKey[logicalProjectKey];
  if (!runtime?.activeTabId) return null;
  return runtime.tabs.find((tab) => tab.tabId === runtime.activeTabId) ?? null;
}

export function listProjectBrowserTabsForThread(input: {
  readonly requestingThreadRef: ScopedThreadRef;
  readonly runtimeByProjectKey: Readonly<Record<string, ProjectBrowserRuntimeState>>;
  readonly metadataByTabId: Readonly<Record<string, ProjectBrowserTabMetadata>>;
  readonly projects: readonly EnvironmentProject[];
  readonly threads: readonly EnvironmentThreadShell[];
  readonly settings: ProjectGroupingSettings;
}): PreviewAutomationTabList {
  const logicalProjectKey = resolveLogicalProjectKeyForThread({
    threadRef: input.requestingThreadRef,
    projects: input.projects,
    threads: input.threads,
    settings: input.settings,
  });
  const runtime = logicalProjectKey ? input.runtimeByProjectKey[logicalProjectKey] : undefined;
  if (!runtime) return { tabs: [], activeTabId: null };
  const tabs: PreviewAutomationProjectTabSummary[] = runtime.tabs.map((tab) => {
    const metadata = input.metadataByTabId[tab.tabId];
    return {
      tabId: tab.tabId,
      title: metadata?.title ?? "",
      url: metadata?.url ?? null,
      active: runtime.activeTabId === tab.tabId,
      backingEnvironmentId: tab.backingThreadRef.environmentId,
    };
  });
  return { tabs, activeTabId: runtime.activeTabId };
}

const operationTails = new Map<string, Promise<unknown>>();
const pendingCounts = new Map<string, number>();
const queueGenerations = new Map<string, number>();
const MAX_PENDING_PROJECT_BROWSER_OPERATIONS = 64;

export class ProjectBrowserAutomationQueueFullError extends Error {
  constructor(readonly tabId: string) {
    super(`Project browser tab ${tabId} already has too many queued operations.`);
    this.name = "ProjectBrowserAutomationQueueFullError";
  }
}

export function runSerializedProjectBrowserOperation<A>(input: {
  readonly tab: ProjectBrowserTab;
  readonly requestId: string;
  readonly operation: string;
  readonly controllerThreadRef: ScopedThreadRef;
  readonly run: () => Promise<A>;
}): Promise<A> {
  const pending = pendingCounts.get(input.tab.tabId) ?? 0;
  if (pending >= MAX_PENDING_PROJECT_BROWSER_OPERATIONS) {
    return Promise.reject(new ProjectBrowserAutomationQueueFullError(input.tab.tabId));
  }
  pendingCounts.set(input.tab.tabId, pending + 1);
  const generation = queueGenerations.get(input.tab.tabId) ?? 0;
  const previous = operationTails.get(input.tab.tabId) ?? Promise.resolve();
  const execution = previous
    .catch(() => undefined)
    .then(async () => {
      if ((queueGenerations.get(input.tab.tabId) ?? 0) !== generation) {
        throw new Error(`Project browser operation ${input.requestId} was cancelled.`);
      }
      useProjectBrowserStore.getState().setActivity(input.tab.tabId, {
        requestId: input.requestId,
        operation: input.operation,
        controllerThreadRef: input.controllerThreadRef,
      });
      try {
        return await input.run();
      } finally {
        const current = useProjectBrowserStore.getState().activityByTabId[input.tab.tabId];
        if (current?.requestId === input.requestId) {
          useProjectBrowserStore.getState().setActivity(input.tab.tabId, null);
        }
      }
    });
  operationTails.set(input.tab.tabId, execution);
  void execution.then(
    () => {
      pendingCounts.set(
        input.tab.tabId,
        Math.max(0, (pendingCounts.get(input.tab.tabId) ?? 1) - 1),
      );
      if (operationTails.get(input.tab.tabId) === execution) operationTails.delete(input.tab.tabId);
    },
    () => {
      pendingCounts.set(
        input.tab.tabId,
        Math.max(0, (pendingCounts.get(input.tab.tabId) ?? 1) - 1),
      );
      if (operationTails.get(input.tab.tabId) === execution) operationTails.delete(input.tab.tabId);
    },
  );
  return execution;
}

export async function cancelAndDrainProjectBrowserOperations(tabId: string): Promise<void> {
  const tail = operationTails.get(tabId);
  queueGenerations.set(tabId, (queueGenerations.get(tabId) ?? 0) + 1);
  operationTails.delete(tabId);
  pendingCounts.delete(tabId);
  useProjectBrowserStore.getState().setActivity(tabId, null);
  await tail?.catch(() => undefined);
}
