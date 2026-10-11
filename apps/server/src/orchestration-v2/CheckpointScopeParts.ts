import type {
  OrchestrationV2CheckpointFolder,
  OrchestrationV2CheckpointPart,
  OrchestrationV2CheckpointScope,
  OrchestrationV2CheckpointScopePart,
  OrchestrationV2CheckpointStatus,
  OrchestrationV2Run,
} from "@t3tools/contracts";
import {
  isPathWithin,
  isSamePath,
  relativePathWithin,
  resolveThreadWorkspace,
  threadPrimaryPath,
  worktreeSetPath,
  type WorkspaceThread,
} from "@t3tools/shared/workspaceFolders";
import * as NodeCrypto from "node:crypto";

export const PRIMARY_CHECKPOINT_PART_KEY = "primary";

// A part other than the primary's is keyed by its source location, which
// stays put when the thread's worktrees are recreated elsewhere.
function partKey(location: string): string {
  return NodeCrypto.createHash("sha256").update(location).digest("hex").slice(0, 16);
}

// Whether the pathspec for `outer` already covers `inner`. Both are `/`-separated
// paths below the part's cwd, empty for the cwd itself.
function covers(outer: string, inner: string): boolean {
  return outer === "" || inner === outer || inner.startsWith(`${outer}/`);
}

function outermost(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return paths.filter(
    (path, index) =>
      !paths.some(
        (other, otherIndex) =>
          otherIndex !== index && covers(other, path) && (other !== path || otherIndex < index),
      ),
  );
}

interface DraftPart {
  readonly key: string;
  readonly cwd: string;
  readonly vcs: "git" | null;
  /** The source checkout whose other folders join this part; null when none can. */
  readonly checkoutRoot: string | null;
  readonly folders: Array<OrchestrationV2CheckpointFolder>;
}

// A snapshot names its own primary, so the project is never consulted.
function snapshotWorkspace(
  thread: WorkspaceThread,
  unavailableFolderPaths: ReadonlyArray<string> | undefined,
) {
  const snapshot = thread.workspaceFolders ?? [];
  const primaryPath = threadPrimaryPath(thread, null);
  if (snapshot.length < 2 || primaryPath === null) return undefined;
  return {
    snapshot,
    workspace: resolveThreadWorkspace({
      thread,
      project: { workspaceRoot: primaryPath },
      unavailableFolderPaths,
    }),
  };
}

/**
 * Plan a run's checkpoint parts from its thread's folder snapshot. Each git
 * checkout is one part at its top, in the thread's worktree set when it has
 * one, with its member folders as pathspecs; a checkout nested inside a member
 * folder is excluded, since it is a part of its own. A folder outside git, or
 * without a known place in a checkout, is a part that isn't checkpointed.
 * Folders this run can't reach, and URI folders, have no part.
 *
 * A thread with fewer than two snapshot folders has no parts, so its scope
 * checkpoints its cwd exactly as before.
 */
