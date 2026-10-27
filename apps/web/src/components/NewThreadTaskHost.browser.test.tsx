import { act, render } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import { makeThreadProjectionFixture } from "../test-fixtures";
import { openNewThreadTaskDialog } from "../newThreadTaskBus";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useRightPanelStore } from "../rightPanelStore";
import { NewThreadTaskHost } from "./NewThreadTaskHost";
import { NewThreadTaskAction } from "./NewThreadTaskAction";

const state = vi.hoisted(() => ({
  route: null as ScopedThreadRef | null,
  parents: new Map<string, OrchestrationV2ThreadProjection>(),
  statuses: new Map<string, EnvironmentThreadStatus>(),
  parentListeners: new Set<() => void>(),
  connected: true,
  startTurn: vi.fn(),
  toast: vi.fn(),
}));
const key = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;
const parentStatus = (ref: ScopedThreadRef) =>
  state.statuses.get(key(ref)) ?? (state.parents.has(key(ref)) ? "live" : "synchronizing");

vi.mock("@effect/atom-react", async () => {
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  return {
    useAtomValue: (atom: { kind?: string; ref?: ScopedThreadRef }) =>
      atom.kind === "status" && atom.ref ? parentStatus(atom.ref) : DEFAULT_RESOLVED_KEYBINDINGS,
  };
});
vi.mock("@tanstack/react-router", () => ({
  useParams: () => (state.route ? { kind: "server", threadRef: state.route } : null),
}));
vi.mock("../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../state/server", () => ({
  primaryServerKeybindingsAtom: {},
  serverEnvironment: {
    configValueAtom: (environmentId: string) => ({ kind: "config", environmentId }),
  },
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: { startTurn: {} },
  environmentThreadDetails: {
    threadAtom: (ref: ScopedThreadRef) => ({ kind: "thread", ref }),
    statusAtom: (ref: ScopedThreadRef) => ({ kind: "status", ref }),
  },
}));
vi.mock("../state/presentation", () => ({
  environmentPresentations: {
    presentationAtom: (environmentId: string) => ({ kind: "presentation", environmentId }),
  },
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: { kind: string; ref?: ScopedThreadRef; environmentId?: string }) => {
      if (atom.kind === "thread" && atom.ref) {
        const projection = state.parents.get(`${atom.ref.environmentId}:${atom.ref.threadId}`);
        return projection ? { projection } : null;
      }
      if (atom.kind === "status" && atom.ref) return parentStatus(atom.ref);
      if (atom.kind === "presentation")
        return { connection: { phase: state.connected ? "connected" : "disconnected" } };
      if (atom.kind === "config")
        return { providers: [{ instanceId: "codex", enabled: true, status: "ready" }] };
    },
  },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.startTurn }));
vi.mock("../hooks/useNewThreadTaskAvailability", async () => {
  const { useSyncExternalStore } = await import("react");
  const { getNewThreadTaskUnavailableReason } = await import("./NewThreadTaskDialog.logic");
  return {
    useNewThreadTaskParent: (ref: ScopedThreadRef) =>
      useSyncExternalStore(
        (listener) => {
          state.parentListeners.add(listener);
          return () => {
            state.parentListeners.delete(listener);
          };
        },
        () => state.parents.get(`${ref.environmentId}:${ref.threadId}`)?.thread ?? null,
      ),
    useNewThreadTaskAvailability: (ref: ScopedThreadRef) => ({
      problem: useSyncExternalStore(
        (listener) => {
          state.parentListeners.add(listener);
          return () => {
            state.parentListeners.delete(listener);
          };
        },
        () =>
          getNewThreadTaskUnavailableReason({
            projection: state.parents.get(key(ref)) ?? null,
            status: parentStatus(ref),
            connected: state.connected,
            providers: [
              { instanceId: ProviderInstanceId.make("codex"), enabled: true, status: "ready" },
            ],
          }),
      ),
      providers: [],
    }),
  };
});
// The host's command/parent lifecycle is tested independently of model picker rendering.
vi.mock("./NewThreadTaskDialog", () => ({
  NewThreadTaskDialog: (
    props: Parameters<typeof import("./NewThreadTaskDialog").NewThreadTaskDialog>[0],
  ) => (
    <form
      role="dialog"
      onSubmit={(event) => {
        event.preventDefault();
        void props
          .onRequest(
            props.initialDraft ?? { title: "", prompt: "Review paths" },
            props.initialModelSelection,
          )
          .then((problem) => {
            if (problem === null) props.onClose();
          });
      }}
    >
      <p>{props.initialDraft?.title}</p>
      <p>{props.initialDraft?.prompt}</p>
      <button type="submit">Request task</button>
      <button type="button" onClick={props.onClose}>
        Cancel
      </button>
    </form>
  ),
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.toast } }));

const routeRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("open-parent"));

function setup() {
  state.parents.clear();
  state.statuses.clear();
  state.parentListeners.clear();
  state.parents.set(key(routeRef), {
    ...makeThreadProjectionFixture(),
    thread: { ...makeThreadProjectionFixture().thread, id: routeRef.threadId },
  });
  state.route = routeRef;
  state.connected = true;
  state.startTurn.mockReset().mockResolvedValue({ _tag: "Success" });
  state.toast.mockReset();
}
async function shortcut(options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "t",
    code: "KeyT",
    ctrlKey: true,
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  await act(async () => document.body.dispatchEvent(event));
  return event;
}

describe("shared task host", () => {
  it("keeps the first draft when two open requests arrive together", async () => {
    setup();
    // Route state is controlled by the host fixture.
    await using screen = await render(<NewThreadTaskHost />, { router: false });
    const { container } = screen;
    await act(async () => {
      openNewThreadTaskDialog({
        threadRef: routeRef,
        initialDraft: { title: "First draft", prompt: "First work" },
      });
      openNewThreadTaskDialog({
        threadRef: routeRef,
        initialDraft: { title: "Second draft", prompt: "Other work" },
      });
    });
    expect(container.textContent).toContain("First draft");
    expect(container.textContent).not.toContain("Second draft");
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "A task draft is already open" }),
    );
  });
  it("submits a prefilled task to an unopened remote parent even after route navigation", async () => {
    setup();
    const ref = scopeThreadRef(EnvironmentId.make("remote"), ThreadId.make("unopened-parent"));
    const projection = makeThreadProjectionFixture();
    state.parents.set(key(ref), {
      ...projection,
      thread: { ...projection.thread, id: ref.threadId },
    });
    // Route state is controlled by the host fixture.
    await using screen = await render(<NewThreadTaskHost />, { router: false });
    const { container } = screen;
    await act(async () =>
      openNewThreadTaskDialog({
        threadRef: ref,
        initialDraft: { title: "Map ticket", prompt: "Read the map\nImplement the ticket." },
      }),
    );
    expect(container.textContent).toContain("Read the map");
    state.route = null;
    await screen.rerender(<NewThreadTaskHost />);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(),
    );
    const [command] = state.startTurn.mock.calls[0]!;
    expect(command.environmentId).toBe("remote");
    expect(command.input.threadId).toBe("unopened-parent");
    expect(command.input.message.text).toContain('"title": "Map ticket"');
    expect(command.input.message.text).toContain("Read the map\\nImplement the ticket.");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens before an unopened parent loads, then keeps the draft when it arrives", async () => {
    setup();
    const ref = scopeThreadRef(EnvironmentId.make("remote"), ThreadId.make("loading-parent"));
    // Route state is controlled by the host fixture.
    await using screen = await render(<NewThreadTaskHost />, { router: false });
    const { container } = screen;
    await act(async () =>
      openNewThreadTaskDialog({
        threadRef: ref,
        initialDraft: { title: "Loading draft", prompt: "Check the files" },
      }),
    );
    expect(document.body.textContent).toContain("Wait for the thread to load.");
    const projection = makeThreadProjectionFixture();
    state.parents.set(key(ref), {
      ...projection,
      thread: { ...projection.thread, id: ref.threadId },
    });
    await act(async () => {
      for (const listener of state.parentListeners) listener();
    });
    expect(container.textContent).toContain("Loading draft");
    expect(container.textContent).toContain("Check the files");
  });

  it("offers only Cancel when the requested parent does not exist", async () => {
    setup();
    const ref = scopeThreadRef(EnvironmentId.make("remote"), ThreadId.make("missing-parent"));
    state.statuses.set(key(ref), "deleted");
    // Route state is controlled by the host fixture.
    await using _screen = await render(<NewThreadTaskHost />, { router: false });
    await act(async () => openNewThreadTaskDialog({ threadRef: ref }));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("This thread is no longer available.");
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["Cancel"]);
    await act(async () => buttons[0]!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(state.startTurn).not.toHaveBeenCalled();
  });

  it("replaces an open draft with only Cancel when its parent is deleted", async () => {
    setup();
    // Route state is controlled by the host fixture.
    await using screen = await render(<NewThreadTaskHost />, { router: false });
    const { container } = screen;
    await act(async () => openNewThreadTaskDialog({ threadRef: routeRef }));
    expect(container.textContent).toContain("Request task");
    state.parents.delete(key(routeRef));
    state.statuses.set(key(routeRef), "deleted");
    await act(async () => {
      for (const listener of state.parentListeners) listener();
    });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("This thread is no longer available.");
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["Cancel"]);
    expect(state.startTurn).not.toHaveBeenCalled();
  });

  it("shows the unavailable reason when the shortcut is pressed", async () => {
    setup();
    state.connected = false;
    // Route state is controlled by the host fixture.
    await using _screen = await render(<NewThreadTaskHost />, { router: false });
    const event = await shortcut();
    expect(event.defaultPrevented).toBe(true);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "New task unavailable",
        description: "Connect to this thread's environment to request a task.",
      }),
    );
    expect(state.startTurn).not.toHaveBeenCalled();
  });

  it("does no DOM or store lookup for non-matching keys typed in the composer", async () => {
    setup();
    // Route state is controlled by the host fixture.
    await using screen = await render(<NewThreadTaskHost />, { router: false });
    const { container } = screen;
    const composer = document.createElement("textarea");
    composer.dataset.testid = "composer-editor";
    container.append(composer);
    composer.focus();
    using query = vi.spyOn(document, "querySelector");
    using focus = vi.spyOn(document, "activeElement", "get");
    using registry = vi.spyOn(appAtomRegistry, "get");
    using terminal = vi.spyOn(useTerminalUiStateStore, "getState");
    using panel = vi.spyOn(useRightPanelStore, "getState");

    for (const options of [
      { key: "t", code: "KeyT", ctrlKey: false, altKey: false },
      { key: "x", code: "KeyX" },
    ]) {
      const event = new KeyboardEvent("keydown", {
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
        ...options,
      });
      await act(async () => composer.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }

    expect(query).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(registry).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
    expect(panel).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("leaves terminal input, repeated keys and composition alone", async () => {
    setup();
    // Route state is controlled by the host fixture.
    await using screen = await render(<NewThreadTaskHost />, { router: false });
    const { container } = screen;
    const terminal = document.createElement("textarea");
    terminal.dataset.terminalOwner = "drawer";
    container.append(terminal);
    terminal.focus();
    expect((await shortcut()).defaultPrevented).toBe(false);
    terminal.remove();
    expect((await shortcut({ repeat: true })).defaultPrevented).toBe(false);
    expect((await shortcut({ isComposing: true })).defaultPrevented).toBe(false);
    expect(state.toast).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps a disabled header action and its tooltip wrapper out of keyboard focus", async () => {
    setup();
    state.connected = false;
    // Route state is controlled by the host fixture.
    await using screen = await render(<NewThreadTaskAction threadRef={routeRef} />, {
      router: false,
    });
    const { container } = screen;
    const button = container.querySelector<HTMLButtonElement>("button")!;
    button.focus();
    button.click();
    expect(document.activeElement).not.toBe(button);
    const wrapper = button.parentElement!;
    wrapper.focus();
    expect(wrapper.tabIndex).toBe(-1);
    expect(wrapper.getAttribute("role")).not.toBe("button");
    expect(container.textContent).toContain("Connect to this thread's environment");
    expect(state.startTurn).not.toHaveBeenCalled();
  });
});
