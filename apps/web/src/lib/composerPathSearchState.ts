import {
  workspaceFolderProblems,
  workspaceResultFolderPath,
} from "~/components/files/workspaceFiles";
import {
  type ProjectPathSearchTarget,
  useComposerPathSearch as useComposerPathSearchQuery,
} from "../state/queries";

import { useMemo } from "react";

export function useComposerPathSearch(target: ProjectPathSearchTarget) {
  const state = useComposerPathSearchQuery(target);
  // A stable list lets the composer menu memo cache between renders.
  const entries = useMemo(
    () =>
      state.entries.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        folderPath: workspaceResultFolderPath(entry.path, state.folders),
      })),
    [state.entries, state.folders],
  );
  return {
    entries,
    error: state.error ?? (workspaceFolderProblems(state.folders) || null),
    isPending: state.isPending,
  };
}
