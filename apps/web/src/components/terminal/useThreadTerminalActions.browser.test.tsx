import { RegistryContext } from "@effect/atom-react";
import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { useThreadTerminalActions, type TerminalLaunchLocation } from "./useThreadTerminalActions";

const mocks = vi.hoisted(() => ({
  shell: vi.fn(),
  project: vi.fn(),
  threadAtom: vi.fn(),
  knownSessions: vi.fn(),
  drawerIds: vi.fn(),
  panelSurfaces: vi.fn(),
  readScope: vi.fn(),
  open: vi.fn(),
  write: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../../state/entities", () => ({
  useQuietThreadShell: mocks.shell,
  useProject: mocks.project,
}));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { threadAtom: mocks.threadAtom },
}));
vi.mock("../../state/terminalSessions", () => ({
  useKnownTerminalSessions: mocks.knownSessions,
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: mocks.readScope }));
vi.mock("../../state/terminal", () => ({
  terminalEnvironment: { open: "open", write: "write", close: "close" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => {
    if (command === "open") return mocks.open;
    if (command === "write") return mocks.write;
    return mocks.close;
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
}));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: (select: (state: { getDraftThreadByRef: () => null }) => unknown) =>
    select({ getDraftThreadByRef: () => null }),
}));
vi.mock("../../terminalUiStateStore", () => ({
  selectThreadTerminalUiState: () => ({ terminalIds: mocks.drawerIds() }),
  useTerminalUiStateStore: (select: (state: { terminalUiStateByThreadKey: {} }) => unknown) =>
    select({ terminalUiStateByThreadKey: {} }),
}));
vi.mock("../../rightPanelStore", () => ({
  selectThreadRightPanelState: () => ({ surfaces: mocks.panelSurfaces() }),
  useRightPanelStore: (select: (state: { byThreadKey: {} }) => unknown) =>
    select({ byThreadKey: {} }),
}));
vi.mock("~/lib/utils", () => ({
  randomUUID: () => "00000000-0000-4000-8000-000000000001",
}));

const threadRef = {
  environmentId: EnvironmentId.make("terminal-test"),
  threadId: ThreadId.make("thread"),
};

function setup(worktreePath: string | null = null) {
  const thread = {
    title: "Original title",
    worktreePath,
    workspaceFolders: [
      { path: "/frozen-api", name: "API", label: "api" },
      { path: "/frozen-ui", name: "UI", label: "ui" },
    ],
    worktrees: [{ repositoryRoot: "/frozen-ui", path: "/sessions/ui", branch: "feature" }],
  };
  const detail = { projection: { thread, messages: ["initial content"] } };
  const detailAtom = Atom.make(detail);
  const registry = AtomRegistry.make();
  mocks.threadAtom.mockReset().mockReturnValue(detailAtom);
  mocks.shell.mockReset().mockReturnValue({
    ...threadRef,
    id: threadRef.threadId,
    projectId: ProjectId.make("project"),
    worktreePath: null,
    workspacePrimaryPath: "/frozen-api",
  });
  mocks.project.mockReset().mockReturnValue({
    workspaceRoot: "/changed-primary",
    folders: [{ path: "/changed-primary", name: "Changed", label: "changed" }],
  });
  mocks.knownSessions.mockReset().mockReturnValue([{ target: { terminalId: "term-1" } }]);
  mocks.drawerIds.mockReset().mockReturnValue(["term-2"]);
  mocks.panelSurfaces.mockReset().mockReturnValue([{ kind: "terminal", terminalIds: ["term-3"] }]);
  mocks.readScope.mockReset().mockReturnValue(true);
  mocks.open.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  mocks.write.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  mocks.close.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  return { detail, detailAtom, registry, [Symbol.dispose]: () => registry.dispose() };
}

function TerminalLauncher(props: {
  place: (terminalId: string) => void;
  location?: TerminalLaunchLocation;
  extraEnv?: Record<string, string>;
  onRender?: () => void;
}) {
  const actions = useThreadTerminalActions(threadRef);
  useLayoutEffect(() => props.onRender?.());
  return (
    <button
      onClick={() => {
        const launched = actions.launchTerminal({
          place: props.place,
          ...(props.location ? { location: props.location } : {}),
          ...(props.extraEnv ? { extraEnv: props.extraEnv } : {}),
        });
        if (launched) void launched.result;
      }}
    >
      New terminal
    </button>
  );
}

