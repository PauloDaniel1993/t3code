import { useMemo } from "react";

import { workspaceFileScope } from "../lib/workspaceFiles";

/** Streaming shell updates must not restart a file search's debounce or its preview callbacks. */
export function useWorkspaceFileScope(input: Parameters<typeof workspaceFileScope>[0]) {
  const { enabled } = input;
  const projectId = input.project?.id;
  const workspaceFile = input.project?.workspaceFile;
  const threadId = input.thread?.id;
  const workspaceFolderCount = input.thread?.workspaceFolderCount;
  const workspacePrimaryPath = input.thread?.workspacePrimaryPath;
  return useMemo(
    () =>
      workspaceFileScope({
        enabled,
        project: projectId === undefined ? null : { id: projectId, workspaceFile },
        thread:
          threadId === undefined
            ? null
            : { id: threadId, workspaceFolderCount, workspacePrimaryPath },
      }),
    [enabled, projectId, workspaceFile, threadId, workspaceFolderCount, workspacePrimaryPath],
  );
}
