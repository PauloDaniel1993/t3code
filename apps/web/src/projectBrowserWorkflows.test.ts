import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";
import { useProjectBrowserStore } from "./projectBrowserStore";
import {
  projectBrowserCloseNeedsConfirmation,
  promoteRightPanelBrowserToProject,
  unpinProjectBrowserTabToOrigin,
} from "./projectBrowserWorkflows";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
  useProjectBrowserStore.setState({
    runtimeByProjectKey: {},
    layoutByProjectKey: {},
    activityByTabId: {},
    routeByTabId: {},
    nextLayoutSequence: 0,
  });
});

describe("project browser workflows", () => {
  it("atomically promotes one existing right-panel browser surface", () => {
    useRightPanelStore.getState().openBrowser(threadRef, "tab-1");
    expect(
      promoteRightPanelBrowserToProject({
        logicalProjectKey: "repo",
        physicalProjectKey: "physical",
        threadRef,
        surface: { id: "browser:tab-1", kind: "preview", resourceId: "tab-1" },
      }),
    ).toBe(true);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([]);
    expect(useProjectBrowserStore.getState().runtimeByProjectKey.repo?.tabs[0]?.tabId).toBe(
      "tab-1",
    );
  });

  it("returns the same live tab to its origin", () => {
    useRightPanelStore.getState().openBrowser(threadRef, "tab-1");
    promoteRightPanelBrowserToProject({
      logicalProjectKey: "repo",
      physicalProjectKey: "physical",
      threadRef,
      surface: { id: "browser:tab-1", kind: "preview", resourceId: "tab-1" },
    });
    expect(unpinProjectBrowserTabToOrigin("tab-1")).toBe(true);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([{ id: "browser:tab-1", kind: "preview", resourceId: "tab-1" }]);
  });

  it("guards close only for recording or active automation", () => {
    expect(projectBrowserCloseNeedsConfirmation({ activity: null, recording: false })).toBe(false);
    expect(projectBrowserCloseNeedsConfirmation({ activity: null, recording: true })).toBe(true);
    expect(
      projectBrowserCloseNeedsConfirmation({
        recording: false,
        activity: {
          requestId: "request",
          operation: "click",
          controllerThreadRef: threadRef,
        },
      }),
    ).toBe(true);
  });
});