it("launches at the frozen primary and allocates around every terminal surface", async () => {
  using state = setup();
  const place = vi.fn();
  await using screen = await render(
    <RegistryContext.Provider value={state.registry}>
      <TerminalLauncher place={place} />
    </RegistryContext.Provider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "New terminal" }));
  expect(place).toHaveBeenCalledExactlyOnceWith("term-4");
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      terminalId: "term-4",
      cwd: "/frozen-api",
      env: { T3CODE_PROJECT_ROOT: "/frozen-api" },
    },
  });
});

it("uses the frozen worktree and original project root for default launches", async () => {
  using state = setup("/sessions/api");
  await using screen = await render(
    <RegistryContext.Provider value={state.registry}>
      <TerminalLauncher place={() => {}} />
    </RegistryContext.Provider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "New terminal" }));
  expect(mocks.open.mock.calls[0]?.[0].input).toMatchObject({
    cwd: "/sessions/api",
    worktreePath: "/sessions/api",
    env: { T3CODE_PROJECT_ROOT: "/frozen-api", T3CODE_WORKTREE_PATH: "/sessions/api" },
  });
});

it("preserves the chat hook's selected folder location and environment", async () => {
  using state = setup("/sessions/api");
  const env = {
    T3CODE_PROJECT_ROOT: "/frozen-ui",
    T3CODE_WORKTREE_PATH: "/sessions/ui",
    CUSTOM: "value",
  };
  await using screen = await render(
    <RegistryContext.Provider value={state.registry}>
      <TerminalLauncher
        place={() => {}}
        location={{ cwd: "/sessions/ui", worktreePath: "/sessions/ui" }}
        extraEnv={env}
      />
    </RegistryContext.Provider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "New terminal" }));
  expect(mocks.open.mock.calls[0]?.[0].input).toMatchObject({
    cwd: "/sessions/ui",
    worktreePath: "/sessions/ui",
    env,
  });
});

it("keeps unique allocation when sessions are not readable", async () => {
  using state = setup();
  mocks.readScope.mockImplementation((_environmentId, scope) => scope !== AuthTerminalReadScope);
  const place = vi.fn();
  await using screen = await render(
    <RegistryContext.Provider value={state.registry}>
      <TerminalLauncher place={place} />
    </RegistryContext.Provider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "New terminal" }));
  expect(place).toHaveBeenCalledExactlyOnceWith("term-4-00000000-0000-4000-8000-000000000001");
});

it("rechecks terminal permission before placing or opening a session", async () => {
  using state = setup();
  const place = vi.fn();
  await using screen = await render(
    <RegistryContext.Provider value={state.registry}>
      <TerminalLauncher place={place} />
    </RegistryContext.Provider>,
  );
  mocks.readScope.mockImplementation((_environmentId, scope) => scope !== AuthTerminalOperateScope);
  await userEvent.click(screen.getByRole("button", { name: "New terminal" }));
  expect(place).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
});

it("ignores conversation updates while observing workspace changes", async () => {
  using state = setup();
  const onRender = vi.fn();
  await using screen = await render(
    <RegistryContext.Provider value={state.registry}>
      <TerminalLauncher place={() => {}} onRender={onRender} />
    </RegistryContext.Provider>,
  );
  const initialRenders = onRender.mock.calls.length;
  await act(() =>
    state.registry.set(state.detailAtom, {
      projection: {
        thread: { ...state.detail.projection.thread, title: "Updated title" },
        messages: ["streamed content"],
      },
    }),
  );
  expect(onRender).toHaveBeenCalledTimes(initialRenders);
  await act(() =>
    state.registry.set(state.detailAtom, {
      projection: {
        ...state.detail.projection,
        thread: { ...state.detail.projection.thread, worktreePath: "/new-session/api" },
      },
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "New terminal" }));
  expect(mocks.open.mock.calls[0]?.[0].input).toMatchObject({
    cwd: "/new-session/api",
    worktreePath: "/new-session/api",
  });
});
