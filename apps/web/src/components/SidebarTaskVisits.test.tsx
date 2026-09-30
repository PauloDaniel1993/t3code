import { act } from "react";
import { create } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../test-fixtures";
import { useUiStateStore } from "../uiStateStore";

const hooks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../state/entities", () => ({ readThreadShell: hooks.read }));
vi.mock("../state/threads", () => ({ environmentThreadDetails: {} }));
import { SidebarTaskVisits } from "./SidebarTaskVisits";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("streamed shell updates write nothing; only opening and leaving a task records visits", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const environmentId = EnvironmentId.make("local");
  const threadId = ThreadId.make("task");
  let shell = makeThreadFixture({
    environmentId,
    id: threadId,
    lineage: {
      parentThreadId: ThreadId.make("parent"),
      rootThreadId: ThreadId.make("parent"),
      relationshipToParent: "subagent",
    },
  });
  hooks.read.mockImplementation(() => shell);
  const visit = vi.fn();
  const original = useUiStateStore.getState().markThreadVisited;
  useUiStateStore.setState({ markThreadVisited: visit });
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(<SidebarTaskVisits threadRef={{ environmentId, threadId }} />);
  });
  expect(visit).toHaveBeenCalledOnce();
  visit.mockClear();
  const writes = vi.fn();
  const unsubscribe = useUiStateStore.subscribe(writes);
  const beforeStreaming = shell;
  for (let index = 0; index < 100; index++) {
    shell = {
      ...beforeStreaming,
      updatedAt: new Date(1_800_000_000_000 + index).toISOString(),
      itemCount: index,
    };
    act(() => tree!.update(<SidebarTaskVisits threadRef={{ environmentId, threadId }} />));
  }
  expect(visit).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
  act(() => tree!.update(<SidebarTaskVisits threadRef={null} />));
  expect(visit).toHaveBeenCalledOnce();
  unsubscribe();
  useUiStateStore.setState({ markThreadVisited: original });
  act(() => tree!.unmount());
});

it("ordinary threads with no tasks never write a task visit", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const shell = makeThreadFixture();
  hooks.read.mockReturnValue(shell);
  const visit = vi.fn();
  const original = useUiStateStore.getState().markThreadVisited;
  useUiStateStore.setState({ markThreadVisited: visit });
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <SidebarTaskVisits threadRef={{ environmentId: shell.environmentId, threadId: shell.id }} />,
    );
  });
  act(() => tree!.unmount());
  expect(visit).not.toHaveBeenCalled();
  useUiStateStore.setState({ markThreadVisited: original });
});
