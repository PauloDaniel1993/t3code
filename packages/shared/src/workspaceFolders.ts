import type {
  OrchestrationV2ThreadWorkspaceFolder,
  OrchestrationV2ThreadWorktree,
  WorkspaceFolderEntry,
} from "@t3tools/contracts";

import { isWindowsAbsolutePath } from "./path.ts";

// A label is one path segment: no separators, no characters Windows reserves
// in file names, no control characters.
const UNSAFE_LABEL_CHARACTERS = /[\\/:*?"<>|\p{Cc}]+/gu;

function sanitizeLabel(candidate: string): string | undefined {
  const label = candidate.replace(UNSAFE_LABEL_CHARACTERS, "-").trim();
  return label === "" || label === "." || label === ".." ? undefined : label;
}

function lastSegment(location: string): string {
  return location.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? "";
}

/**
 * Give each workspace folder its unique canonical path label, as in
 * `<label>/src/main.ts`. The label is the folder's name made a safe path
 * segment, else its basename, else `folder`. Every folder reserves its
 * preferred label first, unavailable folders included, so availability never
 * renumbers labels. Repeats then take the next free `-2`, `-3`, … in entry
 * order, compared case-insensitively: `app, app, app-2` becomes
 * `app, app-3, app-2`.
 */
export function allocateFolderLabels<Entry extends WorkspaceFolderEntry>(
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry & { readonly label: string }> {
  const preferred = entries.map(
    (entry) =>
      sanitizeLabel(entry.name) ??
      sanitizeLabel(lastSegment(entry.path ?? entry.uri ?? "")) ??
      "folder",
  );
  const taken = new Set(preferred.map((label) => label.toLowerCase()));
  const claimed = new Set<string>();
  return entries.map((entry, index) => {
    const label = preferred[index] ?? "folder";
    if (!claimed.has(label.toLowerCase())) {
      claimed.add(label.toLowerCase());
      return { ...entry, label };
    }
    let suffix = 2;
    while (taken.has(`${label}-${suffix}`.toLowerCase())) suffix += 1;
    const allocated = `${label}-${suffix}`;
    taken.add(allocated.toLowerCase());
    return { ...entry, label: allocated };
  });
}

/** A workspace folder with its canonical path label. */
export type LabelledWorkspaceFolder = WorkspaceFolderEntry & { readonly label: string };

/** The project fields the workspace helpers read: a shell, a `Project` or a stored row. */
export interface WorkspaceProject {
  readonly workspaceRoot: string;
  /** A linked project's folders: labelled as served, or unlabelled as stored. */
  readonly folders?:
    | ReadonlyArray<WorkspaceFolderEntry & { readonly label?: string | undefined }>
    | null
    | undefined;
}

function hasLabels(
  folders: NonNullable<WorkspaceProject["folders"]>,
): folders is ReadonlyArray<LabelledWorkspaceFolder> {
  return folders.every((folder) => folder.label !== undefined);
}

/**
 * A project's folders in order, primary first, each with its label. A linked
 * project has its workspace file's folders. A plain project has one: its
 * workspace root, named after its basename.
 */
export function projectFolders(project: WorkspaceProject): ReadonlyArray<LabelledWorkspaceFolder> {
  const folders = project.folders;
  if (folders == null || folders.length === 0) {
    const root = project.workspaceRoot;
    return allocateFolderLabels([{ path: root, name: lastSegment(root) || root }]);
  }
  return hasLabels(folders) ? folders : allocateFolderLabels(folders);
}

/** The thread fields the workspace helpers read: a thread detail, or a shell, which has no snapshot. */
export interface WorkspaceThread {
  readonly worktreePath: string | null;
  readonly workspaceFolders?: ReadonlyArray<OrchestrationV2ThreadWorkspaceFolder> | undefined;
  readonly worktrees?: ReadonlyArray<OrchestrationV2ThreadWorktree> | undefined;
  /** A shell's stand-in for the snapshot's primary folder. */
  readonly workspacePrimaryPath?: string | undefined;
}

/**
 * Where a thread works: its primary folder, inside its worktree when it has
 * one. Without a folder snapshot this is `worktreePath ?? project.workspaceRoot`.
 * A shell has no snapshot, so it names its primary in `workspacePrimaryPath`.
 * Null only when neither the thread nor a project names a folder.
 */
export function threadPrimaryPath(
  thread: WorkspaceThread | null | undefined,
  project: WorkspaceProject,
): string;
export function threadPrimaryPath(
  thread: WorkspaceThread | null | undefined,
  project: WorkspaceProject | null | undefined,
): string | null;
export function threadPrimaryPath(
  thread: WorkspaceThread | null | undefined,
  project: WorkspaceProject | null | undefined,
): string | null {
  return (
    thread?.worktreePath ??
    thread?.workspaceFolders?.[0]?.path ??
    thread?.workspacePrimaryPath ??
    project?.workspaceRoot ??
    null
  );
}

export interface ResolvedWorkspaceFolder {
  /** The folder's original location, a path or a kept URI, and its name. */
  readonly folder: WorkspaceFolderEntry;
  readonly label: string;
  /**
   * Where the thread works on this folder: inside its worktree set, or in
   * place. Null for URI folders and for folders unavailable to this run.
   */
  readonly effectivePath: string | null;
  readonly isPrimary: boolean;
  /** The snapshot's checkout root. Null outside git, undefined when not known. */
  readonly checkoutRoot: string | null | undefined;
}

export interface ThreadWorkspace {
  /** The thread's working directory, as `threadPrimaryPath` gives it. */
  readonly primaryPath: string;
  /** In snapshot order, primary first. A thread without a snapshot has one folder. */
  readonly folders: ReadonlyArray<ResolvedWorkspaceFolder>;
}

/**
 * Resolve a thread's folders from its frozen snapshot. Each folder lives where
 * `worktreeSetPath` puts it, and the primary at the thread's `worktreePath`. A
 * thread without a snapshot gets exactly one folder at `worktreePath ??
 * project.workspaceRoot`. `unavailableFolderPaths` is the run's record of
 * snapshot folders it can't reach.
 */
export function resolveThreadWorkspace(input: {
  readonly thread: WorkspaceThread;
  readonly project: WorkspaceProject;
  readonly unavailableFolderPaths?: ReadonlyArray<string> | undefined;
}): ThreadWorkspace {
  const { thread, project } = input;
  const primaryPath = threadPrimaryPath(thread, project);
  const snapshot = thread.workspaceFolders;
  if (snapshot === undefined || snapshot.length === 0) {
    const primary = projectFolders(project)[0]!;
    return {
      primaryPath,
      folders: [
        {
          folder: primary,
          label: primary.label,
          effectivePath: primaryPath,
          isPrimary: true,
          checkoutRoot: undefined,
        },
      ],
    };
  }
  const unavailable = new Set(input.unavailableFolderPaths);
  const members = thread.worktrees ?? [];
  return {
    primaryPath,
    folders: snapshot.map((folder, index) => ({
      folder,
      label: folder.label,
      effectivePath:
        folder.path === undefined || unavailable.has(folder.path)
          ? null
          : index === 0
            ? primaryPath
            : worktreeSetPath(folder.path, members),
      isPrimary: index === 0,
      checkoutRoot: folder.checkoutRoot,
    })),
  };
}

/** Whether `path` is `root` or inside it. Windows paths compare case-insensitively. */
export function isPathWithin(root: string, path: string): boolean {
  return segmentsBelow(root, path) !== null;
}

/** Whether two paths name one location, compared as `isPathWithin` compares them. */
export function isSamePath(left: string, right: string): boolean {
  return segmentsBelow(left, right)?.length === 0;
}

/**
 * Where a folder lives in a thread's worktree set: at the same place below the
 * worktree of the deepest member whose checkout contains it. A folder outside
 * every member's checkout, or already inside a member's worktree, stays put.
 */
export function worktreeSetPath(
  path: string,
  members: ReadonlyArray<OrchestrationV2ThreadWorktree>,
): string {
  if (members.some((member) => isPathWithin(member.path, path))) return path;
  let deepest: { readonly worktree: string; readonly rest: ReadonlyArray<string> } | undefined;
  for (const member of members) {
    const rest = segmentsBelow(member.repositoryRoot, path);
    // Fewer segments left below the member means a deeper member.
    if (rest !== null && (deepest === undefined || rest.length < deepest.rest.length)) {
      deepest = { worktree: member.path, rest };
    }
  }
  if (deepest === undefined) return path;
  if (deepest.rest.length === 0) return deepest.worktree;
  const separator = isWindowsAbsolutePath(deepest.worktree) ? "\\" : "/";
  return `${deepest.worktree.replace(/[\\/]+$/, "")}${separator}${deepest.rest.join(separator)}`;
}

/** The worktrees a thread owns: each member of its set, or the one it is bound to. */
function threadWorktreePaths(
  thread: Pick<WorkspaceThread, "worktreePath" | "worktrees">,
): ReadonlyArray<string> {
  return (
    thread.worktrees?.map((member) => member.path) ??
    (thread.worktreePath === null ? [] : [thread.worktreePath])
  );
}

type WorktreeOwner = Pick<WorkspaceThread, "worktreePath" | "worktrees"> & {
  readonly id: string;
};

/** A thread other than `threadId` that works inside any of `worktreePaths`, if one does. */
export function threadUsingWorktrees<Thread extends WorktreeOwner>(
  threads: ReadonlyArray<Thread>,
  threadId: string,
  worktreePaths: ReadonlyArray<string>,
): Thread | undefined {
  return threads.find(
    (other) =>
      other.id !== threadId &&
      threadWorktreePaths(other).some((otherPath) =>
        worktreePaths.some((path) => isPathWithin(path, otherPath)),
      ),
  );
}

/**
 * The worktrees deleting `threadId` would leave unused. A set is removed whole
 * or not at all, so this is empty while any other thread still works inside
 * one of its worktrees.
 */
export function orphanedThreadWorktreePaths(
  threads: ReadonlyArray<WorktreeOwner>,
  threadId: string,
): ReadonlyArray<string> {
  const thread = threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined) return [];
  const paths = threadWorktreePaths(thread);
  return threadUsingWorktrees(threads, threadId, paths) === undefined ? paths : [];
}

// A backslash separates segments only in Windows paths; in POSIX it is a name character.
function pathSegments(path: string, windows: boolean): ReadonlyArray<string> {
  return path.split(windows ? /[\\/]+/ : /\/+/).filter((segment) => segment.length > 0);
}

// Both paths are absolute server paths; an absolute and a relative one never nest.
function segmentsBelow(root: string, path: string): ReadonlyArray<string> | null {
  const windows = isWindowsAbsolutePath(root);
  if (windows !== isWindowsAbsolutePath(path)) return null;
  if (!windows && root.startsWith("/") !== path.startsWith("/")) return null;
  const rootSegments = pathSegments(root, windows);
  const segments = pathSegments(path, windows);
  const key = (segment: string) => (windows ? segment.toLowerCase() : segment);
  return rootSegments.length <= segments.length &&
    rootSegments.every((segment, index) => key(segment) === key(segments[index]!))
    ? segments.slice(rootSegments.length)
    : null;
}
