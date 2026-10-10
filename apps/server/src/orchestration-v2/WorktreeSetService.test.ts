import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  GitCommandError,
  type OrchestrationV2ThreadWorktree,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as WorktreeSet from "./WorktreeSetService.ts";

const GitLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-set-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const threadId = ThreadId.make("thread:worktree-set");
const projectId = ProjectId.make("project:worktree-set");

interface ThreadRecord {
  readonly id: ThreadId;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly worktrees?: ReadonlyArray<OrchestrationV2ThreadWorktree>;
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "WorktreeSetService.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

/** A repository with one commit; `files` are committed relative to its root. */
const makeRepo = (name: string, files: ReadonlyArray<string> = ["README.md"]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const root = path.join(yield* fileSystem.makeTempDirectoryScoped({ prefix: "wts-" }), name);
    yield* fileSystem.makeDirectory(root, { recursive: true });
    yield* driver.initRepo({ cwd: root });
    yield* git(root, ["config", "user.email", "test@test.com"]);
    yield* git(root, ["config", "user.name", "Test"]);
    for (const file of files) {
      yield* fileSystem.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
      yield* fileSystem.writeFileString(path.join(root, file), `${file}\n`);
    }
    yield* git(root, ["add", "."]);
    yield* git(root, ["commit", "-m", "initial commit"]);
    return { root, branch: yield* git(root, ["branch", "--show-current"]) };
  });

/**
 * The coordinator over real git. GitWorkflowService only checks that a cwd is a
 * repository before routing these calls to the driver; `git` replaces calls to
 * inject failures.
 */
const withCoordinator = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input: {
    readonly projectRoot?: string;
    readonly thread?: ThreadRecord & { readonly deletedAt?: string };
    readonly activeThreads?: ReadonlyArray<ThreadRecord>;
    readonly archivedThreads?: ReadonlyArray<ThreadRecord>;
    readonly projects?: ReadonlyArray<{ readonly title: string; readonly workspaceRoot: string }>;
    readonly git?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
  } = {},
) =>
  effect.pipe(
    Effect.provide(
      WorktreeSet.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.unwrap(
              Effect.gen(function* () {
                const driver = yield* GitVcsDriver.GitVcsDriver;
                return Layer.mock(GitWorkflow.GitWorkflowService)({
                  remoteExists: driver.remoteExists,
                  fetchRemote: driver.fetchRemote,
                  remoteBranchExists: driver.remoteBranchExists,
                  resolveRemoteTrackingCommit: driver.resolveRemoteTrackingCommit,
                  createWorktree: driver.createWorktree,
                  removeWorktree: driver.removeWorktree,
                  pruneWorktrees: driver.pruneWorktrees,
                  deleteLocalBranch: driver.deleteLocalBranch,
                  ...input.git,
                });
              }),
            ),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeed(
                  input.projectRoot === undefined
                    ? Option.none()
                    : Option.some({ id: projectId, workspaceRoot: input.projectRoot } as never),
                ),
              listShells: () => Effect.succeed((input.projects ?? []) as never),
            }),
            // Shaped like the store: archived threads come in `archivedThreads`.
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: () => Effect.succeed({ projectId, ...input.thread } as never),
              getShellSnapshot: (options) =>
                Effect.succeed({
                  threads: options?.location === "archive" ? [] : (input.activeThreads ?? []),
                  archivedThreads:
                    options?.location === "active" ? [] : (input.archivedThreads ?? []),
                } as never),
            }),
          ),
        ),
      ),
    ),
  );

const noProgress: WorktreeSet.WorktreeSetProgress = {
  stage: () => Effect.void,
  checkoutPercent: () => Effect.void,
};

const branchExists = (cwd: string, branch: string) =>
  git(cwd, ["branch", "--list", branch]).pipe(Effect.map((listed) => listed !== ""));

