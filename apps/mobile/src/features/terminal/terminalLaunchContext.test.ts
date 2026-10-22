import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  resolveTerminalOpenLocation,
  stagePendingTerminalLaunch,
  takePendingTerminalLaunch,
} from "./terminalLaunchContext";

describe("resolveTerminalOpenLocation", () => {
  const thread = {
    worktreePath: "/session/api",
    workspaceFolders: [
      { path: "/api", name: "API", label: "api" },
      { path: "/ui", name: "UI", label: "ui" },
    ],
    worktrees: [
      { repositoryRoot: "/api", path: "/session/api", branch: "feature" },
      { repositoryRoot: "/ui", path: "/session/ui", branch: "feature" },
    ],
  };

  it("opens a chosen folder in its mapped worktree", () => {
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: null,
        activeSessionLocation: null,
        workspaceRoot: "/changed",
        threadShellWorktreePath: thread.worktreePath,
        threadDetailWorktreePath: thread.worktreePath,
        thread,
        folderPath: "/ui",
      }),
    ).toEqual({ cwd: "/session/ui", worktreePath: "/session/ui" });
  });

  it("uses the frozen root-mode primary and preserves an existing folder terminal", () => {
    const input = {
      terminalLocation: null,
      activeSessionLocation: null,
      workspaceRoot: "/changed",
      threadShellWorktreePath: null,
      threadDetailWorktreePath: null,
      thread: { ...thread, worktreePath: null, worktrees: undefined },
    };
    expect(resolveTerminalOpenLocation(input).cwd).toBe("/api");
    expect(
      resolveTerminalOpenLocation({
        ...input,
        terminalLocation: { cwd: "/ui", worktreePath: null },
        threadShellWorktreePath: "/later-worktree",
      }),
    ).toEqual({ cwd: "/ui", worktreePath: null });
    expect(() => resolveTerminalOpenLocation({ ...input, folderPath: "/removed" })).toThrow(
      "not part of this thread",
    );
  });
  it("uses the thread detail worktree path before the workspace root for a fresh mobile open", () => {
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: null,
        activeSessionLocation: null,
        workspaceRoot: "/repo/root",
        threadShellWorktreePath: null,
        threadDetailWorktreePath: "/repo/worktrees/feature",
      }),
    ).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
    });
  });

  it("preserves the running terminal snapshot cwd when attaching to an existing session", () => {
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: null,
        activeSessionLocation: {
          cwd: "/repo/worktrees/feature",
          worktreePath: "/repo/worktrees/feature",
        },
        workspaceRoot: "/repo/root",
        threadShellWorktreePath: null,
        threadDetailWorktreePath: "/repo/worktrees/other",
      }),
    ).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
    });
  });

  it("preserves checkout cwd and identity from the selected terminal or active session", () => {
    const checkout = { cwd: "/repo/root/packages/app", worktreePath: null };
    const threadLocation = {
      workspaceRoot: "/repo/root",
      threadShellWorktreePath: "/repo/worktrees/feature",
      threadDetailWorktreePath: "/repo/worktrees/feature",
    };

    expect(
      resolveTerminalOpenLocation({
        ...threadLocation,
        terminalLocation: checkout,
        activeSessionLocation: {
          cwd: "/repo/worktrees/other",
          worktreePath: "/repo/worktrees/other",
        },
      }),
    ).toEqual(checkout);

    expect(
      resolveTerminalOpenLocation({
        ...threadLocation,
        terminalLocation: null,
        activeSessionLocation: checkout,
      }),
    ).toEqual(checkout);
  });
});

describe("pending terminal launches", () => {
  it("does not mix a thread snapshot with a newer shell worktree scalar", () => {
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: null,
        activeSessionLocation: null,
        workspaceRoot: "/new-primary",
        threadShellWorktreePath: "/new-worktree",
        threadDetailWorktreePath: null,
        thread: {
          worktreePath: null,
          workspaceFolders: [
            { path: "/old-primary", label: "api", name: "API" },
            { path: "/repos/ui", label: "ui", name: "UI" },
          ],
        },
        folderPath: "/repos/ui",
      }),
    ).toEqual({ cwd: "/repos/ui", worktreePath: null });
  });
  it("stages and consumes launch details for a specific terminal target", () => {
    const target = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-2",
    };

    stagePendingTerminalLaunch({
      target,
      launch: {
        cwd: "/repo/worktrees/feature",
        worktreePath: "/repo/worktrees/feature",
        env: { FOO: "bar" },
        initialInput: "pnpm dev\r",
      },
    });

    expect(takePendingTerminalLaunch(target)).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
      env: { FOO: "bar" },
      initialInput: "pnpm dev\r",
    });
    expect(takePendingTerminalLaunch(target)).toBeNull();
  });
});
