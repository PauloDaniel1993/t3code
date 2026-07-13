import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { type EnvironmentId, PreviewTabId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cancelAndDrainProjectBrowserOperations,
  listProjectBrowserTabsForThread,
  resolveActiveProjectBrowserTab,
  resolveAuthorizedProjectBrowserTab,
  runSerializedProjectBrowserOperation,
} from "./projectBrowserAutomation";
import type { ProjectBrowserTab } from "./projectBrowserState";

const env1 = "env-1" as EnvironmentId;
const env2 = "env-2" as EnvironmentId;
const projectId = ProjectId.make("project-1");
const thread1 = ThreadId.make("thread-1");
const thread2 = ThreadId.make("thread-2");
const outsideThread = ThreadId.make("outside");
const canonicalKey = "github.com/acme/repo";
const project = (environmentId: EnvironmentId, id: ProjectId): EnvironmentProject =>
  ({
    id,
    environmentId,
    title: "Repo",
    workspaceRoot: `/repo/${environmentId}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    repositoryIdentity: {
      canonicalKey,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: canonicalKey },
      rootPath: `/repo/${environmentId}`,
      name: "repo",
      displayName: "Repo",
    },
  }) as unknown as EnvironmentProject;
const thread = (
  environmentId: EnvironmentId,
  id: ThreadId,
  ownerProjectId: ProjectId,
): EnvironmentThreadShell =>
  ({
    id,
    environmentId,
    projectId: ownerProjectId,
    title: String(id),
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: null,
    branch: null,
    worktreePath: null,
    session: null,
  }) as unknown as EnvironmentThreadShell;
const backing = scopeThreadRef(env1, thread1);
const sharedTab: ProjectBrowserTab = {
  tabId: PreviewTabId.make("tab-1"),
  originThreadRef: backing,
  backingThreadRef: backing,
  physicalProjectKey: "physical-1",
};
const projects = [project(env1, projectId), project(env2, projectId)];
const threads = [
  thread(env1, thread1, projectId),
  thread(env2, thread2, projectId),
  thread(env1, outsideThread, ProjectId.make("other")),
];
const settings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};
const runtimeByProjectKey = {
  [canonicalKey]: { tabs: [sharedTab], activeTabId: sharedTab.tabId },
};

describe("projectBrowserAutomation", () => {
  it("authorizes a same logical project thread across environments", () => {
    expect(
      resolveAuthorizedProjectBrowserTab({
        tabId: sharedTab.tabId,
        requestingThreadRef: scopeThreadRef(env2, thread2),
        runtimeByProjectKey,
        projects,
        threads,
        settings,
      }),
    ).toEqual(sharedTab);
  });

  it("rejects a thread outside the logical project", () => {
    expect(
      resolveAuthorizedProjectBrowserTab({
        tabId: sharedTab.tabId,
        requestingThreadRef: scopeThreadRef(env1, outsideThread),
        runtimeByProjectKey,
        projects,
        threads,
        settings,
      }),
    ).toBeNull();
  });

  it("discovers only the requesting project's tabs and resolves its active tab", () => {
    const input = {
      requestingThreadRef: scopeThreadRef(env2, thread2),
      runtimeByProjectKey,
      projects,
      threads,
      settings,
    };
    expect(resolveActiveProjectBrowserTab(input)).toEqual(sharedTab);
    expect(
      listProjectBrowserTabsForThread({
        ...input,
        metadataByTabId: { [sharedTab.tabId]: { title: "App", url: "http://localhost:5173" } },
      }),
    ).toEqual({
      tabs: [
        {
          tabId: sharedTab.tabId,
          title: "App",
          url: "http://localhost:5173",
          active: true,
          backingEnvironmentId: env1,
        },
      ],
      activeTabId: sharedTab.tabId,
    });
  });

  it("serializes operations on one tab", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = runSerializedProjectBrowserOperation({
      tab: sharedTab,
      requestId: "one",
      operation: "navigate",
      controllerThreadRef: backing,
      run: async () => {
        order.push("first-start");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push("first-end");
      },
    });
    const second = runSerializedProjectBrowserOperation({
      tab: sharedTab,
      requestId: "two",
      operation: "click",
      controllerThreadRef: backing,
      run: async () => {
        order.push("second");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("runs different tabs independently", async () => {
    let releaseFirst!: () => void;
    const first = runSerializedProjectBrowserOperation({
      tab: sharedTab,
      requestId: "first-tab",
      operation: "navigate",
      controllerThreadRef: backing,
      run: () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    });
    let secondRan = false;
    const second = runSerializedProjectBrowserOperation({
      tab: { ...sharedTab, tabId: PreviewTabId.make("tab-2") },
      requestId: "second-tab",
      operation: "click",
      controllerThreadRef: backing,
      run: async () => {
        secondRan = true;
      },
    });

    await second;
    expect(secondRan).toBe(true);
    releaseFirst();
    await first;
  });

  it("cancels queued work and drains the running operation before close", async () => {
    let releaseRunning!: () => void;
    const running = runSerializedProjectBrowserOperation({
      tab: sharedTab,
      requestId: "running",
      operation: "navigate",
      controllerThreadRef: backing,
      run: () =>
        new Promise<void>((resolve) => {
          releaseRunning = resolve;
        }),
    });
    let queuedRan = false;
    const queued = runSerializedProjectBrowserOperation({
      tab: sharedTab,
      requestId: "queued",
      operation: "click",
      controllerThreadRef: backing,
      run: async () => {
        queuedRan = true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const drain = cancelAndDrainProjectBrowserOperations(sharedTab.tabId);
    releaseRunning();
    await running;
    await expect(queued).rejects.toThrow("was cancelled");
    await drain;
    expect(queuedRan).toBe(false);
  });
});
