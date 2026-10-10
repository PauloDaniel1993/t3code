import { useMemo } from "react";
import { threadPrimaryPath } from "@t3tools/shared/workspaceFolders";

import { useSelectedThreadWorktreePath } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

export function useSelectedThreadWorktree() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const detailWorktreePath = useSelectedThreadWorktreePath();

  const selectedThreadWorktreePath = useMemo(
    () =>
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread?.worktreePath ?? null,
        threadDetailWorktreePath: detailWorktreePath,
      }),
    [detailWorktreePath, selectedThread?.worktreePath],
  );

  return {
    selectedThreadWorktreePath,
    selectedThreadCwd: threadPrimaryPath(
      { worktreePath: selectedThreadWorktreePath },
      selectedThreadProject,
    ),
  };
}
