import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveEditorTarget } from "./editorTarget.ts";

const context = {
  cwd: "/worktrees/team/frontend",
  workspaceFile: "/source/team.code-workspace",
  worktreeThreadId: ThreadId.make("thread-1"),
};

describe("resolveEditorTarget", () => {
  it("requests the thread's generated file instead of the source workspace for VS Code and its forks", () => {
    for (const editor of [
      "cursor",
      "trae",
      "kiro",
      "vscode",
      "vscode-insiders",
      "vscodium",
      "antigravity",
    ] as const) {
      expect(resolveEditorTarget({ ...context, editor })).toEqual({
        threadId: context.worktreeThreadId,
      });
    }
  });

  it("opens the original workspace file for current-checkout threads and project opens", () => {
    expect(
      resolveEditorTarget({
        cwd: "/source/frontend",
        workspaceFile: context.workspaceFile,
        editor: "cursor",
      }),
    ).toEqual({ cwd: context.workspaceFile });
  });

  it("keeps the primary path for editors without VS Code workspace support", () => {
    expect(resolveEditorTarget({ ...context, editor: "zed" })).toEqual({ cwd: context.cwd });
    expect(resolveEditorTarget({ ...context, editor: "idea" })).toEqual({ cwd: context.cwd });
    expect(resolveEditorTarget({ ...context, editor: "file-manager" })).toEqual({
      cwd: context.cwd,
    });
  });

  it("keeps drafts and imported worktree threads at their worktree when generation is unavailable", () => {
    expect(
      resolveEditorTarget({
        cwd: context.cwd,
        worktreePath: context.cwd,
        workspaceFile: context.workspaceFile,
        editor: "vscode",
      }),
    ).toEqual({ cwd: context.cwd });
  });

  it("keeps plain-project and explicitly scoped folder or file opens unchanged", () => {
    expect(resolveEditorTarget({ cwd: "/source/backend", editor: "vscode" })).toEqual({
      cwd: "/source/backend",
    });
    expect(resolveEditorTarget({ cwd: "/source/backend/index.ts:4", editor: "cursor" })).toEqual({
      cwd: "/source/backend/index.ts:4",
    });
  });
});
