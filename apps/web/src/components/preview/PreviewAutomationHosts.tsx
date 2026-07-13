"use client";

import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_AUTOMATION_OPERATIONS,
  type EnvironmentId,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationResizeInput,
  type PreviewAutomationResizeResult,
  type PreviewAutomationHost as PreviewAutomationHostState,
  type PreviewAutomationRequest,
  type PreviewAutomationStatus,
  type PreviewAutomationTabList,
  type PreviewRenderedViewportSize,
  type PreviewViewportSetting,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Atom } from "effect/unstable/reactivity";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { resolveBrowserNavigationTarget } from "~/browser/browserTargetResolver";
import {
  readActiveBrowserRecordingTabId,
  startBrowserRecording,
  stopBrowserRecording,
} from "~/browser/browserRecording";
import { resolveBrowserRecordingStopTarget } from "~/browser/browserRecordingScope";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { isElectron } from "~/env";
import { useClientSettings } from "~/clientSettingsStore";
import { selectProjectGroupingSettings } from "~/logicalProject";
import {
  listProjectBrowserTabsForThread,
  resolveActiveProjectBrowserTab,
  resolveAuthorizedProjectBrowserTab,
  runSerializedProjectBrowserOperation,
} from "~/projectBrowserAutomation";
import { findProjectBrowserTab } from "~/projectBrowserState";
import { useProjectBrowserStore } from "~/projectBrowserStore";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useAtomCommand } from "~/state/use-atom-command";

import { previewBridge } from "./previewBridge";
import {
  PreviewAutomationNavigationTimeoutError,
  PreviewAutomationOperationError,
  PreviewAutomationOverlayTimeoutError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationViewportTimeoutError,
} from "./previewAutomationErrors";
import { previewAutomationOpenNeedsOverlay } from "./previewAutomationOpenReadiness";
import { createPreviewAutomationRequestConsumerAtom } from "./previewAutomationRequestConsumer";
import { createPreviewAutomationClientId } from "./previewAutomationClientId";
import {
  needsPreviewAutomationSessionSync,
  resolvePreviewAutomationOpenTab,
  resolvePreviewAutomationTarget,
} from "./previewAutomationTarget";
import { isPreviewViewportReady } from "./previewViewportReadiness";