export function checkpointScopeParts(input: {
  readonly thread: WorkspaceThread;
  /** The run's record of snapshot folders it can't reach. */
  readonly unavailableFolderPaths?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<OrchestrationV2CheckpointScopePart> | undefined {
  const planned = snapshotWorkspace(input.thread, input.unavailableFolderPaths);
  if (planned === undefined) return undefined;
  const { snapshot, workspace } = planned;
  const members = input.thread.worktrees ?? [];
  // A worktree picked outside the set coordinator holds the primary alone; its
  // sibling folders stay in their own checkouts.
  const worktreePath = input.thread.worktreePath;
  const primaryWorktree =
    worktreePath !== null && !members.some((member) => isPathWithin(member.path, worktreePath))
      ? worktreePath
      : null;
  const drafts: Array<DraftPart> = [];
  workspace.folders.forEach((resolved, index) => {
    const folder = snapshot[index];
    if (folder?.path === undefined || resolved.effectivePath === null) return;
    const key = (location: string) =>
      resolved.isPrimary ? PRIMARY_CHECKPOINT_PART_KEY : partKey(location);
    const checkoutRoot = folder.checkoutRoot;
    // The prefix is in the checkout's path space even when the folder is reached through a symlink.
    const relativePath =
      checkoutRoot == null
        ? null
        : (folder.checkoutPrefix ?? relativePathWithin(checkoutRoot, folder.path));
    const alone = (cwd: string, vcs: DraftPart["vcs"]) =>
      drafts.push({
        key: key(folder.path!),
        cwd,
        vcs,
        checkoutRoot: null,
        folders: [{ folderPath: folder.path!, label: folder.label, relativePath: "" }],
      });
    if (checkoutRoot == null || relativePath === null) {
      alone(resolved.effectivePath, null);
      return;
    }
    if (resolved.isPrimary && primaryWorktree !== null) {
      alone(primaryWorktree, "git");
      return;
    }
    const entry = { folderPath: folder.path, label: folder.label, relativePath };
    const existing = drafts.find(
      (draft) => draft.checkoutRoot !== null && isSamePath(draft.checkoutRoot, checkoutRoot),
    );
    if (existing !== undefined) {
      existing.folders.push(entry);
      return;
    }
    drafts.push({
      key: key(checkoutRoot),
      cwd: worktreeSetPath(checkoutRoot, members),
      vcs: "git",
      checkoutRoot,
      folders: [entry],
    });
  });

  // Every checkout the snapshot knows, reachable this run or not, so a parent
  // never stages a missing child checkout as deleted.
  const checkouts = snapshot.flatMap((folder) =>
    folder.checkoutRoot == null
      ? []
      : [{ root: folder.checkoutRoot, cwd: worktreeSetPath(folder.checkoutRoot, members) }],
  );
  return drafts.map((draft) => {
    const included = outermost(draft.folders.map((folder) => folder.relativePath));
    // Ownership is frozen in the snapshot: an unavailable nested member must
    // not become a deletion attributed to its reachable parent folder.
    const unavailableNested = snapshot.flatMap((folder, index) => {
      if (
        workspace.folders[index]?.effectivePath !== null ||
        folder.path === undefined ||
        folder.checkoutRoot == null ||
        draft.checkoutRoot === null ||
        !isSamePath(folder.checkoutRoot, draft.checkoutRoot)
      )
        return [];
      const below = folder.checkoutPrefix ?? relativePathWithin(folder.checkoutRoot, folder.path);
      return below !== null && below !== "" && included.some((path) => covers(path, below))
        ? [below]
        : [];
    });
    const nested =
      draft.checkoutRoot === null
        ? []
        : outermost(
            checkouts.flatMap((checkout) => {
              if (isSamePath(checkout.root, draft.checkoutRoot!)) return [];
              const below = relativePathWithin(draft.cwd, checkout.cwd);
              return below !== null && below !== "" && included.some((path) => covers(path, below))
                ? [below]
                : [];
            }),
          );
    return {
      key: draft.key,
      cwd: draft.cwd,
      vcs: draft.vcs,
      pathspecs: [
        ...included.map((path) => (path === "" ? "." : `:(literal)${path}`)),
        ...outermost([...nested, ...unavailableNested]).map((path) => `:(exclude,literal)${path}`),
      ],
      folders: draft.folders,
    };
  });
}

/**
 * The scope as `run` planned it. A queued run's dispatch rewrites the thread's
 * one root scope, so the row can hold a later run's plan. A run's own parts
 * come from its thread and the folder facts it recorded, so one run never sees
 * two folder sets.
 */
export function checkpointScopeForRun(input: {
  readonly scope: OrchestrationV2CheckpointScope;
  readonly thread: WorkspaceThread;
  readonly run: Pick<OrchestrationV2Run, "unavailableFolderPaths">;
}): OrchestrationV2CheckpointScope {
  if (input.scope.parts === undefined) return input.scope;
  const parts = checkpointScopeParts({
    thread: input.thread,
    unavailableFolderPaths: input.run.unavailableFolderPaths,
  });
  return parts?.[0] === undefined ? input.scope : { ...input.scope, cwd: parts[0].cwd, parts };
}

/** Where a run of a thread with several snapshot folders works: each folder it can reach. */
export function runFolderPaths(
  thread: WorkspaceThread,
  run: Pick<OrchestrationV2Run, "unavailableFolderPaths">,
): ReadonlyArray<string> {
  return (
    snapshotWorkspace(thread, run.unavailableFolderPaths)?.workspace.folders.flatMap((folder) =>
      folder.effectivePath === null ? [] : [folder.effectivePath],
    ) ?? []
  );
}

/**
 * A multi-part checkpoint's status: `error` if any git part errored, else
 * `ready` only when every git part is, else `missing`. Parts outside git don't
 * count, so a checkpoint without a git part is `missing`.
 */
export function checkpointBarrierStatus(
  parts: ReadonlyArray<Pick<OrchestrationV2CheckpointPart, "vcs" | "status">>,
): OrchestrationV2CheckpointStatus {
  const git = parts.filter((part) => part.vcs === "git");
  if (git.some((part) => part.status === "error")) return "error";
  return git.length > 0 && git.every((part) => part.status === "ready") ? "ready" : "missing";
}
