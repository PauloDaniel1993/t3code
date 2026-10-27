import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, render } from "../../test/render";
import { makeThreadFixture } from "../test-fixtures";
import { useUiStateStore } from "../uiStateStore";

const hooks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../state/entities", () => ({ readThreadShell: hooks.read }));
vi.mock("../state/threads", () => ({ environmentThreadDetails: {} }));
import { SidebarTaskVisits } from "./SidebarTaskVisits";

function setup() {
  hooks.read.mockReset();
  const original = useUiStateStore.getState().markThreadVisited;
  const visit = vi.fn();
  useUiStateStore.setState({ markThreadVisited: visit });
  return {
    visit,
    [Symbol.dispose]() {
      useUiStateStore.setState({ markThreadVisited: original });
    },
  };
}

it("streamed shell updates write nothing; only opening and leaving a task records visits", async () => {
  using fixture = setup();
  const { visit } = fixture;
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
  await using screen = await render(<SidebarTaskVisits threadRef={{ environmentId, threadId }} />);
  expect(visit).toHaveBeenCalledOnce();
  visit.mockClear();
  const writes = vi.fn();
  using _subscription = { [Symbol.dispose]: useUiStateStore.subscribe(writes) };
  const beforeStreaming = shell;
  for (let index = 0; index < 100; index++) {
    shell = {
      ...beforeStreaming,
      updatedAt: new Date(1_800_000_000_000 + index).toISOString(),
      itemCount: index,
    };
    await screen.rerender(<SidebarTaskVisits threadRef={{ environmentId, threadId }} />);
  }
  expect(visit).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
  await screen.rerender(<SidebarTaskVisits threadRef={null} />);
  expect(visit).toHaveBeenCalledOnce();
});

it("ordinary threads with no tasks never write a task visit", async () => {
  using fixture = setup();
  const shell = makeThreadFixture();
  hooks.read.mockReturnValue(shell);
  await using screen = await render(
    <SidebarTaskVisits threadRef={{ environmentId: shell.environmentId, threadId: shell.id }} />,
  );
  await act(() => screen.unmount());
  expect(fixture.visit).not.toHaveBeenCalled();
});
