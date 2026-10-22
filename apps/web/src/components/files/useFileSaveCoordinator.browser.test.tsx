import { render, fakeTimers } from "../../../test/render";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { StrictMode, useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const { writeFile, confirmFile, readScope, getUnsavedFile } = vi.hoisted(() => ({
  writeFile: vi.fn(),
  confirmFile: vi.fn(),
  readScope: vi.fn(),
  getUnsavedFile: vi.fn(),
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: readScope,
  useEnvironmentScope: readScope,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => writeFile) as never,
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  confirmProjectFileQueryData: confirmFile,
  getUnsavedProjectFileQueryData: getUnsavedFile,
}));

import { useFileSaveCoordinator } from "./useFileSaveCoordinator";

const environmentId = EnvironmentId.make("save-lifecycle-audit");
const onPendingChange = vi.fn();
const defaultProps = {
  environmentId,
  cwd: "/workspace",
  relativePath: "file.txt",
  onPendingChange,
};
function setup() {
  writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  confirmFile.mockReset();
  readScope.mockReset().mockReturnValue(true);
  getUnsavedFile.mockReset().mockReturnValue(null);
  onPendingChange.mockReset();
}

async function mount(props: Parameters<typeof useFileSaveCoordinator>[0] = defaultProps) {
  let latestChange: (contents: string) => void = () => {};
  function FileSurface(props: Parameters<typeof useFileSaveCoordinator>[0]) {
    const coordinator = useFileSaveCoordinator(props);
    useEffect(() => {
      latestChange = (contents) => coordinator.change(contents);
    });
    return null;
  }
  const ui = (props: Parameters<typeof useFileSaveCoordinator>[0]) => (
    <StrictMode>
      <FileSurface {...props} />
    </StrictMode>
  );
  const screen = await render(ui(props), { router: false });
  return {
    changeHandler: () => latestChange,
    rerender: (props: Parameters<typeof useFileSaveCoordinator>[0]) => screen.rerender(ui(props)),
    unmount: screen.unmount,
    [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose](),
  };
}

describe("file-save React lifecycle", () => {
  it("keeps a save session for equal scope objects and confirms the pinned cache", async () => {
    setup();
    using _timers = fakeTimers();
    const scope = {
      projectId: ProjectId.make("project"),
      threadId: ThreadId.make("thread"),
      folderPath: "/ui",
    };
    const props = { ...defaultProps, relativePath: "ui/file.txt", scope };
    await using screen = await mount(props);
    const originalChange = screen.changeHandler();
    originalChange("first edit");
    await screen.rerender({ ...props, scope: { ...scope } });
    expect(writeFile).not.toHaveBeenCalled();
    originalChange("second edit");
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { scope, path: "ui/file.txt", contents: "second edit" },
    });
    expect(confirmFile).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      "/workspace",
      "ui/file.txt",
      "second edit",
      scope,
    );
  });

  it("retires the old save session when a folder pin changes", async () => {
    setup();
    using _timers = fakeTimers();
    const scope = { projectId: ProjectId.make("project"), folderPath: "/original/ui" };
    const props = { ...defaultProps, relativePath: "ui/file.txt", scope };
    await using screen = await mount(props);
    const retiredChange = screen.changeHandler();
    retiredChange("original folder edit");
    const replacementScope = { ...scope, folderPath: "/replacement/ui" };
    await screen.rerender({ ...props, scope: replacementScope });
    retiredChange("stale editor contents");
    screen.changeHandler()("replacement folder edit");
    await vi.runAllTimersAsync();
    expect(writeFile.mock.calls.map(([request]) => request.input)).toEqual([
      { scope, path: "ui/file.txt", contents: "original folder edit" },
      { scope: replacementScope, path: "ui/file.txt", contents: "replacement folder edit" },
    ]);
  });

  it("persists editor model changes after StrictMode setup replay", async () => {
    setup();
    using _timers = fakeTimers();
    await using screen = await mount();
    screen.changeHandler()("AUDIT7907NATIVE\n");
    expect(onPendingChange).toHaveBeenCalledWith("file.txt", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "AUDIT7907NATIVE\n" },
    });
    expect(confirmFile).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      "/workspace",
      "file.txt",
      "AUDIT7907NATIVE\n",
    );
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("flushes on unmount and ignores a retired editor callback", async () => {
    setup();
    using _timers = fakeTimers();
    await using screen = await mount();
    const retiredChange = screen.changeHandler();
    retiredChange("pending edit");
    await screen.unmount();
    retiredChange("stale editor contents");
    await vi.runAllTimersAsync();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0].input.contents).toBe("pending edit");
  });

  it.each([false, true])(
    "keeps edits pending after permission is revoked before a React update (unmount: %s)",
    async (unmount) => {
      setup();
      using _timers = fakeTimers();
      await using screen = await mount();
      screen.changeHandler()("pending edit");
      readScope.mockReturnValue(false);
      if (unmount) {
        await screen.unmount();
      }
      await vi.runAllTimersAsync();
      expect(writeFile).not.toHaveBeenCalled();
      expect(confirmFile).not.toHaveBeenCalled();
      expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", true);
    },
  );

  it("resumes an unsaved draft when write permission returns after effect replay", async () => {
    setup();
    using _timers = fakeTimers();
    readScope.mockReturnValue(false);
    getUnsavedFile.mockReturnValue({ contents: "pending draft" });
    await using screen = await mount();
    await vi.runAllTimersAsync();
    expect(writeFile).not.toHaveBeenCalled();

    readScope.mockReturnValue(true);
    await screen.rerender(defaultProps);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/workspace", relativePath: "file.txt", contents: "pending draft" },
    });
    expect(onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it.each([
    { relativePath: "other.txt" },
    { cwd: "/other-workspace" },
    { environmentId: EnvironmentId.make("other-environment") },
  ])("retires callbacks when the file identity changes: %j", async (change) => {
    setup();
    using _timers = fakeTimers();
    await using screen = await mount();
    const retiredChange = screen.changeHandler();
    retiredChange("old file edit");
    const nextProps = { ...defaultProps, ...change };
    await screen.rerender(nextProps);
    retiredChange("stale editor contents");
    screen.changeHandler()("new file edit");
    await vi.runAllTimersAsync();
    expect(writeFile.mock.calls.map(([request]) => request)).toEqual([
      {
        environmentId,
        input: { cwd: "/workspace", relativePath: "file.txt", contents: "old file edit" },
      },
      {
        environmentId: nextProps.environmentId,
        input: {
          cwd: nextProps.cwd,
          relativePath: nextProps.relativePath,
          contents: "new file edit",
        },
      },
    ]);
  });
});
