import {
  type GitCommandError,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadWorktree,
  ThreadId,
  VcsThreadWorktreesError,
  type WorktreeSetupStageStatus,
} from "@t3tools/contracts";
import { isPathWithin, threadWorktreePaths } from "@t3tools/shared/workspaceFolders";
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
     * Creates a new branch and its worktree from `baseRef` in `repositoryRoot`.
     * On failure or interrupt, removes whatever it claimed and deletes the
     * branches it created, so callers get a complete set or nothing.
     */
    readonly create: (
      input: {
        readonly repositoryRoot: string;
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
        "id" | "projectId" | "branch" | "worktreePath" | "worktrees"
      >,
    ) => Effect.Effect<void, WorktreeRecreateError>;
    /**
     * Removes every worktree of a thread, deepest first, and returns what it
     * removed. Removes none while another thread still works inside one. The
     * thread may already be deleted.
     */
    readonly remove: (input: {
      readonly threadId: ThreadId;
      readonly force?: boolean | undefined;
    }) => Effect.Effect<ReadonlyArray<WorktreeLocation>, VcsThreadWorktreesError | GitCommandError>;
  }
>()("t3/orchestration-v2/WorktreeSetService") {}

const depth = (path: string) => path.split(/[\\/]+/u).filter(Boolean).length;
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
          (yield* git.remoteExists({ cwd: input.repositoryRoot, remoteName: "origin" }));
        yield* progress.stage("fetch", startFromOrigin ? "running" : "skipped");
        if (startFromOrigin) {
          yield* git.fetchRemote({
            cwd: input.repositoryRoot,
            remoteName: "origin",
            refName: input.baseRef,
          });
          const remoteBaseExists = yield* git.remoteBranchExists({
            cwd: input.repositoryRoot,
            refName: input.baseRef,
            remoteName: "origin",
          });
          if (remoteBaseExists) {
            startRef = (yield* git.resolveRemoteTrackingCommit({
              cwd: input.repositoryRoot,
              refName: input.baseRef,
              fallbackRemoteName: "origin",
            })).commitSha;
          }
          yield* progress.stage("fetch", "done");
        }
        yield* progress.stage("checkout", "running");
        const created = yield* git.createWorktree(
          {
            cwd: input.repositoryRoot,
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
                    repositoryRoot: input.repositoryRoot,
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
              repositoryRoot: input.repositoryRoot,
              path: created.worktree.path,
              branch: created.worktree.refName,
            },
          ],
        };
      }).pipe(Effect.onError(() => discardMembers(claimed)));
    },
  );

  const discard: WorktreeSetService["Service"]["discard"] = (set) => discardMembers(set.members);

  const recreateMissing: WorktreeSetService["Service"]["recreateMissing"] = Effect.fn(
    "WorktreeSetService.recreateMissing",
  )(function* (thread) {
    const missing = (path: string) =>
      fileSystem.exists(path).pipe(
        Effect.map((exists) => !exists),
        Effect.orElseSucceed(() => false),
      );
    let members = thread.worktrees ?? [];
    if (thread.worktrees === undefined) {
      const { worktreePath, branch } = thread;
      if (worktreePath === null || branch === null || !(yield* missing(worktreePath))) return;
      const project = yield* projects.getById(thread.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (project === undefined) return;
      members = [{ repositoryRoot: project.workspaceRoot, path: worktreePath, branch }];
    }
    for (const member of parentsFirst(members)) {
      if (!(yield* missing(member.path))) continue;
      yield* Effect.logWarning("recreating missing worktree", {
        threadId: thread.id,
        worktreePath: member.path,
        branch: member.branch,
      });
      yield* git.pruneWorktrees({ cwd: member.repositoryRoot }).pipe(
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
        members = [{ repositoryRoot: project.value.workspaceRoot, path: thread.worktreePath }];
      }
      if (members.length === 0) return [];

      const readShells = (location: "active" | "archive") =>
        projections
          .getShellSnapshot({ location })
          .pipe(Effect.mapError((cause) => failure("Could not read the other threads.", cause)));
      const others = [
        ...(yield* readShells("active")).threads,
        ...(yield* readShells("archive")).threads,
      ].filter((other) => other.id !== thread.id);
      for (const member of members) {
        const user = others.find((other) =>
          threadWorktreePaths(other).some((path) => isPathWithin(member.path, path)),
        );
        if (user !== undefined) {
          return yield* failure(`The worktree at ${member.path} is still used by "${user.title}".`);
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
      return ordered;
    },
  );

  return WorktreeSetService.of({ create, discard, recreateMissing, remove });
});

export const layer = Layer.effect(WorktreeSetService, make);
