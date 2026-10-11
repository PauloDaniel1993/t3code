import type {
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2ThreadWorkspaceFolder,
  OrchestrationV2ThreadWorktree,
} from "@t3tools/contracts";
import { isPathWithin, isSamePath, snapshotFolderPath } from "@t3tools/shared/workspaceFolders";
import * as Result from "effect/Result";

/** The thread fields that bind it to its workspace. */
export type ThreadWorkspaceBinding = Pick<
  OrchestrationV2AppThread,
  "branch" | "worktreePath" | "workspaceFolders" | "worktrees"
>;

type ThreadWorkspaceUpdate = Pick<
  Extract<OrchestrationV2Command, { readonly type: "thread.metadata.update" }>,
  "branch" | "worktreePath" | "workspaceFolders" | "worktrees"
>;

/**
 * Why a binding is malformed, or undefined when it is sound. A folder snapshot
 * starts with the local primary folder, and each folder has exactly one of a
 * path or a URI. A worktree set belongs to a snapshot, and its first member is
 * the primary's: the thread's `worktreePath` is the primary folder's place in
 * that member's worktree, and its `branch` is that member's, unless the
 * primary is detached.
 */
export function threadWorkspaceViolation(binding: ThreadWorkspaceBinding): string | undefined {
  const folders = binding.workspaceFolders;
  const primaryFolder = folders?.[0];
  const primaryFolderPath = primaryFolder?.path;
  if (folders !== undefined) {
    if (primaryFolderPath === undefined) {
      return "A thread's folder snapshot must start with its local primary folder.";
    }
    if (folders.some((folder) => (folder.path === undefined) === (folder.uri === undefined))) {
      return "Each workspace folder needs exactly one of a path or a URI.";
    }
  }
  const worktrees = binding.worktrees;
  if (worktrees === undefined) return undefined;
  if (primaryFolder === undefined || primaryFolderPath === undefined) {
    return "A thread's worktree set needs its folder snapshot.";
  }
  const primary = worktrees[0];
  if (primary === undefined) return "A thread's worktree set needs at least one member.";
  if (
    binding.worktreePath === null ||
    !isPathWithin(primary.path, binding.worktreePath) ||
    !isSamePath(
      binding.worktreePath,
      snapshotFolderPath(primaryFolder, worktrees) ?? primaryFolderPath,
    )
  ) {
    return "A thread's worktree path must be its primary folder's place in its primary worktree.";
  }
  if (binding.branch !== null && binding.branch !== primary.branch) {
    return "A thread's branch must be its primary worktree's branch.";
  }
  return undefined;
}

/**
 * Decide the binding a `thread.metadata.update` leaves. The snapshot is written
 * once and then frozen. A set the update doesn't carry follows the primary
 * scalars, so a writer that knows nothing of sets never leaves a stale one: a
 * new `worktreePath` drops the set, and a new branch becomes the primary
 * member's. A primary detached to a null branch keeps its expected branch.
 */
export function planThreadWorkspaceUpdate(
  thread: ThreadWorkspaceBinding,
  update: ThreadWorkspaceUpdate,
): Result.Result<ThreadWorkspaceBinding, string> {
  if (
    update.workspaceFolders !== undefined &&
    thread.workspaceFolders !== undefined &&
    !sameWorkspaceFolders(thread.workspaceFolders, update.workspaceFolders)
  ) {
    return Result.fail("A thread's folder snapshot can't change after binding.");
  }
  const branch = update.branch === undefined ? thread.branch : update.branch;
  const worktreePath =
    update.worktreePath === undefined ? thread.worktreePath : update.worktreePath;
  const workspaceFolders = thread.workspaceFolders ?? update.workspaceFolders;
  const worktrees =
    update.worktrees !== undefined
      ? (update.worktrees ?? undefined)
      : worktreePath !== thread.worktreePath
        ? undefined
        : thread.worktrees !== undefined && branch !== null && branch !== thread.branch
          ? thread.worktrees.map((member, index) => (index === 0 ? { ...member, branch } : member))
          : thread.worktrees;
  const binding: ThreadWorkspaceBinding = {
    branch,
    worktreePath,
    ...(workspaceFolders === undefined ? {} : { workspaceFolders }),
    ...(worktrees === undefined ? {} : { worktrees }),
  };
  const violation = threadWorkspaceViolation(binding);
  return violation === undefined ? Result.succeed(binding) : Result.fail(violation);
}

function sameWorkspaceFolders(
  left: ReadonlyArray<OrchestrationV2ThreadWorkspaceFolder>,
  right: ReadonlyArray<OrchestrationV2ThreadWorkspaceFolder>,
): boolean {
  return (
    left.length === right.length &&
    left.every((folder, index) => {
      const other = right[index]!;
      return (
        folder.path === other.path &&
        folder.uri === other.uri &&
        folder.name === other.name &&
        folder.label === other.label &&
        folder.checkoutRoot === other.checkoutRoot &&
        folder.checkoutPrefix === other.checkoutPrefix
      );
    })
  );
}

/**
 * Whether two worktree sets put the thread's folders in different places,
 * which detaches its provider sessions. A branch change alone, such as the
 * rename after a launch, moves no folder and keeps them attached.
 */
export function worktreeSetMoved(
  left: ReadonlyArray<OrchestrationV2ThreadWorktree> | undefined,
  right: ReadonlyArray<OrchestrationV2ThreadWorktree> | undefined,
): boolean {
  if (left === undefined || right === undefined) return left !== right;
  return (
    left.length !== right.length ||
    left.some((member, index) => {
      const other = right[index]!;
      return member.repositoryRoot !== other.repositoryRoot || member.path !== other.path;
    })
  );
}
