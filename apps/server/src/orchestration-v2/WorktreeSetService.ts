import {
  type GitCommandError,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadWorktree,
  ThreadId,
  VcsThreadWorktreesError,
  type WorktreeSetupStageStatus,
} from "@t3tools/contracts";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { isPathWithin, threadUsingWorktrees } from "@t3tools/shared/workspaceFolders";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

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
}

/** Where one member's worktree lives, and the checkout git runs in to manage it. */
type WorktreeLocation = Pick<OrchestrationV2ThreadWorktree, "repositoryRoot" | "path">;

/** Drives the fetch and checkout stages of a thread's setup tracker. */
export interface WorktreeSetProgress {
  readonly stage: (
    stage: "fetch" | "checkout",
    status: WorktreeSetupStageStatus,
  ) => Effect.Effect<void>;
  readonly checkoutPercent: (percent: number) => Effect.Effect<void>;
}

/**
 * Owns a thread's worktrees as one set: creating them all or none, recreating
 * missing ones at turn start, and removing them together. Plain projects use
 * one-member sets and keep today's binding, so their threads carry no
 * `worktrees` tuple; the members are derived from `worktreePath`.
 */
export class WorktreeSetService extends Context.Service<
  WorktreeSetService,
  {
    /**
     * Creates a new branch and its worktree from `baseRef`, in the checkout
     * containing `cwd`. On failure or interrupt, removes whatever it claimed
     * and deletes the branches it created, so callers get a complete set or
     * nothing.
     */
    readonly create: (
      input: {
        readonly cwd: string;
        readonly baseRef: string;
        readonly branch: string;
        readonly startFromOrigin: boolean;
      },
      progress: WorktreeSetProgress,
    ) => Effect.Effect<WorktreeSet, GitCommandError>;
    /** Rolls back a set `create` returned: force-removes it and deletes its branches. */
    readonly discard: (set: WorktreeSet) => Effect.Effect<void>;
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
     * Removes every worktree of a thread, deepest first, and returns what it
     * removed. Removes none while another thread, archived ones included, or a
     * project still works inside one. The thread may already be deleted.
     */
    readonly remove: (input: {
      readonly threadId: ThreadId;
      readonly force?: boolean | undefined;
    }) => Effect.Effect<ReadonlyArray<WorktreeLocation>, VcsThreadWorktreesError | GitCommandError>;
  }
>()("t3/orchestration-v2/WorktreeSetService") {}

// A backslash separates segments only in Windows paths.
const depth = (path: string) =>
  path.split(isWindowsAbsolutePath(path) ? /[\\/]+/u : /\/+/u).filter(Boolean).length;
const parentsFirst = <Member extends WorktreeLocation>(members: ReadonlyArray<Member>) =>
  members.toSorted((left, right) => depth(left.path) - depth(right.path));
const deepestFirst = <Member extends WorktreeLocation>(members: ReadonlyArray<Member>) =>
  parentsFirst(members).toReversed();

