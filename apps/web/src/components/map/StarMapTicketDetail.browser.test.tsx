import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type WayfinderNode } from "@t3tools/contracts";
import { act, render, type Screen } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

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

function setup() {
  state.problem = null;
  const requests: OpenNewThreadTaskRequest[] = [];
  const stopListening = onOpenNewThreadTaskDialog((request) => requests.push(request));
  return { requests, [Symbol.dispose]: stopListening };
}

function detail() {
  return (
    <StarMapTicketDetail
      environmentId={threadRef.environmentId}
      cwd="/workspace"
      graph={buildStarMapGraph({ nodes: [node], edges: [] })}
      node={node}
      threadRef={threadRef}
      onSelectTicket={() => undefined}
    />
  );
}

function openAsTask(screen: Screen) {
  const element = screen
    .getByRole("button", { name: "Open Repair destination discovery as a task" })
    .element();
  if (!(element instanceof HTMLButtonElement)) throw new Error("Expected the task action button");
  return element;
}

describe("StarMapTicketDetail Open as task", () => {
  it("sends the open request for the panel's thread when available", async () => {
    using fixture = setup();
    const { requests } = fixture;
    await using screen = await render(detail());

    await act(async () => openAsTask(screen).click());

    expect(requests).toHaveLength(1);
    expect(requests[0]!.threadRef).toEqual(threadRef);
    expect(requests[0]!.initialDraft?.title).toBe(node.label);
    expect(requests[0]!.initialDraft?.prompt).toContain("Fix the seam.");
  });

  it("gives the element keyboard focus reaches its name and the reason, and does nothing when activated", async () => {
    using fixture = setup();
    const { requests } = fixture;
    state.problem = "Connect to this thread's environment to request a task.";
    await using screen = await render(detail());

    const action = openAsTask(screen);
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
    using fixture = setup();
    const { requests } = fixture;
    state.problem = "Wait for the thread to load.";
    await using screen = await render(detail());
    await act(async () => openAsTask(screen).click());
    expect(requests).toHaveLength(0);

    state.problem = null;
    await screen.rerender(detail());

    expect(openAsTask(screen).hasAttribute("aria-disabled")).toBe(false);
    expect(openAsTask(screen).hasAttribute("aria-describedby")).toBe(false);
    await act(async () => openAsTask(screen).click());
    expect(requests).toHaveLength(1);
  });
});
