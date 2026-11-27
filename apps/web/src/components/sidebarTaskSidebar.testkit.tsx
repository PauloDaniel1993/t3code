import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadActions } from "../hooks/useThreadActions";
import { createLocalApi, readLocalApi } from "../localApi";
import {
  readThreadShell,
  useProjects,
  useQuietThreadShells,
  useServerConfigs,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { threadTriagePermitted } from "../state/use-orchestration-command";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useUiStateStore } from "../uiStateStore";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../hooks/useThreadActions", { spy: true });
vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/use-orchestration-command", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../localApi", { spy: true });
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

export const sidebarTestEnvironmentId = EnvironmentId.make("local");

export function setupTaskSidebar(
  stack: DisposableStack,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  currentThread?: EnvironmentThreadShell,
) {
  const environmentId = sidebarTestEnvironmentId;
  const previousSettings = getClientSettings();
  const { sidebarTaskGroupsExpandedById, sidebarProjectScopeKeys } = useUiStateStore.getState();
  const previousSelection = useThreadSelectionStore.getState();
  stack.defer(() => {
    __setClientSettingsForTests(previousSettings);
    useUiStateStore.setState({ sidebarTaskGroupsExpandedById, sidebarProjectScopeKeys });
    useThreadSelectionStore.setState(previousSelection);
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    sidebarTaskSubthreadsEnabled: true,
    confirmThreadDelete: false,
  });
  useUiStateStore.setState({
    sidebarTaskGroupsExpandedById: { "local:parent": false },
    sidebarProjectScopeKeys: ["local:/workspace/shown"],
  });
  useThreadSelectionStore.getState().clearSelection();

  vi.mocked(useProjects).mockReturnValue(
    ["shown", "hidden"].map((id) => ({
      id: ProjectId.make(id),
      environmentId,
      title: id,
      workspaceRoot: `/workspace/${id}`,
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-09-29T00:00:00Z",
      updatedAt: "2026-09-29T00:00:00Z",
    })),
  );
  vi.mocked(useQuietThreadShells).mockReturnValue(threads);
  vi.mocked(readThreadShell).mockImplementation(
    (ref) =>
      threads.find(
        (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
      ) ?? null,
  );
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(environmentId);
  vi.mocked(useServerConfigs).mockReturnValue(
    new Map([
      [
        environmentId,
        {
          scratchWorkspaceRoot: null,
          shellThreadFamilies: false,
          environment: { capabilities: { threadTasks: true } },
        } as unknown as EnvironmentServerConfig,
      ],
    ]),
  );
  vi.mocked(readEnvironmentScope).mockReturnValue(true);
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  vi.mocked(threadTriagePermitted).mockReturnValue(true);

  const localApi = createLocalApi();
  const menu = vi.spyOn(localApi.contextMenu, "show");
  vi.mocked(readLocalApi).mockReturnValue(localApi);
  const newThread = vi.fn().mockResolvedValue(null);
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    defaultProjectFallbackReady: true,
    handleNewThread: newThread,
    routeDraftId: null,
    routeThreadRef: currentThread ? { environmentId, threadId: currentThread.id } : null,
  });
  const deleteThread = vi.fn(async (_ref: ScopedThreadRef, _opts?: unknown) =>
    AsyncResult.success({ sequence: 1 }),
  );
  const settleThread = vi.fn(async (_ref: ScopedThreadRef) => AsyncResult.success({ sequence: 1 }));
  const unexpectedAction = async () => {
    throw new Error("Unexpected thread action");
  };
  vi.mocked(useThreadActions).mockReturnValue({
    deleteThread,
    settleThread,
    archiveThread: unexpectedAction,
    unarchiveThread: unexpectedAction,
    confirmAndDeleteThread: unexpectedAction,
    unsettleThread: unexpectedAction,
    snoozeThread: unexpectedAction,
    unsnoozeThread: unexpectedAction,
    pinThread: unexpectedAction,
    unpinThread: unexpectedAction,
    confirmAndUnpinThread: unexpectedAction,
    reorderPinnedThread: unexpectedAction,
    reorderActiveThread: unexpectedAction,
    markThreadUnread: unexpectedAction,
    setThreadAutoSettle: unexpectedAction,
    turnThreadIntoProject: unexpectedAction,
  });

  const rootRoute = createRootRoute();
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$environmentId/$threadId",
    component: () => (
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([threadRoute]),
    history: createMemoryHistory({
      initialEntries: [`/${environmentId}/${currentThread?.id ?? "unopened"}`],
    }),
    disableGlobalCatchBoundary: true,
  });
  return { deleteThread, settleThread, menu, newThread, router };
}
