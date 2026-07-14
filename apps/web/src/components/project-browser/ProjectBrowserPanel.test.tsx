import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useProjectBrowserStore } from "~/projectBrowserStore";

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("~/state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: () => {},
  useThreadPreviewState: () => ({
    sessions: {
      "tab-1": {
        tabId: "tab-1",
        navStatus: { _tag: "Success", url: "https://example.com", title: "Example App" },
      },
    },
  }),
}));
vi.mock("~/components/preview/PreviewPanel", () => ({
  PreviewPanel: ({ tabId }: { tabId: string }) => <div data-testid="preview">{tabId}</div>,
}));
vi.mock("~/browser/browserRecording", () => ({
  readActiveBrowserRecordingTabId: () => null,
  stopBrowserRecording: async () => null,
}));

import { ProjectBrowserPanel } from "./ProjectBrowserPanel";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));

beforeEach(() => {
  useProjectBrowserStore.setState({
    runtimeByProjectKey: {
      repo: {
        tabs: [
          {
            tabId: "tab-1",
            originThreadRef: threadRef,
            backingThreadRef: threadRef,
            physicalProjectKey: "physical",
          },
        ],
        activeTabId: "tab-1",
      },
    },
    layoutByProjectKey: {
      repo: { isOpen: true, width: 500, updateSequence: 1 },
    },
    activityByTabId: {
      "tab-1": {
        requestId: "request-1",
        operation: "click",
        controllerThreadRef: threadRef,
      },
    },
    routeByTabId: {},
    nextLayoutSequence: 1,
  });
});

describe("ProjectBrowserPanel", () => {
  it("renders the accessible empty state and direct creation controls", () => {
    const html = renderToStaticMarkup(
      <ProjectBrowserPanel
        logicalProjectKey="repo"
        activeThreadRef={threadRef}
        activePhysicalProjectKey="physical"
        overlay={false}
      />,
    );

    expect(html).toContain('aria-label="Project Browser"');
    expect(html).toContain("No project browser tabs");
    expect(html).toContain('aria-label="New project browser tab"');
  });

  it("renders as an overlay on narrow layouts", () => {
    const html = renderToStaticMarkup(
      <ProjectBrowserPanel
        logicalProjectKey="repo"
        activeThreadRef={threadRef}
        activePhysicalProjectKey="physical"
        overlay
      />,
    );
    expect(html).toContain("absolute inset-y-0 right-0");
  });
});
