import {
  workspaceFolderProblems,
  workspaceResultFolderPath,
} from "~/components/files/workspaceFiles";
import {
  type ProjectPathSearchTarget,
  useComposerPathSearch as useComposerPathSearchQuery,
} from "../state/queries";

export function useComposerPathSearch(target: ProjectPathSearchTarget) {
  const state = useComposerPathSearchQuery(target);
  return {
    entries: state.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      folderPath: workspaceResultFolderPath(entry.path, state.folders),
    })),
    error: state.error ?? (workspaceFolderProblems(state.folders) || null),
    isPending: state.isPending,
  };
}
