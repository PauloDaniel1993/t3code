import type { ScopedThreadRef } from "@t3tools/contracts";

import type { RightPanelSurface } from "./rightPanelStore";
import { useRightPanelStore } from "./rightPanelStore";
import type { ProjectBrowserTabActivity } from "./projectBrowserState";
import { useProjectBrowserStore } from "./projectBrowserStore";

export function promoteRightPanelBrowserToProject(input: {
  readonly logicalProjectKey: string;
  readonly physicalProjectKey: string;
  readonly threadRef: ScopedThreadRef;
  readonly surface: Extract<RightPanelSurface, { kind: "preview" }>;
}): boolean {
  if (!input.surface.resourceId) return false;
  useProjectBrowserStore.getState().promote(input.logicalProjectKey, {
    tabId: input.surface.resourceId,
    originThreadRef: input.threadRef,
    backingThreadRef: input.threadRef,
    physicalProjectKey: input.physicalProjectKey,
  });
  useRightPanelStore.getState().closeSurface(input.threadRef, input.surface.id);
  return true;
}

export function unpinProjectBrowserTabToOrigin(tabId: string): boolean {
  const tab = useProjectBrowserStore.getState().remove(tabId);
  if (!tab) return false;
  useRightPanelStore.getState().openBrowser(tab.originThreadRef, tab.tabId);
  return true;
}

export function projectBrowserCloseNeedsConfirmation(input: {
  readonly activity: ProjectBrowserTabActivity | null | undefined;
  readonly recording: boolean;
}): boolean {
  return input.activity !== null && input.activity !== undefined ? true : input.recording;
}
