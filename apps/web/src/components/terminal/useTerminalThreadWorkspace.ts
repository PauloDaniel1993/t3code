import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";
import { environmentThreadDetails } from "../../state/threads";

/** Terminal locations do not change when conversation content or timestamps change. */
export function useTerminalThreadWorkspace(threadRef: ScopedThreadRef | null) {
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const workspaceAtom = useMemo(
    () =>
      Atom.withEquality(
        Atom.make((get) => {
          if (environmentId === null || threadId === null) return null;
          const thread = get(
            environmentThreadDetails.threadAtom(scopeThreadRef(environmentId, threadId)),
          )?.projection.thread;
          if (!thread) return null;
          return {
            worktreePath: thread.worktreePath,
            ...(thread.workspaceFolders !== undefined
              ? { workspaceFolders: thread.workspaceFolders }
              : {}),
            ...(thread.worktrees !== undefined ? { worktrees: thread.worktrees } : {}),
          };
        }),
        (previous, next) =>
          previous?.worktreePath === next?.worktreePath &&
          previous?.workspaceFolders === next?.workspaceFolders &&
          previous?.worktrees === next?.worktrees,
      ),
    [environmentId, threadId],
  );
  return useAtomValue(workspaceAtom);
}