const make = Effect.gen(function* () {
  const git = yield* GitWorkflow.GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const projects = yield* ProjectService.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  // Removing the worktree must succeed before deleting its branch; otherwise
  // the branch is still checked out there.
  const discardMembers = (members: ReadonlyArray<OrchestrationV2ThreadWorktree>) =>
    Effect.forEach(
      deepestFirst(members),
      (member) =>
        git.removeWorktree({ cwd: member.repositoryRoot, path: member.path, force: true }).pipe(
          Effect.andThen(
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

  const create: WorktreeSetService["Service"]["create"] = Effect.fn("WorktreeSetService.create")(
    function* (input, progress) {
      const claimed: Array<OrchestrationV2ThreadWorktree> = [];
      return yield* Effect.gen(function* () {
        let startRef = input.baseRef;
        // "Start from origin" is a stored default; repos without the requested
        // remote branch fall back to the local base branch.
        const startFromOrigin =
          input.startFromOrigin &&
          (yield* git.remoteExists({ cwd: input.cwd, remoteName: "origin" }));
        yield* progress.stage("fetch", startFromOrigin ? "running" : "skipped");
        if (startFromOrigin) {
          yield* git.fetchRemote({
            cwd: input.cwd,
            remoteName: "origin",
            refName: input.baseRef,
          });
          const remoteBaseExists = yield* git.remoteBranchExists({
            cwd: input.cwd,
            refName: input.baseRef,
            remoteName: "origin",
          });
          if (remoteBaseExists) {
            startRef = (yield* git.resolveRemoteTrackingCommit({
              cwd: input.cwd,
              refName: input.baseRef,
              fallbackRemoteName: "origin",
            })).commitSha;
          }
          yield* progress.stage("fetch", "done");
        }
        yield* progress.stage("checkout", "running");
        const created = yield* git.createWorktree(
          {
            cwd: input.cwd,
            refName: startRef,
            newRefName: input.branch,
            baseRefName: input.baseRef,
            // A one-member set lives exactly where a lone worktree always has.
            path: null,
          },
          {
            progress: {
              onWorktreeClaimed: (path) =>
                Effect.sync(() => {
                  claimed.push({
                    repositoryRoot: input.cwd,
                    path,
                    branch: input.branch,
                  });
                }),
              onCheckoutProgress: (checkout) => progress.checkoutPercent(checkout.percent),
            },
          },
        );
        yield* progress.stage("checkout", "done");
        return {
          members: [
            {
              repositoryRoot: input.cwd,
              path: created.worktree.path,
              branch: created.worktree.refName,
            },
          ],
        };
      }).pipe(Effect.onError(() => discardMembers(claimed)));
    },
  );

  const discard: WorktreeSetService["Service"]["discard"] = Effect.fn("WorktreeSetService.discard")(
    function* (set) {
      yield* discardMembers(set.members);
    },
  );

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
    for (const member of parentsFirst(thread.worktrees)) {
      if (yield* missing(member.path)) yield* recreate(member);
    }
  });

  const remove: WorktreeSetService["Service"]["remove"] = Effect.fn("WorktreeSetService.remove")(
    function* (input) {
      const failure = (detail: string, cause?: unknown) =>
        new VcsThreadWorktreesError({ threadId: input.threadId, detail, cause });
      const thread = yield* projections
        .getThread(input.threadId)
        .pipe(Effect.mapError((cause) => failure("Could not read the thread.", cause)));
      let members: ReadonlyArray<WorktreeLocation> = thread.worktrees ?? [];
      if (thread.worktrees === undefined && thread.worktreePath !== null) {
        const project = yield* projects
          .getById(thread.projectId, { includeDeleted: true })
          .pipe(Effect.mapError((cause) => failure("Could not read the thread's project.", cause)));
        if (Option.isNone(project)) {
          return yield* failure("The thread's project no longer exists.");
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
        .pipe(Effect.mapError((cause) => failure("Could not read the other threads.", cause)));
      const user = threadUsingWorktrees(
        [...shells.threads, ...shells.archivedThreads],
        thread.id,
        paths,
      );
      if (user !== undefined) {
        return yield* failure(`"${user.title}" still works in this thread's worktrees.`);
      }
      // A worktree added as a project of its own has threads working in it
      // that record no worktree.
      const projectShells = yield* projects
        .listShells()
        .pipe(Effect.mapError((cause) => failure("Could not read the projects.", cause)));
      const projectInside = projectShells.find((project) =>
        paths.some((path) => isPathWithin(path, project.workspaceRoot)),
      );
      if (projectInside !== undefined) {
        return yield* failure(
          `The project "${projectInside.title}" lives in this thread's worktrees.`,
        );
      }

      const ordered = deepestFirst(members);
      for (const member of ordered) {
        yield* git.removeWorktree({
          cwd: member.repositoryRoot,
          path: member.path,
          ...(input.force === undefined ? {} : { force: input.force }),
        });
      }
      return ordered;
    },
  );

  return WorktreeSetService.of({ create, discard, recreateMissing, remove });
});

export const layer = Layer.effect(WorktreeSetService, make);
