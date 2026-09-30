// @vitest-environment jsdom
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type WayfinderNode } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { onOpenNewThreadTaskDialog, type OpenNewThreadTaskRequest } from "../../newThreadTaskBus";
import { StarMapTicketDetail } from "./StarMapTicketDetail";
import { buildStarMapGraph } from "./starMapGraph";

const state = vi.hoisted(() => ({ problem: null as string | null }));

vi.mock("~/hooks/useNewThreadTaskAvailability", () => ({
  useNewThreadTaskAvailability: () => ({ problem: state.problem, providers: [] }),
}));
vi.mock("~/components/files/projectFilesQueryState", () => ({
  useProjectFileQuery: () => ({
    data: { contents: "Fix the seam.", truncated: false },
    error: null,
    isPending: false,
  }),
}));
vi.mock("~/components/ChatMarkdown", () => ({ default: () => null }));

const node: WayfinderNode = {
  id: "t5",
  ordinal: 5,
  label: "Repair destination discovery",
  relativePath: ".plan/issues/05-repair-destination.md",
  type: "task",
  status: "open",
  isFrontier: true,
  isUndermined: false,
  claimedBy: null,
  rank: 0,
  cyclic: false,
};
const threadRef = scopeThreadRef(EnvironmentId.make("remote-env"), ThreadId.make("parent"));

let root: Root;
let container: HTMLDivElement;
let requests: OpenNewThreadTaskRequest[];
let stopListening: () => void;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.problem = null;
  requests = [];
  stopListening = onOpenNewThreadTaskDialog((request) => requests.push(request));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  stopListening();
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderDetail() {
  await act(async () =>
    root.render(
      <StarMapTicketDetail
        environmentId={threadRef.environmentId}
        cwd="/workspace"
        graph={buildStarMapGraph({ nodes: [node], edges: [] })}
        node={node}
        threadRef={threadRef}
        onSelectTicket={() => undefined}
      />,
    ),
  );
}

function openAsTask() {
  return container.querySelector<HTMLElement>(
    '[aria-label="Open Repair destination discovery as a task"]',
  )!;
}

describe("StarMapTicketDetail Open as task", () => {
  it("sends the open request for the panel's thread when available", async () => {
    await renderDetail();

    await act(async () => openAsTask().click());

    expect(requests).toHaveLength(1);
    expect(requests[0]!.threadRef).toEqual(threadRef);
    expect(requests[0]!.initialDraft?.title).toBe(node.label);
    expect(requests[0]!.initialDraft?.prompt).toContain("Fix the seam.");
  });

  it("gives the element keyboard focus reaches its name and the reason, and does nothing when activated", async () => {
    state.problem = "Connect to this thread's environment to request a task.";
    await renderDetail();

    const action = openAsTask();
    await act(async () => action.focus());

    // The focused element is the action itself, not an anonymous wrapper around it.
    expect(document.activeElement).toBe(action);
    expect(action.getAttribute("aria-label")).toBe("Open Repair destination discovery as a task");
    expect(action.getAttribute("aria-disabled")).toBe("true");
    const description = document.getElementById(action.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe(state.problem);

    // Enter and Space on a focused button reach the handler as this click.
    await act(async () => action.click());
    expect(requests).toHaveLength(0);
  });

  it("becomes usable again once the thread can take a task", async () => {
    state.problem = "Wait for the thread to load.";
    await renderDetail();
    await act(async () => openAsTask().click());
    expect(requests).toHaveLength(0);

    state.problem = null;
    await renderDetail();

    expect(openAsTask().hasAttribute("aria-disabled")).toBe(false);
    expect(openAsTask().hasAttribute("aria-describedby")).toBe(false);
    await act(async () => openAsTask().click());
    expect(requests).toHaveLength(1);
  });
});