const waitForDesktopOverlay = async (
  threadRef: ScopedThreadRef,
  requestId: string,
  tabId: string,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = readThreadPreviewState(threadRef);
    if (state.desktopByTabId[tabId] && previewBridge) {
      const status = await previewBridge.automation.status(tabId);
      if (status.available) return;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  throw new PreviewAutomationOverlayTimeoutError({
    requestId,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    timeoutMs,
  });
};

const waitForNavigationReadiness = async (
  threadRef: ScopedThreadRef,
  requestId: string,
  tabId: string,
  readiness: PreviewAutomationNavigateInput["readiness"],
  timeoutMs: number,
): Promise<void> => {
  const targetReadiness = readiness ?? "load";
  if (!previewBridge || targetReadiness === "none") return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (targetReadiness === "domContentLoaded") {
      const readyState = await previewBridge.automation.evaluate(tabId, {
        expression: "document.readyState",
      });
      if (readyState === "interactive" || readyState === "complete") return;
    } else {
      const status = await previewBridge.automation.status(tabId);
      if (!status.loading) return;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  throw new PreviewAutomationNavigationTimeoutError({
    requestId,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    tabId,
    readiness: targetReadiness,
    timeoutMs,
  });
};

interface ExecutablePreviewWebview extends Element {
  readonly executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
}

const findPreviewWebview = (tabId: string): ExecutablePreviewWebview | null =>
  Array.from(document.querySelectorAll<ExecutablePreviewWebview>("webview[data-preview-tab]")).find(
    (candidate) => candidate.getAttribute("data-preview-tab") === tabId,
  ) ?? null;

const readWebviewViewport = async (
  webview: ExecutablePreviewWebview,
): Promise<PreviewRenderedViewportSize | null> => {
  const value = await webview.executeJavaScript(
    "({ width: window.innerWidth, height: window.innerHeight })",
  );
  if (typeof value !== "object" || value === null) return null;
  const { width, height } = value as { readonly width?: unknown; readonly height?: unknown };
  return typeof width === "number" &&
    Number.isInteger(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isInteger(height) &&
    height > 0
    ? { width, height }
    : null;
};

const readRenderedViewport = async (tabId: string): Promise<PreviewRenderedViewportSize | null> => {
  const webview = findPreviewWebview(tabId);
  if (!webview) return null;
  return await readWebviewViewport(webview);
};

const readDeclaredViewport = (
  webview: ExecutablePreviewWebview | null,
): PreviewRenderedViewportSize | null => {
  const width = Number(webview?.getAttribute("data-preview-css-width"));
  const height = Number(webview?.getAttribute("data-preview-css-height"));
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    ? { width, height }
    : null;
};

const waitForRenderedViewport = async (
  tabId: string,
  setting: PreviewViewportSetting,
  timeoutMs: number,
  context: {
    readonly requestId: PreviewAutomationRequest["requestId"];
    readonly environmentId: EnvironmentId;
    readonly threadId: PreviewAutomationRequest["threadId"];
  },
): Promise<PreviewRenderedViewportSize> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const webview = findPreviewWebview(tabId);
      const appliedSettingKey = webview?.getAttribute("data-preview-viewport-key") ?? null;
      const declaredViewport = readDeclaredViewport(webview);
      const renderedViewport = webview ? await readWebviewViewport(webview) : null;
      if (
        renderedViewport &&
        isPreviewViewportReady({
          setting,
          appliedSettingKey,
          declaredViewport,
          renderedViewport,
        })
      ) {
        return renderedViewport;
      }
    } catch {
      // Registration and navigation can transiently replace the guest while
      // React applies the server snapshot. Retry until the operation deadline.
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  throw new PreviewAutomationViewportTimeoutError({
    ...context,
    tabId,
    timeoutMs,
  });
};

const currentStatus = async (
  threadRef: ScopedThreadRef,
  requestedTabId: string | null,
): Promise<PreviewAutomationStatus> => {
  const state = readThreadPreviewState(threadRef);
  const { snapshot, tabId } = resolvePreviewAutomationTarget(state, requestedTabId);
  const visible = tabId
    ? (useBrowserSurfaceStore.getState().byTabId[tabId]?.visible ?? false)
    : false;
  const viewportSetting = snapshot ? (snapshot.viewport ?? FILL_PREVIEW_VIEWPORT) : undefined;
  const viewport = tabId ? await readRenderedViewport(tabId).catch(() => null) : null;
  const viewportStatus = {
    ...(viewportSetting === undefined ? {} : { viewportSetting }),
    ...(viewport === null ? {} : { viewport }),
  };
  if (tabId && previewBridge && state.desktopByTabId[tabId]) {
    const status = await previewBridge.automation.status(tabId);
    return { ...status, visible, ...viewportStatus };
  }
  const navStatus = snapshot?.navStatus;
  return {
    available: Boolean(previewBridge?.automation),
    visible,
    tabId,
    url: navStatus && navStatus._tag !== "Idle" ? navStatus.url : null,
    title: navStatus && navStatus._tag !== "Idle" ? navStatus.title : null,
    loading: navStatus?._tag === "Loading",
    ...viewportStatus,
  };
};

const raiseAtomCommandFailure = (result: Parameters<typeof squashAtomCommandFailure>[0]): never => {
  throw squashAtomCommandFailure(result);
};

const raisePreviewAutomationHostError = (
  error: PreviewAutomationRecordingNotActiveError,
): never => {
  throw error;
};

export function PreviewAutomationHosts() {
  const { environments } = useEnvironments();
  if (!isElectron || !previewBridge?.automation) return null;
  return (
    <>
      {/*
       * Host lifetime follows the desktop runtime's environment connections,
       * not the routed thread. This keeps background threads automatable and
       * lets the subscription runtime own reconnects for every saved target.
       */}
      {environments.map((environment) => (
        <PreviewAutomationHost
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ))}
    </>
  );
}

function PreviewAutomationHost(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const registry = useContext(RegistryContext);
  const projects = useProjects();
  const threads = useThreadShells();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectTabRouteByTabId = useProjectBrowserStore((state) => state.routeByTabId);
  // Derived with useMemo instead of an inline selector: building fresh route
  // objects inside the selector makes every store snapshot compare unequal,
  // which useSyncExternalStore escalates to an infinite re-render loop.
  const projectTabRoutes = useMemo(
    () =>
      Object.entries(projectTabRouteByTabId).flatMap(([tabId, route]) =>
        route.backingThreadRef.environmentId === environmentId
          ? [
              {
                tabId,
                backingEnvironmentId: route.backingThreadRef.environmentId,
                backingThreadId: route.backingThreadRef.threadId,
              },
            ]
          : [],
      ),
    [environmentId, projectTabRouteByTabId],
  );
  const [automationClientId] = useState(createPreviewAutomationClientId);
  const initialAutomationHost = useMemo<PreviewAutomationHostState>(
    () => ({
      clientId: automationClientId,
      environmentId,
      supportedOperations: [...PREVIEW_AUTOMATION_OPERATIONS],
    }),
    [automationClientId, environmentId],
  );
  const automationRequestsAtom = previewEnvironment.automationRequests({
    environmentId,
    input: initialAutomationHost,
  });
  const listPreviews = useAtomQueryRunner(previewEnvironment.list, {
    reportFailure: false,
  });
  const open = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const resize = useAtomCommand(previewEnvironment.resize, {
    reportFailure: false,
  });
  const respondToAutomation = useAtomCommand(
    previewEnvironment.respondToAutomation,
    "preview automation response",
  );
  const focusAutomationHost = useAtomCommand(
    previewEnvironment.focusAutomationHost,
    "preview automation host focus",
  );
  const syncAutomationProjectTabs = useAtomCommand(
    previewEnvironment.syncAutomationProjectTabs,
    "preview automation project tabs",
  );
  const [automationConnectionAtom] = useState(() => Atom.make<string | null>(null));
  const automationConnectionId = useAtomValue(automationConnectionAtom);

  const handleRequest = useCallback(
    async (request: PreviewAutomationRequest): Promise<unknown> => {
      const requestingThreadRef: ScopedThreadRef = {
        environmentId: request.requestingEnvironmentId ?? environmentId,
        threadId: request.threadId,
      };
      const runtimeByProjectKey = useProjectBrowserStore.getState().runtimeByProjectKey;
      if (request.operation === "listTabs") {
        const metadataByTabId = Object.fromEntries(
          Object.values(runtimeByProjectKey).flatMap((runtime) =>
            runtime.tabs.map((tab) => {
              const snapshot = readThreadPreviewState(tab.backingThreadRef).sessions[tab.tabId];
              return [
                tab.tabId,
                {
                  title:
                    snapshot?.navStatus._tag === "Idle" ? "" : (snapshot?.navStatus.title ?? ""),
                  url:
                    snapshot?.navStatus._tag === "Idle" ? null : (snapshot?.navStatus.url ?? null),
                },
              ];
            }),
          ),
        );
        return listProjectBrowserTabsForThread({
          requestingThreadRef,
          runtimeByProjectKey,
          metadataByTabId,
          projects,
          threads,
          settings: projectGroupingSettings,
        }) satisfies PreviewAutomationTabList;
      }
      const existingProjectTab = request.tabId
        ? findProjectBrowserTab(runtimeByProjectKey, request.tabId)
        : null;
      const implicitProjectTabAllowed =
        request.operation !== "open" ||
        (request.input as PreviewAutomationOpenInput).reuseExistingTab !== false;
      const projectTab = request.tabId
        ? resolveAuthorizedProjectBrowserTab({
            tabId: request.tabId,
            requestingThreadRef,
            runtimeByProjectKey,
            projects,
            threads,
            settings: projectGroupingSettings,
          })
        : implicitProjectTabAllowed
          ? resolveActiveProjectBrowserTab({
              requestingThreadRef,
              runtimeByProjectKey,
              projects,
              threads,
              settings: projectGroupingSettings,
            })
          : null;
      if (existingProjectTab && !projectTab) {
        throw new Error(`Thread ${request.threadId} cannot access project tab ${request.tabId}.`);
      }
      const threadRef: ScopedThreadRef = projectTab?.backingThreadRef ?? {
        environmentId: request.backingEnvironmentId ?? environmentId,
        threadId: request.backingThreadId ?? request.threadId,
      };
      const targetEnvironmentId = threadRef.environmentId;
      const targetThreadId = threadRef.threadId;
      let tabId = projectTab?.tabId ?? request.tabId ?? null;
      const execute = async (): Promise<unknown> => {
        try {
          let state = readThreadPreviewState(threadRef);
          const needsSessionSync = needsPreviewAutomationSessionSync(state, tabId ?? undefined);
          if (needsSessionSync) {
            const listTarget = {
              environmentId: targetEnvironmentId,
              input: { threadId: targetThreadId },
            } as const;
            registry.refresh(previewEnvironment.list(listTarget));
            const result = await listPreviews(listTarget);
            if (result._tag === "Failure") {
              return raiseAtomCommandFailure(result);
            }
            reconcilePreviewServerSessions(threadRef, result.value.sessions);
            state = readThreadPreviewState(threadRef);
          }
          tabId = tabId ?? state.snapshot?.tabId ?? null;
          const unavailableTarget = {
            requestId: request.requestId,
            operation: request.operation,
            environmentId: targetEnvironmentId,
            threadId: targetThreadId,
            tabId,
            bridgeAvailable: Boolean(previewBridge),
          };
          const requireReadyTab = async () => {
            const bridge = previewBridge;
            const readyTabId = tabId;
            if (!bridge || !readyTabId) {
              throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
            }
            await waitForDesktopOverlay(
              threadRef,
              request.requestId,
              readyTabId,
              request.timeoutMs,
            );
            return { bridge, tabId: readyTabId };
          };
          switch (request.operation) {
            case "listTabs":
              return { tabs: [], activeTabId: null } satisfies PreviewAutomationTabList;
            case "status":
              return await currentStatus(threadRef, tabId);
            case "open": {
              const input = request.input as PreviewAutomationOpenInput;
              let activeTabId = resolvePreviewAutomationOpenTab(
                state,
                tabId ?? undefined,
                input.reuseExistingTab ?? true,
              );
              let activeSnapshot = activeTabId
                ? (state.sessions[activeTabId] ?? state.snapshot ?? undefined)
                : undefined;
              const reusedExistingTab = activeTabId !== null;
              tabId = activeTabId;
              if (!activeTabId) {
                const result = await open({
                  environmentId: targetEnvironmentId,
                  input: {
                    threadId: targetThreadId,
                    ...(input.url ? { url: input.url } : {}),
                  },
                });
                if (result._tag === "Failure") {
                  return raiseAtomCommandFailure(result);
                }
                const snapshot = result.value;
                applyPreviewServerSnapshot(threadRef, snapshot);
                activeTabId = snapshot.tabId;
                activeSnapshot = snapshot;
                tabId = activeTabId;
              }
              if (input.show ?? true) {
                const projectOwner = findProjectBrowserTab(
                  useProjectBrowserStore.getState().runtimeByProjectKey,
                  activeTabId,
                );
                if (projectOwner) {
                  useProjectBrowserStore.getState().show(projectOwner.logicalProjectKey);
                } else {
                  useRightPanelStore.getState().openBrowser(threadRef, activeTabId);
                }
              }
              if (activeSnapshot && previewAutomationOpenNeedsOverlay(input, activeSnapshot)) {
                await waitForDesktopOverlay(
                  threadRef,
                  request.requestId,
                  activeTabId,
                  request.timeoutMs,
                );
              }
              if (reusedExistingTab && input.url && previewBridge) {
                const resolution = resolveBrowserNavigationTarget(targetEnvironmentId, {
                  kind: "url",
                  url: input.url,
                });
                await previewBridge.navigate(activeTabId, resolution.resolvedUrl);
                await waitForNavigationReadiness(
                  threadRef,
                  request.requestId,
                  activeTabId,
                  "load",
                  request.timeoutMs,
                );
              }
              return await currentStatus(threadRef, activeTabId);
            }
            case "navigate": {
              const ready = await requireReadyTab();
              const input = request.input as PreviewAutomationNavigateInput;
              const resolution = resolveBrowserNavigationTarget(
                targetEnvironmentId,
                input.target ?? {
                  kind: "url",
                  url: input.url!,
                },
              );
              await ready.bridge.navigate(ready.tabId, resolution.resolvedUrl);
              await waitForNavigationReadiness(
                threadRef,
                request.requestId,
                ready.tabId,
                input.readiness ?? "load",
                input.timeoutMs ?? request.timeoutMs,
              );
              return await currentStatus(threadRef, ready.tabId);
            }
            case "resize": {
              const ready = await requireReadyTab();
              const input = request.input as PreviewAutomationResizeInput;
              const setting = resolvePreviewViewport(input);
              const result = await resize({
                environmentId: targetEnvironmentId,
                input: {
                  threadId: targetThreadId,
                  tabId: ready.tabId,
                  viewport: setting,
                },
              });
              if (result._tag === "Failure") {
                return raiseAtomCommandFailure(result);
              }
              updatePreviewServerSnapshot(threadRef, result.value);
              const viewport = await waitForRenderedViewport(
                ready.tabId,
                setting,
                input.timeoutMs ?? request.timeoutMs,
                {
                  requestId: request.requestId,
                  environmentId: targetEnvironmentId,
                  threadId: targetThreadId,
                },
              );
              return {
                tabId: ready.tabId,
                setting,
                viewport,
              } satisfies PreviewAutomationResizeResult;
            }
            case "snapshot": {
              const ready = await requireReadyTab();
              return await ready.bridge.automation.snapshot(ready.tabId);
            }
            case "click": {
              const ready = await requireReadyTab();
              return await ready.bridge.automation.click(
                ready.tabId,
                request.input as Parameters<typeof ready.bridge.automation.click>[1],
              );
            }
            case "type": {
              const ready = await requireReadyTab();
              return await ready.bridge.automation.type(
                ready.tabId,
                request.input as Parameters<typeof ready.bridge.automation.type>[1],
              );
            }
            case "press": {
              const ready = await requireReadyTab();
              return await ready.bridge.automation.press(
                ready.tabId,
                request.input as Parameters<typeof ready.bridge.automation.press>[1],
              );
            }
            case "scroll": {
              const ready = await requireReadyTab();
              return await ready.bridge.automation.scroll(
                ready.tabId,
                request.input as Parameters<typeof ready.bridge.automation.scroll>[1],
              );
            }
            case "evaluate": {
              const ready = await requireReadyTab();
              return await ready.bridge.automation.evaluate(
                ready.tabId,
                request.input as Parameters<typeof ready.bridge.automation.evaluate>[1],
              );
            }
            case "waitFor": {
              const ready = await requireReadyTab();
              return await ready.bridge.automation.waitFor(
                ready.tabId,
                request.input as Parameters<typeof ready.bridge.automation.waitFor>[1],
              );
            }
            case "recordingStart": {
              const ready = await requireReadyTab();
              const startedAt = await startBrowserRecording(ready.tabId);
              return {
                tabId: ready.tabId,
                recording: true,
                startedAt,
              };
            }
            case "recordingStop": {
              const recordingTabId = readActiveBrowserRecordingTabId();
              const stopTabId = resolveBrowserRecordingStopTarget(
                recordingTabId,
                request.tabIdExplicit ? request.tabId : undefined,
              );
              const artifact = stopTabId ? await stopBrowserRecording(stopTabId) : null;
              if (!artifact) {
                return raisePreviewAutomationHostError(
                  new PreviewAutomationRecordingNotActiveError({
                    requestId: request.requestId,
                    environmentId: targetEnvironmentId,
                    threadId: targetThreadId,
                    tabId,
                  }),
                );
              }
              return artifact;
            }
          }
        } catch (cause) {
          throw PreviewAutomationOperationError.fromCause({
            requestId: request.requestId,
            operation: request.operation,
            environmentId: targetEnvironmentId,
            threadId: targetThreadId,
            tabId,
            cause,
          });
        }
      };
      return projectTab
        ? runSerializedProjectBrowserOperation({
            tab: projectTab,
            requestId: request.requestId,
            operation: request.operation,
            controllerThreadRef: requestingThreadRef,
            run: execute,
          })
        : execute();
    },
    [
      environmentId,
      listPreviews,
      open,
      projectGroupingSettings,
      projects,
      registry,
      resize,
      threads,
    ],
  );
  const [requestHandlerAtom] = useState(() => Atom.make({ handle: handleRequest }));
  const setRequestHandler = useAtomSet(requestHandlerAtom);
  useEffect(() => {
    setRequestHandler({ handle: handleRequest });
  }, [handleRequest, setRequestHandler]);

  const automationRequestConsumerAtom = useMemo(
    () =>
      createPreviewAutomationRequestConsumerAtom({
        requestsAtom: automationRequestsAtom,
        clientId: automationClientId,
        connectionAtom: automationConnectionAtom,
        environmentId,
        requestHandlerAtom,
        respond: (response) =>
          respondToAutomation({
            environmentId,
            input: response,
          }),
        label: `preview:automation-host:${environmentId}:${automationClientId}`,
      }),
    [
      automationClientId,
      automationConnectionAtom,
      automationRequestsAtom,
      requestHandlerAtom,
      respondToAutomation,
      environmentId,
    ],
  );
  useAtomValue(automationRequestConsumerAtom);

  useEffect(() => {
    const report = () => {
      if (!automationConnectionId) return;
      void focusAutomationHost({
        environmentId,
        input: {
          clientId: automationClientId,
          environmentId,
          connectionId: automationConnectionId,
          focused: document.hasFocus(),
        },
      });
    };
    report();
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
    };
  }, [automationClientId, automationConnectionId, environmentId, focusAutomationHost]);

  useEffect(() => {
    if (!automationConnectionId) return;
    void syncAutomationProjectTabs({
      environmentId,
      input: {
        clientId: automationClientId,
        environmentId,
        connectionId: automationConnectionId,
        routes: projectTabRoutes,
      },
    });
  }, [
    automationClientId,
    automationConnectionId,
    environmentId,
    projectTabRoutes,
    syncAutomationProjectTabs,
  ]);

  return null;
}
