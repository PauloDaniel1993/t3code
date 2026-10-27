import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { environmentThreadDetails } from "../../state/threads";

const workspaceAtom = Atom.family((key: string | null) =>
  Atom.withEquality(
    Atom.make((get) => {
      const ref = key === null ? null : parseScopedThreadKey(key);
      if (ref === null) return null;
      const thread = get(environmentThreadDetails.threadAtom(ref))?.projection.thread;
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
);

/** Terminal locations do not change when conversation content or timestamps change. */
export function useTerminalThreadWorkspace(threadRef: ScopedThreadRef | null) {
  return useAtomValue(workspaceAtom(threadRef === null ? null : scopedThreadKey(threadRef)));
}
