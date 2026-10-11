import { describe, expect, it } from "vite-plus/test";
import { resolveTerminalLaunchLocation } from "./terminalLaunchLocation";

const project = { workspaceRoot: "/new-primary" };
const thread = {
  worktreePath: "/sessions/api/src",
  workspaceFolders: [
    { path: "/repos/api/src", name: "API", label: "api" },
    { path: "/repos/ui", name: "UI", label: "ui" },
    { path: "/shared", name: "Shared", label: "shared" },
  ],
  worktrees: [{ repositoryRoot: "/repos/ui", path: "/sessions/ui", branch: "feature" }],
};
const pending = {
  terminalId: "term-2",
  cwd: "/sessions/ui",
  worktreePath: "/sessions/ui",
  runtimeEnv: { T3CODE_PROJECT_ROOT: "/repos/ui", T3CODE_WORKTREE_PATH: "/sessions/ui" },
};

describe("terminal launch locations", () => {
  it("keeps new unscoped terminals at the frozen primary while another folder is pending", () => {
    expect(
      resolveTerminalLaunchLocation({ project, thread, terminalId: "term-3", pending }),
    ).toEqual({
      cwd: "/sessions/api/src",
      worktreePath: "/sessions/api/src",
      runtimeEnv: {
        T3CODE_PROJECT_ROOT: "/repos/api/src",
        T3CODE_WORKTREE_PATH: "/sessions/api/src",
      },
    });
  });
  it("uses the pending scope only for the terminal being launched", () => {
    expect(
      resolveTerminalLaunchLocation({ project, thread, terminalId: "term-2", pending }),
    ).toEqual(pending);
  });
  it("does not change existing panel environments when a drawer folder terminal opens", () => {
    const summary = { cwd: "/sessions/api/src", worktreePath: "/sessions/api/src" };
    const input = { project, thread, terminalId: "term-1", summary };
    expect(resolveTerminalLaunchLocation({ ...input, pending })).toEqual(
      resolveTerminalLaunchLocation(input),
    );
  });
  it("reconstructs the selected folder environment after its summary arrives", () => {
    const summary = { cwd: pending.cwd, worktreePath: pending.worktreePath };
    expect(
      resolveTerminalLaunchLocation({ project, thread, terminalId: "term-2", summary }).runtimeEnv,
    ).toEqual(pending.runtimeEnv);
  });
  it("preserves a terminal's cwd and explicit null worktree after the thread changes", () => {
    const summary = { cwd: "/shared", worktreePath: null };
    expect(
      resolveTerminalLaunchLocation({ project, thread, terminalId: "term-1", summary }),
    ).toEqual({
      ...summary,
      runtimeEnv: { T3CODE_PROJECT_ROOT: "/shared", T3CODE_WORKTREE_PATH: "/shared" },
    });
  });
  it("keeps legacy terminals without a worktree on the original shell primary", () => {
    expect(
      resolveTerminalLaunchLocation({
        project,
        thread: { worktreePath: null, workspacePrimaryPath: "/old-primary" },
        terminalId: "term-1",
      }),
    ).toEqual({
      cwd: "/old-primary",
      worktreePath: null,
      runtimeEnv: { T3CODE_PROJECT_ROOT: "/old-primary" },
    });
  });
});