it.effect("creates a one-member set exactly where a lone worktree lives", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repo = yield* makeRepo("app");
    const stages: Array<string> = [];

    const set = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
        worktreeSets.create(
          {
            cwd: repo.root,
            baseRef: repo.branch,
            branch: "feature/one",
            startFromOrigin: true,
          },
          {
            stage: (stage, status) => Effect.sync(() => void stages.push(`${stage}:${status}`)),
            checkoutPercent: () => Effect.void,
          },
        ),
      ),
    );

    const worktreePath = path.join(config.worktreesDir, "app", "feature-one");
    assert.deepEqual(set.members, [
      { repositoryRoot: repo.root, path: worktreePath, branch: "feature/one" },
    ]);
    assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "feature/one");
    // No origin remote: the fetch is skipped rather than failing the launch.
    assert.deepEqual(stages, ["fetch:skipped", "checkout:running", "checkout:done"]);
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("keeps a subfolder project's worktree at the worktree root", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repo = yield* makeRepo("monorepo", ["packages/app/index.ts"]);
    const projectRoot = path.join(repo.root, "packages", "app");

    const set = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
        worktreeSets.create(
          {
            cwd: projectRoot,
            baseRef: repo.branch,
            branch: "sub",
            startFromOrigin: false,
          },
          noProgress,
        ),
      ),
    );

    // Today's binding: the member is the worktree root, not the mapped subfolder.
    const worktreePath = path.join(config.worktreesDir, "app", "sub");
    assert.equal(set.members[0]?.path, worktreePath);
    assert.equal((yield* fileSystem.stat(path.join(worktreePath, ".git"))).type, "File");
    assert.isTrue(yield* fileSystem.exists(path.join(worktreePath, "packages", "app", "index.ts")));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("removes a claimed worktree and deletes its branch when creation then fails", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* makeRepo("app");
    let claimedPath: string | null = null;

    const error = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
        worktreeSets.create(
          {
            cwd: repo.root,
            baseRef: repo.branch,
            branch: "doomed",
            startFromOrigin: false,
          },
          noProgress,
        ),
      ).pipe(Effect.flip),
      {
        git: {
          createWorktree: (input, options) =>
            driver.createWorktree(input, options).pipe(
              Effect.tap((created) =>
                Effect.sync(() => {
                  claimedPath = created.worktree.path;
                }),
              ),
              Effect.andThen(
                Effect.fail(
                  new GitCommandError({
                    operation: "GitVcsDriver.createWorktree.configureBaseRef",
                    command: "git",
                    cwd: input.cwd,
                    detail: "could not lock config file",
                  }),
                ),
              ),
            ),
        },
      },
    );

    assert.equal(error.detail, "could not lock config file");
    assert.isNotNull(claimedPath);
    assert.isFalse(yield* fileSystem.exists(claimedPath!));
    assert.isFalse(yield* branchExists(repo.root, "doomed"));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("removes a claimed worktree and deletes its branch when creation is interrupted", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* makeRepo("app");
    const claimed = yield* Deferred.make<string>();

    yield* withCoordinator(
      Effect.gen(function* () {
        const worktreeSets = yield* WorktreeSet.WorktreeSetService;
        const fiber = yield* worktreeSets
          .create(
            {
              cwd: repo.root,
              baseRef: repo.branch,
              branch: "cancelled",
              startFromOrigin: false,
            },
            noProgress,
          )
          .pipe(Effect.forkChild);
        const claimedPath = yield* Deferred.await(claimed);
        yield* Fiber.interrupt(fiber);
        assert.isFalse(yield* fileSystem.exists(claimedPath));
        assert.isFalse(yield* branchExists(repo.root, "cancelled"));
      }),
      {
        git: {
          // Hangs after the claim, like a slow submodule checkout.
          createWorktree: (input, options) =>
            driver.createWorktree(input, options).pipe(
              Effect.flatMap((created) => Deferred.succeed(claimed, created.worktree.path)),
              Effect.andThen(Effect.never),
            ),
        },
      },
    );
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("removes a worktree whose checkout was interrupted before it was claimed", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repo = yield* makeRepo("app", ["a.txt", "b.txt", "c.txt"]);
    const checkingOut = yield* Deferred.make<void>();

    yield* withCoordinator(
      Effect.gen(function* () {
        const worktreeSets = yield* WorktreeSet.WorktreeSetService;
        const fiber = yield* worktreeSets
          .create(
            {
              cwd: repo.root,
              baseRef: repo.branch,
              branch: "mid-checkout",
              startFromOrigin: false,
            },
            {
              stage: () => Effect.void,
              // Fires from git's progress output, while `git worktree add` runs.
              checkoutPercent: () => Deferred.succeed(checkingOut, undefined).pipe(Effect.asVoid),
            },
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(checkingOut);
        yield* Fiber.interrupt(fiber);
      }),
    );

    assert.isFalse(yield* fileSystem.exists(path.join(config.worktreesDir, "app", "mid-checkout")));
    assert.isFalse(yield* branchExists(repo.root, "mid-checkout"));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

/** A parent repository's worktree with an independent repository's worktree nested inside. */
const makeNestedSet = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const parent = yield* makeRepo("parent");
  const child = yield* makeRepo("child");
  const sessionPath = path.join(yield* fileSystem.makeTempDirectoryScoped({ prefix: "wts-" }), "s");
  const parentMember = { repositoryRoot: parent.root, path: sessionPath, branch: "set-parent" };
  const childMember = {
    repositoryRoot: child.root,
    path: path.join(sessionPath, "child"),
    branch: "set-child",
  };
  for (const member of [parentMember, childMember]) {
    yield* driver.createWorktree({
      cwd: member.repositoryRoot,
      refName: member.repositoryRoot === parent.root ? parent.branch : child.branch,
      newRefName: member.branch,
      path: member.path,
    });
  }
  return { parentMember, childMember };
});

it.effect("recreates missing members parents first, each from its own checkout", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const { parentMember, childMember } = yield* makeNestedSet;
    yield* fileSystem.remove(parentMember.path, { recursive: true });

    yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
        worktreeSets.recreateMissing({
          id: threadId,
          projectId,
          branch: parentMember.branch,
          worktreePath: parentMember.path,
          // Listed child first: creating it first would leave the parent's
          // target non-empty, and git refuses that.
          worktrees: [childMember, parentMember],
        }),
      ),
      // The project's current root is never where a set member comes from.
      { projectRoot: "/not/a/repository" },
    );

    assert.equal(yield* git(parentMember.path, ["branch", "--show-current"]), "set-parent");
    assert.equal(yield* git(childMember.path, ["branch", "--show-current"]), "set-child");
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect(
  "recreates a plain thread's worktree from its project, and fails without its branch",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const repo = yield* makeRepo("app");
      const worktreePath = path.join(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "wts-" }),
        "w",
      );
      yield* driver.createWorktree({
        cwd: repo.root,
        refName: repo.branch,
        newRefName: "plain",
        path: worktreePath,
      });
      yield* fileSystem.remove(worktreePath, { recursive: true });
      const recreate = (branch: string) =>
        withCoordinator(
          Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
            worktreeSets.recreateMissing({ id: threadId, projectId, branch, worktreePath }),
          ),
          { projectRoot: repo.root },
        );

      yield* recreate("plain");
      assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "plain");

      yield* fileSystem.remove(worktreePath, { recursive: true });
      const error = yield* recreate("gone").pipe(Effect.flip);
      assert.equal(error._tag, "WorktreeRecreateError");
      assert.equal(error.path, worktreePath);
      assert.isFalse(yield* fileSystem.exists(worktreePath));
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("removes a deleted plain thread's worktree from its project and keeps the branch", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* makeRepo("app");
    const worktreePath = path.join(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "wts-" }),
      "w",
    );
    yield* driver.createWorktree({
      cwd: repo.root,
      refName: repo.branch,
      newRefName: "plain",
      path: worktreePath,
    });
    yield* fileSystem.writeFileString(path.join(worktreePath, "scratch.txt"), "unsaved\n");

    const removed = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
        worktreeSets.remove({ threadId, force: true }),
      ),
      {
        projectRoot: repo.root,
        thread: {
          id: threadId,
          title: "Deleted",
          branch: "plain",
          worktreePath,
          deletedAt: "2026-10-10T00:00:00.000Z",
        },
      },
    );

    assert.deepEqual(removed, [{ repositoryRoot: repo.root, path: worktreePath }]);
    assert.isFalse(yield* fileSystem.exists(worktreePath));
    assert.isTrue(yield* branchExists(repo.root, "plain"));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("removes no member while another thread still works inside one", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { parentMember, childMember } = yield* makeNestedSet;

    const error = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
        worktreeSets.remove({ threadId, force: true }),
      ).pipe(Effect.flip),
      {
        thread: {
          id: threadId,
          title: "Set",
          branch: parentMember.branch,
          worktreePath: parentMember.path,
          worktrees: [parentMember, childMember],
        },
        // Archived threads count: unarchiving one must find its worktree.
        archivedThreads: [
          {
            id: ThreadId.make("thread:other"),
            title: "Other",
            branch: childMember.branch,
            worktreePath: path.join(childMember.path, "src"),
          },
        ],
      },
    );

    assert.equal(error._tag, "VcsThreadWorktreesError");
    assert.include(error.message, '"Other"');
    assert.isTrue(yield* fileSystem.exists(parentMember.path));
    assert.isTrue(yield* fileSystem.exists(childMember.path));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("removes nothing while a project lives in one of its worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const { parentMember, childMember } = yield* makeNestedSet;

    const error = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
        worktreeSets.remove({ threadId, force: true }),
      ).pipe(Effect.flip),
      {
        thread: {
          id: threadId,
          title: "Set",
          branch: parentMember.branch,
          worktreePath: parentMember.path,
          worktrees: [parentMember, childMember],
        },
        // Its threads run in place, so they record no worktree.
        projects: [{ title: "Child checkout", workspaceRoot: childMember.path }],
      },
    );

    assert.equal(error._tag, "VcsThreadWorktreesError");
    assert.include(error.message, '"Child checkout"');
    assert.isTrue(yield* fileSystem.exists(childMember.path));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("removes nested members deepest first, each from its own checkout", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const { parentMember, childMember } = yield* makeNestedSet;

    // Without force, removing the parent first fails: the child's worktree is
    // untracked content inside it.
    const removed = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
        worktreeSets.remove({ threadId }),
      ),
      {
        projectRoot: "/not/a/repository",
        thread: {
          id: threadId,
          title: "Set",
          branch: parentMember.branch,
          worktreePath: parentMember.path,
          worktrees: [parentMember, childMember],
        },
      },
    );

    assert.deepEqual(
      removed.map((member) => member.path),
      [childMember.path, parentMember.path],
    );
    assert.isFalse(yield* fileSystem.exists(childMember.path));
    assert.isFalse(yield* fileSystem.exists(parentMember.path));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);
