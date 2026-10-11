import { type ComposerPathSearchState } from "@t3tools/client-runtime/state/threads";

import { workspaceFolderProblems } from "~/components/files/workspaceFiles";
import {
  type ProjectPathSearchTarget,
  useComposerPathSearch as useComposerPathSearchQuery,
} from "../state/queries";

export function useComposerPathSearch(target: ProjectPathSearchTarget): ComposerPathSearchState {
  const state = useComposerPathSearchQuery(target);
  return {
    entries: state.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
    })),
    error: state.error ?? (workspaceFolderProblems(state.folders) || null),
    isPending: state.isPending,
  };
}
