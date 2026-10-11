import {
  CommandId,
  GitCommandError,
  type GitManagerServiceError,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadWorkspaceFolder,
  type OrchestrationV2ThreadWorktree,
  type ProjectId,
  ThreadId,
  VcsThreadWorktreesError,
  type WorktreeSetupStageStatus,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName, sanitizeBranchFragment } from "@t3tools/shared/git";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import {
  hasOwnChanges,
  isPathWithin,
  isSamePath,
  nestedPathPrefixes,
  projectFolders,
  snapshotFolderCheckoutLocation,
  snapshotFolderPath,
  threadUsingWorktrees,
} from "@t3tools/shared/workspaceFolders";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceFolderResolver from "../project/WorkspaceFolderResolver.ts";
import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";
import type * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { randomUuidV4 } from "./RandomUuid.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class WorktreeRecreateError extends Schema.TaggedError<WorktreeRecreateError>()(
  "WorktreeRecreateError",
  {
    threadId: ThreadId,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not recreate the worktree at ${this.path}.`;
  }
}

/** A complete worktree set. The first member holds the thread's primary folder. */
export interface WorktreeSet {
  readonly members: ReadonlyArray<OrchestrationV2ThreadWorktree>;
  /**
   * The primary folder of a thread with a folder snapshot. Such a thread
   * records the members as its `worktrees` and works at this folder's place in
   * the set. A thread without one keeps today's binding: the first member's
   * worktree root and no tuple.
   */
  readonly primaryFolder?: OrchestrationV2ThreadWorkspaceFolder | undefined;
}

/** One worktree a plan creates. */
interface PlannedMember {
  readonly repositoryRoot: string;
  /** Null puts a lone worktree where git's driver always has. */
  readonly path: string | null;
  readonly branch: string;
  /** What the new branch starts from: a branch, or `HEAD` for a detached checkout. */
  readonly startRef: string;
  /** The branch it starts from, recorded as its merge base; null when detached. */
  readonly baseBranch: string | null;
}

/** A set checked against every member repository, ready for `create`. */
export interface WorktreeSetPlan {
  readonly members: ReadonlyArray<PlannedMember>;
  readonly startFromOrigin: boolean;
  readonly primaryFolder?: OrchestrationV2ThreadWorkspaceFolder | undefined;
}

/** The thread fields a set binds, written by one `thread.metadata.update`. */
export interface WorktreeSetBinding {
  readonly branch: string;
  readonly worktreePath: string;
  readonly worktrees?: ReadonlyArray<OrchestrationV2ThreadWorktree>;
}

/** A set an earlier thread of the project bound, with the folders it was bound for. */
export interface ReusableWorktreeSet {
  readonly workspaceFolders: ReadonlyArray<OrchestrationV2ThreadWorkspaceFolder>;
  readonly worktrees: ReadonlyArray<OrchestrationV2ThreadWorktree>;
}

/** Where one member's worktree lives, and the checkout git runs in to manage it. */
type WorktreeLocation = Pick<OrchestrationV2ThreadWorktree, "repositoryRoot" | "path">;

/** Drives the fetch and checkout stages of a thread's setup tracker. */
export interface WorktreeSetProgress {
  readonly stage: (
    stage: "fetch" | "checkout",
    status: WorktreeSetupStageStatus,
  ) => Effect.Effect<void>;
  /** Checkout progress over the whole set; `detail` names the repository for sets of several. */
  readonly checkout: (progress: {
    readonly percent: number;
    readonly detail: string | null;
  }) => Effect.Effect<void>;
}

export const noWorktreeSetProgress: WorktreeSetProgress = {
  stage: () => Effect.void,
  checkout: () => Effect.void,
};

/** Where a thread works in a set, and whether it records the members. */
export function worktreeSetBinding(set: WorktreeSet): WorktreeSetBinding {
  const primary = set.members[0]!;
  if (set.primaryFolder === undefined) {
    return { branch: primary.branch, worktreePath: primary.path };
  }
  return {
    branch: primary.branch,
    worktreePath: snapshotFolderPath(set.primaryFolder, set.members) ?? primary.path,
    worktrees: set.members,
  };
}

/**
 * Owns a thread's worktrees as one set: one worktree per git checkout among
 * its folders, created all or none, renamed together, recreated when missing
 * and removed together. Threads without a folder snapshot use one-member sets
 * and keep today's binding, so they carry no `worktrees` tuple.
 */
export class WorktreeSetService extends Context.Service<
  WorktreeSetService,
  {
    /**
     * Plans a set for a thread from its folder snapshot: its members, their
     * bases, names and places. Every name and place is checked free before
     * anything is created. A thread without a snapshot gets one member, today's
     * worktree of `projectRoot`.
     */
    readonly plan: (input: {
      readonly thread: Pick<OrchestrationV2AppThread, "id" | "workspaceFolders">;
      readonly projectRoot: string;
      readonly baseRef: string;
      readonly branch: string;
      readonly startFromOrigin: boolean;
      /** The session directory, instead of one under the worktrees directory. */
      readonly path?: string | undefined;
    }) => Effect.Effect<WorktreeSetPlan, VcsThreadWorktreesError | GitCommandError>;
    /**
     * Creates a planned set, parents before children. On failure or interrupt,
     * removes whatever it claimed and deletes the branches it created, so
     * callers get a complete set or nothing.
     */
    readonly create: (
      plan: WorktreeSetPlan,
      progress: WorktreeSetProgress,
    ) => Effect.Effect<
      WorktreeSet & {
        /** Whether the primary's branch starts from origin rather than the local base. */
        readonly startedFromOrigin: boolean;
      },
      GitCommandError
    >;
    /** Rolls back a set `create` returned: force-removes it and deletes its branches. */
    readonly discard: (set: WorktreeSet) => Effect.Effect<void>;
    /** Binds a thread to a complete set in one `thread.metadata.update`. */
    readonly bind: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly set: WorktreeSet;
      readonly expectedWorktreePath?: string | null | undefined;
    }) => Effect.Effect<WorktreeSetBinding, Orchestrator.OrchestratorV2Error>;
    /**
     * Renames every member's branch to `branch`, or the first variant free in
     * every repository, keeping each member's suffix. If any rename fails, the
     * members already renamed get their old names back.
     */
    readonly renameBranch: (
      set: WorktreeSet,
      input: { readonly branch: string; readonly exactName: boolean },
    ) => Effect.Effect<WorktreeSet, GitManagerServiceError>;
    /**
     * Recreates members whose worktree is gone, parents first, each from its
     * own checkout. Fails rather than pointing the thread anywhere else.
     */
    readonly recreateMissing: (
      thread: Pick<
        OrchestrationV2AppThread,
        "id" | "projectId" | "branch" | "worktreePath" | "workspaceFolders" | "worktrees"
      >,
    ) => Effect.Effect<void, WorktreeRecreateError>;
    /**
     * The set and folders of the newest thread in the project whose primary
     * works at `worktreePath`, so a thread reusing that worktree gets the
     * whole set.
     */
    readonly resolveForReuse: (input: {
      readonly projectId: ProjectId;
      readonly worktreePath: string;
    }) => Effect.Effect<Option.Option<ReusableWorktreeSet>, ProjectionStore.ProjectionStoreV2Error>;
    /** Plans, creates and binds a set for a thread that works in place. */
    readonly createForThread: (input: {
      readonly threadId: ThreadId;
      readonly baseRef: string;
      readonly branch?: string | undefined;
    }) => Effect.Effect<WorktreeSetBinding, VcsThreadWorktreesError | GitCommandError>;
    /**
     * Checks out `branch` in the chosen members, or every member, each under
     * its own name in the set, and records the branches they now expect.
     * Returns the members it switched.
     */
    readonly switchBranch: (input: {
      readonly threadId: ThreadId;
      readonly branch: string;
      readonly members?: ReadonlyArray<string> | undefined;
    }) => Effect.Effect<ReadonlyArray<WorktreeLocation>, VcsThreadWorktreesError | GitCommandError>;
    /**
     * Removes every worktree of a thread, deepest first, then what the set
     * leaves behind in its session directory, and returns the worktrees it
     * removed. Removes none while another thread, archived ones included, or a
     * project still works inside one. The thread may already be deleted.
     */
    readonly remove: (input: {
      readonly threadId: ThreadId;
      readonly force?: boolean | undefined;
    }) => Effect.Effect<ReadonlyArray<WorktreeLocation>, VcsThreadWorktreesError | GitCommandError>;
  }
>()("t3/orchestration-v2/WorktreeSetService") {}

const failure = (threadId: ThreadId, detail: string, cause?: unknown) =>
  new VcsThreadWorktreesError({ threadId, detail, ...(cause === undefined ? {} : { cause }) });

// A backslash separates segments only in Windows paths.
const depth = (path: string) =>
  path.split(isWindowsAbsolutePath(path) ? /[\\/]+/u : /\/+/u).filter(Boolean).length;
const deepestFirst = <Member extends WorktreeLocation>(members: ReadonlyArray<Member>) =>
  members.toSorted((left, right) => depth(right.path) - depth(left.path));

/** The deepest of `roots` that holds `location`. */
const owningRoot = (location: string, roots: ReadonlyArray<string>) =>
  roots
    .filter((root) => isPathWithin(root, location))
    .toSorted((left, right) => depth(right) - depth(left))[0];

/**
 * The order to create a set in: each member after the member whose worktree
 * holds it, and otherwise the primary first. A nested primary created first
 * would leave its parent's place non-empty, and git refuses that.
 */
function creationOrder<Member extends { readonly path: string | null }>(
  members: ReadonlyArray<Member>,
): ReadonlyArray<Member> {
  const parentOf = (member: Member) =>
    member.path === null
      ? undefined
      : owningRoot(
          member.path,
          members.flatMap((other) => (other === member || other.path === null ? [] : [other.path])),
        );
  const ordered: Array<Member> = [];
  const remaining = [...members];
  while (remaining.length > 0) {
    const ready = remaining.findIndex((member) => {
      const parent = parentOf(member);
      return parent === undefined || ordered.some((created) => created.path === parent);
    });
    ordered.push(...remaining.splice(Math.max(ready, 0), 1));
  }
  return ordered;
}

/**
 * Each member's branch in a set named `base`. Checkouts of one repository
 * share its branches and can't check one out twice, so after a repository's
 * first member the others get `<base>-<folder label>`.
 */
function memberBranchNames(
  base: string,
  members: ReadonlyArray<{ readonly commonDir: string; readonly label: string }>,
): ReadonlyArray<string> {
  const repositories: Array<string> = [];
  const taken = new Set([base]);
  return members.map((member) => {
    if (!repositories.some((commonDir) => isSamePath(commonDir, member.commonDir))) {
      repositories.push(member.commonDir);
      return base;
    }
    const stem = `${base}-${sanitizeBranchFragment(member.label)}`;
    let name = stem;
    for (let suffix = 2; taken.has(name); suffix += 1) name = `${stem}-${suffix}`;
    taken.add(name);
    return name;
  });
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const git = yield* GitWorkflow.GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const folderResolver = yield* WorkspaceFolderResolver.WorkspaceFolderResolver;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // Serializes a thread's set changes, so each starts from the binding the
  // last one left: two creations can't both make a set, and two switches
  // can't record each other's stale branches.
  const threadChanges = yield* makeKeyedSerialExecutor<ThreadId>();

  /** A snapshot folder's real place inside the checkout git found it in; undefined outside git. */
  const checkoutLocation = (folder: OrchestrationV2ThreadWorkspaceFolder) =>
    typeof folder.checkoutRoot !== "string"
      ? undefined
      : (snapshotFolderCheckoutLocation(folder) ?? folder.path);

  /** Each member's name in branch suffixes: the label of the first folder it holds. */
  const memberLabels = (
    roots: ReadonlyArray<string>,
    snapshot: ReadonlyArray<OrchestrationV2ThreadWorkspaceFolder>,
  ) =>
    roots.map((root) => {
      const folder = snapshot.find((candidate) => {
        const location = checkoutLocation(candidate);
        return location !== undefined && owningRoot(location, roots) === root;
      });
      return folder?.label ?? path.basename(root);
    });

  /** The lowest directory holding every path, if they share one. */
  const commonAncestor = (paths: ReadonlyArray<string>) => {
    let ancestor: string | undefined = paths[0];
    for (const candidate of paths.slice(1)) {
      while (ancestor !== undefined && !isPathWithin(ancestor, candidate)) {
        const parent: string = path.dirname(ancestor);
        ancestor = parent === ancestor ? undefined : parent;
      }
    }
    return ancestor;
  };

  /** Fails before anything is created if a member's branch or place is taken. */
  const requireFree = Effect.fn("WorktreeSetService.requireFree")(function* (
    threadId: ThreadId,
    members: ReadonlyArray<PlannedMember>,
  ) {
    for (const member of members) {
      const branches = yield* git.listLocalBranchNames(member.repositoryRoot);
      if (branches.includes(member.branch)) {
        return yield* failure(
          threadId,
          `Branch '${member.branch}' already exists in ${member.repositoryRoot}.`,
        );
      }
      const place = member.path;
      if (place === null) continue;
      const inUse = yield* fileSystem.exists(place).pipe(
        Effect.flatMap((exists) =>
          exists
            ? fileSystem.readDirectory(place).pipe(
                Effect.map((entries) => entries.length > 0),
                Effect.orElseSucceed(() => true),
              )
            : Effect.succeed(false),
        ),
        Effect.orElseSucceed(() => false),
      );
      if (inUse) return yield* failure(threadId, `${place} is already in use.`);
    }
  });

  const plan: WorktreeSetService["Service"]["plan"] = Effect.fn("WorktreeSetService.plan")(
    function* (input) {
      const threadId = input.thread.id;
      const snapshot = input.thread.workspaceFolders;
      if (snapshot === undefined) {
        // Today's lone worktree of the project's checkout.
        const member = {
          repositoryRoot: input.projectRoot,
          path: input.path ?? null,
          branch: input.branch,
          startRef: input.baseRef,
          baseBranch: input.baseRef,
        };
        yield* requireFree(threadId, [member]);
        return { members: [member], startFromOrigin: input.startFromOrigin };
      }

      const primary = snapshot[0];
      const primaryLocation = primary === undefined ? undefined : checkoutLocation(primary);
      if (primary?.path === undefined || primaryLocation === undefined) {
        return yield* failure(
          threadId,
          "Worktree mode needs the primary folder to be in a git repository.",
        );
      }
      // One member per checkout among the folders that were in git at binding.
      const roots: Array<string> = [];
      for (const folder of snapshot) {
        const root = folder.path === undefined ? null : folder.checkoutRoot;
        if (typeof root === "string" && !roots.some((known) => isSamePath(known, root))) {
          roots.push(root);
        }
      }
      const probes = yield* Effect.forEach(
        roots,
        (root) =>
          folderResolver.probe(root, { vcs: true }).pipe(
            Effect.map((probe) => ({
              root,
              checkout: probe.availability === "available" ? (probe.vcs ?? null) : null,
            })),
          ),
        { concurrency: 4 },
      );
      const available = probes.flatMap(({ root, checkout }) =>
        checkout === null ? [] : [{ root, checkout }],
      );
      // A submodule of another member rides with that member's worktree,
      // which populates it.
      const checkouts = available.filter(({ checkout }) => {
        const superproject = checkout.superprojectRoot;
        return (
          superproject === undefined ||
          !available.some((other) => isSamePath(other.root, superproject))
        );
      });
      const primaryRoot = owningRoot(
        primaryLocation,
        checkouts.map(({ root }) => root),
      );
      if (primaryRoot === undefined) {
        return yield* failure(
          threadId,
          `The primary folder's repository at ${primary.checkoutRoot} is unavailable.`,
        );
      }
      const ordered = [
        ...checkouts.filter(({ root }) => root === primaryRoot),
        ...checkouts.filter(({ root }) => root !== primaryRoot),
      ];
      const memberRoots = ordered.map(({ root }) => root);
      const labels = memberLabels(memberRoots, snapshot);
      const names = memberBranchNames(
        input.branch,
        ordered.map(({ checkout }, index) => ({
          commonDir: checkout.commonDir,
          label: labels[index]!,
        })),
      );

      // The session directory is where a lone worktree of the primary folder
      // would go. It mirrors the members' places below their lowest common
      // ancestor; members on different drives sit side by side.
      const session =
        input.path ??
        path.join(
          config.worktreesDir,
          path.basename(primary.path),
          input.branch.replace(/\//g, "-"),
        );
      const ancestor = memberRoots.length === 1 ? undefined : commonAncestor(memberRoots);
      const siblings: Array<string> = [];
      const places = memberRoots.map((root) => {
        if (memberRoots.length === 1) return session;
        if (ancestor !== undefined) {
          const relative = path.relative(ancestor, root);
          return relative === "" ? session : path.join(session, relative);
        }
        // Compared as whole places, so Windows names differing in case collide.
        const stem = path.join(session, path.basename(root));
        let place = stem;
        for (let suffix = 2; siblings.some((taken) => isSamePath(taken, place)); suffix += 1) {
          place = `${stem}-${suffix}`;
        }
        siblings.push(place);
        return place;
      });

      // The primary starts from the chosen base; the others from what they
      // have checked out now, or their commit when detached.
      const members = yield* Effect.forEach(ordered, ({ root }, index) =>
        Effect.gen(function* () {
          const baseBranch =
            index === 0
              ? input.baseRef
              : (yield* git
                  .localStatus({ cwd: root })
                  .pipe(
                    Effect.mapError((cause) =>
                      failure(threadId, `Could not read the branch checked out in ${root}.`, cause),
                    ),
                  )).refName;
          return {
            repositoryRoot: root,
            path: places[index]!,
            branch: names[index]!,
            startRef: baseBranch ?? "HEAD",
            baseBranch,
          } satisfies PlannedMember;
        }),
      );
      yield* requireFree(threadId, members);
      return { members, startFromOrigin: input.startFromOrigin, primaryFolder: primary };
    },
  );

  // Removing the worktree must succeed before deleting its branch; otherwise
  // the branch is still checked out there.
  const discardMembers = (members: ReadonlyArray<OrchestrationV2ThreadWorktree>) =>
    Effect.forEach(
      deepestFirst(members),
      (member) =>
        git.removeWorktree({ cwd: member.repositoryRoot, path: member.path, force: true }).pipe(
          Effect.andThen(() =>
            git.deleteLocalBranch({
              cwd: member.repositoryRoot,
              refName: member.branch,
              force: true,
            }),
          ),
          Effect.ignoreCause({ log: true }),
        ),
      { discard: true },
    );

  /** Where a member's branch starts when asked to start from origin: the base there, if it exists. */
  const originStart = Effect.fn("WorktreeSetService.originStart")(function* (
    member: PlannedMember,
    baseBranch: string,
  ) {
    yield* git.fetchRemote({
      cwd: member.repositoryRoot,
      remoteName: "origin",
      refName: baseBranch,
    });
    const remoteBaseExists = yield* git.remoteBranchExists({
      cwd: member.repositoryRoot,
      refName: baseBranch,
      remoteName: "origin",
    });
    if (!remoteBaseExists) return { ref: member.startRef, fromOrigin: false };
    const remote = yield* git.resolveRemoteTrackingCommit({
      cwd: member.repositoryRoot,
      refName: baseBranch,
      fallbackRemoteName: "origin",
    });
    return { ref: remote.commitSha, fromOrigin: true };
  });

  const create: WorktreeSetService["Service"]["create"] = Effect.fn("WorktreeSetService.create")(
    function* (planned, progress) {
      const claimed: Array<OrchestrationV2ThreadWorktree> = [];
      return yield* Effect.gen(function* () {
        // "Start from origin" is a stored default; repos without an origin, or
        // without the base there, start from the local base.
        const fetching = yield* Effect.forEach(planned.members, (member) =>
          planned.startFromOrigin && member.baseBranch !== null
            ? git.remoteExists({ cwd: member.repositoryRoot, remoteName: "origin" })
            : Effect.succeed(false),
        );
        const fetches = fetching.some(Boolean);
        yield* progress.stage("fetch", fetches ? "running" : "skipped");
        const starts = yield* Effect.forEach(planned.members, (member, index) =>
          fetching[index] === true && member.baseBranch !== null
            ? originStart(member, member.baseBranch)
            : Effect.succeed({ ref: member.startRef, fromOrigin: false }),
        );
        if (fetches) yield* progress.stage("fetch", "done");

        yield* progress.stage("checkout", "running");
        const order = creationOrder(planned.members);
        const created = new Map<PlannedMember, string>();
        for (const [position, member] of order.entries()) {
          const detail =
            order.length === 1 ? null : `Repository ${position + 1} of ${order.length}`;
          const report = (percent: number) =>
            progress.checkout({ percent: (position * 100 + percent) / order.length, detail });
          if (detail !== null) yield* report(0);
          const claimedBefore = claimed.length;
          const result = yield* git
            .createWorktree(
              {
                cwd: member.repositoryRoot,
                refName: starts[planned.members.indexOf(member)]!.ref,
                newRefName: member.branch,
                ...(member.baseBranch === null ? {} : { baseRefName: member.baseBranch }),
                path: member.path,
              },
              {
                progress: {
                  onWorktreeClaimed: (claimedPath) =>
                    Effect.sync(() => {
                      claimed.push({
                        repositoryRoot: member.repositoryRoot,
                        path: claimedPath,
                        branch: member.branch,
                      });
                    }),
                  onCheckoutProgress: (checkout) => report(checkout.percent),
                },
              },
            )
            .pipe(
              // `worktree add -b` makes the branch before it checks the place,
              // so a failed add can leave it behind. Something else may have
              // made a branch of that name since the plan, so only a merged
              // one goes: deleting it can't lose a commit.
              Effect.onError(() =>
                claimed.length === claimedBefore
                  ? git
                      .deleteLocalBranch({
                        cwd: member.repositoryRoot,
                        refName: member.branch,
                        force: false,
                      })
                      .pipe(Effect.ignore)
                  : Effect.void,
              ),
            );
          created.set(member, result.worktree.path);
        }
        const set: WorktreeSet = {
          members: planned.members.map((member) => ({
            repositoryRoot: member.repositoryRoot,
            path: created.get(member)!,
            branch: member.branch,
          })),
          primaryFolder: planned.primaryFolder,
        };
        // A primary below its member's root can sit in a submodule the
        // checkout left empty; the thread must never start in a missing place.
        const { worktreePath } = worktreeSetBinding(set);
        if (
          !isSamePath(worktreePath, set.members[0]!.path) &&
          !(yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => false)))
        ) {
          return yield* new GitCommandError({
            operation: "WorktreeSetService.create",
            command: "git",
            cwd: set.members[0]!.path,
            detail: `The primary folder is missing from its worktree at ${worktreePath}. Is it inside a submodule that wasn't checked out?`,
          });
        }
        yield* progress.stage("checkout", "done");
        return { ...set, startedFromOrigin: starts[0]?.fromOrigin === true };
      }).pipe(Effect.onError(() => discardMembers(claimed)));
    },
  );

  const discard: WorktreeSetService["Service"]["discard"] = Effect.fn("WorktreeSetService.discard")(
    function* (set) {
      yield* discardMembers(set.members);
    },
  );

  const bind: WorktreeSetService["Service"]["bind"] = Effect.fn("WorktreeSetService.bind")(
    function* (input) {
      const binding = worktreeSetBinding(input.set);
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        branch: binding.branch,
        worktreePath: binding.worktreePath,
        ...(binding.worktrees === undefined ? {} : { worktrees: binding.worktrees }),
        ...(input.expectedWorktreePath === undefined
          ? {}
          : { expectedWorktreePath: input.expectedWorktreePath }),
      });
      return binding;
    },
  );

  const renameBranch: WorktreeSetService["Service"]["renameBranch"] = Effect.fn(
    "WorktreeSetService.renameBranch",
  )(function* (set, input) {
    const primary = set.members[0]!;
    if (set.members.length === 1) {
      const renamed = yield* git.renameBranch({
        cwd: primary.path,
        oldBranch: primary.branch,
        newBranch: input.branch,
        ...(input.exactName ? { exactName: true } : {}),
      });
      return { ...set, members: [{ ...primary, branch: renamed.branch }] };
    }
    // The members were named together, as the primary's branch plus a
    // suffix, and keep their suffixes.
    const suffixes = set.members.map((member) =>
      member.branch.startsWith(primary.branch) ? member.branch.slice(primary.branch.length) : "",
    );
    const taken = yield* Effect.forEach(set.members, (member) =>
      git.listLocalBranchNames(member.repositoryRoot),
    );
    const candidates = input.exactName
      ? [input.branch]
      : [
          input.branch,
          ...Array.from({ length: 100 }, (_, index) => `${input.branch}-${index + 1}`),
        ];
    const base = candidates.find((candidate) =>
      set.members.every((_, index) => !taken[index]!.includes(`${candidate}${suffixes[index]}`)),
    );
    if (base === undefined) {
      return yield* new GitCommandError({
        operation: "WorktreeSetService.renameBranch",
        command: "git",
        cwd: primary.path,
        detail: `No branch named after '${input.branch}' is free in every repository of the set.`,
      });
    }
    const renamed: Array<OrchestrationV2ThreadWorktree> = [];
    return yield* Effect.gen(function* () {
      for (const [index, member] of set.members.entries()) {
        const branch = `${base}${suffixes[index]}`;
        yield* git.renameBranch({
          cwd: member.path,
          oldBranch: member.branch,
          newBranch: branch,
          exactName: true,
        });
        renamed.push({ ...member, branch });
      }
      return { ...set, members: renamed };
    }).pipe(
      // A set keeps one name: the members already renamed take their old ones back.
      Effect.onError(() =>
        Effect.forEach(
          renamed,
          (member, index) =>
            git
              .renameBranch({
                cwd: member.path,
                oldBranch: member.branch,
                newBranch: set.members[index]!.branch,
                exactName: true,
              })
              .pipe(Effect.ignoreCause({ log: true })),
          { discard: true },
        ),
      ),
      Effect.uninterruptible,
    );
  });

  const recreateMissing: WorktreeSetService["Service"]["recreateMissing"] = Effect.fn(
    "WorktreeSetService.recreateMissing",
  )(function* (thread) {
    const missing = (path: string) =>
      fileSystem.exists(path).pipe(
        Effect.map((exists) => !exists),
        Effect.orElseSucceed(() => false),
      );
    const recreate = (member: OrchestrationV2ThreadWorktree) =>
      Effect.logWarning("recreating missing worktree", {
        threadId: thread.id,
        worktreePath: member.path,
        branch: member.branch,
      }).pipe(
        Effect.andThen(git.pruneWorktrees({ cwd: member.repositoryRoot })),
        Effect.andThen(
          git.createWorktree({
            cwd: member.repositoryRoot,
            refName: member.branch,
            path: member.path,
          }),
        ),
        Effect.mapError(
          (cause) => new WorktreeRecreateError({ threadId: thread.id, path: member.path, cause }),
        ),
      );
    if (thread.worktrees === undefined) {
      // A plain thread's worktree comes from its project's checkout, and a
      // snapshot thread's from its own primary folder, which a relink of the
      // project's workspace file never moves. The project is read only once
      // the worktree is known to be gone.
      const { worktreePath, branch } = thread;
      if (worktreePath === null || branch === null || !(yield* missing(worktreePath))) return;
      const repositoryRoot =
        thread.workspaceFolders?.[0]?.path ??
        (yield* projects.getById(thread.projectId).pipe(
          Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
          Effect.orElseSucceed(() => undefined),
        ));
      if (repositoryRoot === undefined) return;
      yield* recreate({ repositoryRoot, path: worktreePath, branch });
      return;
    }
    for (const member of creationOrder(thread.worktrees)) {
      if (yield* missing(member.path)) yield* recreate(member);
    }
  });

  const resolveForReuse: WorktreeSetService["Service"]["resolveForReuse"] = Effect.fn(
    "WorktreeSetService.resolveForReuse",
  )(function* (input) {
    const shells = yield* projections.getShellSnapshot();
    const holder = [...shells.threads, ...shells.archivedThreads]
      .filter(
        (thread) =>
          thread.projectId === input.projectId &&
          thread.deletedAt === null &&
          thread.worktrees !== undefined &&
          thread.worktreePath !== null &&
          isSamePath(thread.worktreePath, input.worktreePath),
      )
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
      )[0];
    if (holder === undefined) return Option.none();
    const thread = yield* projections.getThread(holder.id);
    return thread.workspaceFolders === undefined || thread.worktrees === undefined
      ? Option.none()
      : Option.some({ workspaceFolders: thread.workspaceFolders, worktrees: thread.worktrees });
  });

  const createAndBind = Effect.fn("WorktreeSetService.createAndBind")(function* (input: {
    readonly threadId: ThreadId;
    readonly baseRef: string;
    readonly branch?: string | undefined;
  }) {
    const { threadId } = input;
    const thread = yield* projections
      .getThread(threadId)
      .pipe(Effect.mapError((cause) => failure(threadId, "Could not read the thread.", cause)));
    if (thread.deletedAt !== null || thread.archivedAt !== null) {
      return yield* failure(threadId, "Only an active thread can get worktrees.");
    }
    if (thread.worktreePath !== null) {
      return yield* failure(threadId, "This thread already works in a worktree.");
    }
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.mapError((cause) => failure(threadId, "Could not read the thread's project.", cause)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(failure(threadId, "The thread's project no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    const uuid = (yield* randomUuidV4).replaceAll("-", "");
    const planned = yield* plan({
      thread,
      projectRoot: project.workspaceRoot,
      baseRef: input.baseRef,
      branch: input.branch ?? buildTemporaryWorktreeBranchName(() => uuid),
      startFromOrigin: false,
    });
    // Only the creation stays interruptible: once it returns, the set is
    // either bound or rolled back.
    return yield* Effect.uninterruptibleMask((restore) =>
      restore(create(planned, noWorktreeSetProgress)).pipe(
        Effect.flatMap((set) =>
          bind({
            commandId: CommandId.make(`worktree-set:create:${threadId}:${uuid}`),
            threadId,
            set,
            // A binding that landed meanwhile wins, and this set goes.
            expectedWorktreePath: null,
          }).pipe(
            Effect.onError(() => discard(set)),
            Effect.mapError((cause) =>
              failure(threadId, "Could not bind the thread to its worktrees.", cause),
            ),
          ),
        ),
      ),
    );
  });

  const createForThread: WorktreeSetService["Service"]["createForThread"] = (input) =>
    threadChanges.withLock(input.threadId, createAndBind(input));

  const switchBranch: WorktreeSetService["Service"]["switchBranch"] = (input) =>
    threadChanges.withLock(input.threadId, switchMembers(input));

  const switchMembers = Effect.fn("WorktreeSetService.switchBranch")(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string;
    readonly members?: ReadonlyArray<string> | undefined;
  }) {
    const { threadId } = input;
    const thread = yield* projections
      .getThread(threadId)
      .pipe(Effect.mapError((cause) => failure(threadId, "Could not read the thread.", cause)));
    const worktrees = thread.worktrees;
    const snapshot = thread.workspaceFolders;
    if (thread.deletedAt !== null || worktrees === undefined || snapshot === undefined) {
      return yield* failure(threadId, "This thread has no worktree set.");
    }
    const unknown = input.members?.find(
      (root) => !worktrees.some((member) => isSamePath(member.repositoryRoot, root)),
    );
    if (unknown !== undefined) {
      return yield* failure(threadId, `${unknown} is not in this thread's worktree set.`);
    }
    const roots = worktrees.map((member) => member.repositoryRoot);
    const labels = memberLabels(roots, snapshot);
    const probes = yield* Effect.forEach(
      roots,
      (root) => folderResolver.probe(root, { vcs: true }),
      { concurrency: 4 },
    );
    const suffixed = memberBranchNames(
      input.branch,
      worktrees.map((member, index) => ({
        commonDir: probes[index]?.vcs?.commonDir ?? member.repositoryRoot,
        label: labels[index]!,
      })),
    );
    // "Switch back" for chosen members may name a member's own expected
    // branch rather than the set's; that branch is checked out as it is.
    const names = worktrees.map((member, index) =>
      input.members !== undefined && member.branch === input.branch
        ? member.branch
        : suffixed[index]!,
    );
    const next = [...worktrees];
    const switched: Array<WorktreeLocation> = [];
    // The switches and their record land together, so an interrupt never
    // leaves switched members unrecorded, reading as drifted.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const outcome = yield* Effect.exit(
          Effect.forEach(
            worktrees,
            (member, index) =>
              input.members !== undefined &&
              !input.members.some((root) => isSamePath(root, member.repositoryRoot))
                ? Effect.void
                : git.switchRef({ cwd: member.path, refName: names[index]! }).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        next[index] = { ...member, branch: names[index]! };
                        switched.push(member);
                      }),
                    ),
                  ),
            { discard: true },
          ),
        );
        // Members that switched expect their new branch, even when a later one failed.
        if (next.some((member, index) => member.branch !== worktrees[index]!.branch)) {
          const uuid = yield* randomUuidV4;
          yield* threads
            .dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`worktree-set:switch:${threadId}:${uuid}`),
              threadId,
              // The thread's branch follows its primary, and only when that moved.
              ...(next[0]!.branch === worktrees[0]!.branch ? {} : { branch: next[0]!.branch }),
              worktreePath: thread.worktreePath,
              worktrees: next,
              // A writer that moved the thread meanwhile wins.
              expectedWorktreePath: thread.worktreePath,
            })
            .pipe(
              Effect.mapError((cause) =>
                failure(threadId, "Could not record the set's new branches.", cause),
              ),
            );
        }
        if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
        return switched;
      }),
    );
  });

  /**
   * Where a set's generated editor workspace file lives: in the session
   * directory, or beside it when that directory is a member's worktree, so it
   * never shows up as a change in that checkout.
   */
  const editorWorkspaceFilePath = (session: string, members: ReadonlyArray<WorktreeLocation>) =>
    members.some((member) => isSamePath(member.path, session))
      ? `${session}.code-workspace`
      : path.join(session, `${path.basename(session)}.code-workspace`);

  /**
   * What a removed set leaves in T3's worktrees directory: the generated
   * editor workspace file, and the directories git made on the way to each
   * member, the session directory last, once they are empty.
   */
  const removeSessionLeftovers = Effect.fn("WorktreeSetService.removeSessionLeftovers")(function* (
    members: ReadonlyArray<WorktreeLocation>,
  ) {
    const session =
      members.length === 1 ? members[0]!.path : commonAncestor(members.map(({ path }) => path));
    if (
      session === undefined ||
      isSamePath(session, config.worktreesDir) ||
      !isPathWithin(config.worktreesDir, session)
    ) {
      return;
    }
    yield* fileSystem
      .remove(editorWorkspaceFilePath(session, members), { force: true })
      .pipe(Effect.ignore);
    const directories = new Set<string>();
    for (const member of members) {
      let directory = path.dirname(member.path);
      while (isPathWithin(session, directory) && !directories.has(directory)) {
        directories.add(directory);
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    for (const directory of [...directories].toSorted(
      (left, right) => depth(right) - depth(left),
    )) {
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed(() => null));
      if (entries?.length === 0) {
        yield* fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore);
      }
    }
  });

  const remove: WorktreeSetService["Service"]["remove"] = Effect.fn("WorktreeSetService.remove")(
    function* (input) {
      const fail = (detail: string, cause?: unknown) => failure(input.threadId, detail, cause);
      const thread = yield* projections
        .getThread(input.threadId)
        .pipe(Effect.mapError((cause) => fail("Could not read the thread.", cause)));
      let members: ReadonlyArray<WorktreeLocation> = thread.worktrees ?? [];
      if (thread.worktrees === undefined && thread.worktreePath !== null) {
        const project = yield* projects
          .getById(thread.projectId, { includeDeleted: true })
          .pipe(Effect.mapError((cause) => fail("Could not read the thread's project.", cause)));
        if (Option.isNone(project)) {
          return yield* fail("The thread's project no longer exists.");
        }
        members = [
          {
            repositoryRoot: thread.workspaceFolders?.[0]?.path ?? project.value.workspaceRoot,
            path: thread.worktreePath,
          },
        ];
      }
      if (members.length === 0) return [];

      const paths = members.map((member) => member.path);
      // Without a location, the snapshot holds active and archived threads.
      const shells = yield* projections
        .getShellSnapshot()
        .pipe(Effect.mapError((cause) => fail("Could not read the other threads.", cause)));
      const user = threadUsingWorktrees(
        [...shells.threads, ...shells.archivedThreads],
        thread.id,
        paths,
      );
      if (user !== undefined) {
        return yield* fail(`"${user.title}" still works in this thread's worktrees.`);
      }
      // A worktree added as a project, or as one of a project's workspace
      // folders, has threads working in it that record no worktree.
      const projectShells = yield* projects
        .listShells()
        .pipe(Effect.mapError((cause) => fail("Could not read the projects.", cause)));
      const projectInside = projectShells.find((project) =>
        projectFolders(project).some(
          (folder) =>
            folder.path !== undefined && paths.some((path) => isPathWithin(path, folder.path!)),
        ),
      );
      if (projectInside !== undefined) {
        return yield* fail(
          `The project "${projectInside.title}" has a folder in this thread's worktrees.`,
        );
      }
      // Without force, git refuses a worktree with changes. Check them all
      // first, so a refusal can't leave half a set; a nested member is no
      // change of its parent's.
      if (input.force !== true) {
        for (const member of members) {
          yield* git.invalidateLocalStatus(member.path);
          const status = yield* git
            .localStatus({ cwd: member.path })
            .pipe(
              Effect.mapError((cause) =>
                fail(`Could not read the changes in ${member.path}.`, cause),
              ),
            );
          if (hasOwnChanges(status, nestedPathPrefixes(member.path, paths))) {
            return yield* fail(`${member.path} has changes, so no worktree was removed.`);
          }
        }
      }

      const ordered = deepestFirst(members);
      for (const member of ordered) {
        yield* git.removeWorktree({
          cwd: member.repositoryRoot,
          path: member.path,
          ...(input.force === undefined ? {} : { force: input.force }),
        });
      }
      yield* removeSessionLeftovers(members);
      return ordered;
    },
  );

  return WorktreeSetService.of({
    plan,
    create,
    discard,
    bind,
    renameBranch,
    recreateMissing,
    resolveForReuse,
    createForThread,
    switchBranch,
    remove,
  });
});

export const layer = Layer.effect(WorktreeSetService, make);
