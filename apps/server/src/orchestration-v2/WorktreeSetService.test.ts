import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  GitCommandError,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadWorkspaceFolder,
  type OrchestrationV2ThreadWorktree,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { allocateFolderLabels } from "@t3tools/shared/workspaceFolders";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceFolderResolver from "../project/WorkspaceFolderResolver.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorktreeSet from "./WorktreeSetService.ts";

const GitLayer = Layer.mergeAll(GitVcsDriver.layer, WorkspaceFolderResolver.layer).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-set-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const threadId = ThreadId.make("thread:worktree-set");
const projectId = ProjectId.make("project:worktree-set");
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

interface ThreadRecord {
  readonly id: ThreadId;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly worktrees?: ReadonlyArray<OrchestrationV2ThreadWorktree>;
  readonly workspaceFolders?: ReadonlyArray<OrchestrationV2ThreadWorkspaceFolder>;
  readonly createdAt?: DateTime.Utc;
}

type MetadataUpdate = Extract<OrchestrationV2Command, { readonly type: "thread.metadata.update" }>;

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
const makeRepo = (name: string, files: ReadonlyArray<string> = ["README.md"], parent?: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const root = path.join(
      parent ?? (yield* fileSystem.makeTempDirectoryScoped({ prefix: "wts-" })),
      name,
    );
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
    return {
      root: yield* fileSystem.realPath(root),
      branch: yield* git(root, ["branch", "--show-current"]),
    };
  });

/** A thread's folder snapshot of `folders`, probed as binding probes them. */
const snapshotOf = (folders: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const resolver = yield* WorkspaceFolderResolver.WorkspaceFolderResolver;
    const path = yield* Path.Path;
    const labelled = allocateFolderLabels(
      folders.map((folder) => ({ path: folder, name: path.basename(folder) })),
    );
    return yield* Effect.forEach(labelled, (folder) =>
      resolver.probe(folder.path!, { vcs: true }).pipe(
        Effect.map((probe): OrchestrationV2ThreadWorkspaceFolder => ({
          ...folder,
          ...(probe.vcs == null
            ? { checkoutRoot: null }
            : { checkoutRoot: probe.vcs.checkoutRoot, checkoutPrefix: probe.vcs.checkoutPrefix }),
        })),
      ),
    );
  });

/**
 * The coordinator over real git. GitWorkflowService only checks that a cwd is a
 * repository before routing these calls to the driver; `git` replaces calls to
 * inject failures. Bindings land in `dispatched`.
 */
const withCoordinator = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input: {
    readonly projectRoot?: string;
    readonly workspaceFile?: string;
    readonly thread?: ThreadRecord & { readonly deletedAt?: string };
    readonly threads?: ReadonlyArray<ThreadRecord>;
    readonly activeThreads?: ReadonlyArray<ThreadRecord>;
    readonly archivedThreads?: ReadonlyArray<ThreadRecord>;
    readonly projects?: ReadonlyArray<{
      readonly title: string;
      readonly workspaceRoot: string;
      readonly workspaceFile?: string;
      readonly folders?: ReadonlyArray<{ readonly path: string; readonly name: string }>;
    }>;
    readonly git?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
    readonly probe?: WorkspaceFolderResolver.WorkspaceFolderResolver["Service"]["probe"];
    readonly dispatched?: Array<MetadataUpdate>;
  } = {},
) =>
  effect.pipe(
    Effect.provide(
      WorktreeSet.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.unwrap(
              Effect.gen(function* () {
                const resolver = yield* WorkspaceFolderResolver.WorkspaceFolderResolver;
                return Layer.succeed(WorkspaceFolderResolver.WorkspaceFolderResolver, {
                  probe: input.probe ?? resolver.probe,
                });
              }),
            ),
            Layer.unwrap(
              Effect.gen(function* () {
                const driver = yield* GitVcsDriver.GitVcsDriver;
                return Layer.mock(GitWorkflow.GitWorkflowService)({
                  hasCommit: ({ cwd, refName }) =>
                    branchExists(cwd, refName.replace(/^refs\/heads\//, "")).pipe(
                      Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
                    ),
                  resolveWorktreeBaseRemote: driver.resolveWorktreeBaseRemote,
                  remoteExists: driver.remoteExists,
                  fetchRemote: driver.fetchRemote,
                  remoteBranchExists: driver.remoteBranchExists,
                  resolveRemoteTrackingCommit: driver.resolveRemoteTrackingCommit,
                  createWorktree: driver.createWorktree,
                  removeWorktree: driver.removeWorktree,
                  pruneWorktrees: driver.pruneWorktrees,
                  deleteLocalBranch: driver.deleteLocalBranch,
                  listLocalBranchNames: driver.listLocalBranchNames,
                  renameBranch: driver.renameBranch,
                  switchRef: (switchInput) => Effect.scoped(driver.switchRef(switchInput)),
                  invalidateLocalStatus: () => Effect.void,
                  localStatus: (statusInput) =>
                    driver.statusDetailsLocal(statusInput.cwd).pipe(
                      Effect.map(
                        (status) =>
                          ({
                            isRepo: status.isRepo,
                            refName: status.branch,
                            hasWorkingTreeChanges: status.hasWorkingTreeChanges,
                            workingTree: status.workingTree,
                          }) as never,
                      ),
                      Effect.orDie,
                    ),
                  ...input.git,
                });
              }),
            ),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeed(
                  input.projectRoot === undefined
                    ? Option.none()
                    : Option.some({
                        id: projectId,
                        workspaceRoot: input.projectRoot,
                        workspaceFile: input.workspaceFile ?? null,
                      } as never),
                ),
              listShells: () => Effect.succeed((input.projects ?? []) as never),
            }),
            // Shaped like the store: archived threads come in `archivedThreads`.
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: (id) =>
                Effect.succeed({
                  projectId,
                  deletedAt: null,
                  archivedAt: null,
                  ...(input.threads?.find((thread) => thread.id === id) ?? input.thread),
                } as never),
              getShellSnapshot: (options) =>
                Effect.succeed({
                  threads:
                    options?.location === "archive"
                      ? []
                      : (input.activeThreads ?? []).map((thread) => ({
                          projectId,
                          deletedAt: null,
                          ...thread,
                        })),
                  archivedThreads:
                    options?.location === "active" ? [] : (input.archivedThreads ?? []),
                } as never),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              dispatch: (command) =>
                Effect.sync(() => {
                  if (command.type === "thread.metadata.update") input.dispatched?.push(command);
                  return { sequence: 1, storedEvents: [] } as never;
                }),
            }),
          ),
        ),
      ),
    ),
  );

const noProgress = WorktreeSet.noWorktreeSetProgress;

it.effect(
  "recovers each missing member from its surviving branch or its own current checkout",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { api, web, workspaceFolders } = yield* makeSiblingWorkspace;
      const set = yield* withCoordinator(
        createSet({
          workspaceFolders: workspaceFolders.slice(0, 2),
          baseRef: api.branch,
          branch: "recover-members",
        }),
      );
      const first = set.members[0]!;
      const second = set.members[1]!;
      yield* fileSystem.writeFileString(path.join(first.path, "thread.txt"), "thread tip");
      yield* git(first.path, ["add", "."]);
      yield* git(first.path, ["commit", "-m", "thread tip"]);
      const firstTip = yield* git(first.path, ["rev-parse", "HEAD"]);
      yield* fileSystem.writeFileString(path.join(web.root, "current.txt"), "current checkout");
      yield* git(web.root, ["add", "."]);
      yield* git(web.root, ["commit", "-m", "current tip"]);
      const secondTip = yield* git(web.root, ["rev-parse", "HEAD"]);
      for (const member of set.members) yield* fileSystem.remove(member.path, { recursive: true });
      yield* git(web.root, ["worktree", "prune"]);
      yield* git(web.root, ["branch", "-D", second.branch]);
      yield* withCoordinator(
        Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
          coordinator.recreateMissing({
            id: threadId,
            projectId,
            ...WorktreeSet.worktreeSetBinding(set),
            workspaceFolders,
          }),
        ),
        { projectRoot: api.root },
      );
      assert.equal(yield* git(first.path, ["rev-parse", "HEAD"]), firstTip);
      assert.equal(yield* git(second.path, ["rev-parse", "HEAD"]), secondTip);
      assert.equal(yield* git(second.path, ["branch", "--show-current"]), second.branch);
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

const branchExists = (cwd: string, branch: string) =>
  git(cwd, ["branch", "--list", branch]).pipe(Effect.map((listed) => listed !== ""));

/** Plans and creates a set for a thread. */
const createSet = (input: {
  readonly workspaceFolders?: ReadonlyArray<OrchestrationV2ThreadWorkspaceFolder>;
  readonly projectRoot?: string;
  readonly baseRef: string;
  readonly branch: string;
  readonly startFromOrigin?: boolean;
  readonly progress?: WorktreeSet.WorktreeSetProgress;
}) =>
  Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
    worktreeSets
      .plan({
        thread: {
          id: threadId,
          ...(input.workspaceFolders === undefined
            ? {}
            : { workspaceFolders: input.workspaceFolders }),
        },
        projectRoot: input.projectRoot ?? input.workspaceFolders?.[0]?.path ?? "/unused",
        baseRef: input.baseRef,
        branch: input.branch,
        startFromOrigin: input.startFromOrigin ?? false,
      })
      .pipe(Effect.flatMap((plan) => worktreeSets.create(plan, input.progress ?? noProgress))),
  );

it.effect("creates a one-member set exactly where a lone worktree lives", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repo = yield* makeRepo("app");
    const stages: Array<string> = [];

    const set = yield* withCoordinator(
      createSet({
        projectRoot: repo.root,
        baseRef: repo.branch,
        branch: "feature/one",
        startFromOrigin: true,
        progress: {
          stage: (stage, status) => Effect.sync(() => void stages.push(`${stage}:${status}`)),
          checkout: () => Effect.void,
        },
      }),
    );

    const worktreePath = path.join(config.worktreesDir, "app", "feature-one");
    assert.deepEqual(set.members, [
      { repositoryRoot: repo.root, path: worktreePath, branch: "feature/one" },
    ]);
    assert.deepEqual(WorktreeSet.worktreeSetBinding(set), {
      branch: "feature/one",
      worktreePath,
    });
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
      createSet({ projectRoot, baseRef: repo.branch, branch: "sub" }),
    );

    // Today's binding: the member is the worktree root, not the mapped subfolder.
    const worktreePath = path.join(config.worktreesDir, "app", "sub");
    assert.equal(set.members[0]?.path, worktreePath);
    assert.equal(WorktreeSet.worktreeSetBinding(set).worktreePath, worktreePath);
    assert.equal((yield* fileSystem.stat(path.join(worktreePath, ".git"))).type, "File");
    assert.isTrue(yield* fileSystem.exists(path.join(worktreePath, "packages", "app", "index.ts")));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("maps every folder of one checkout into a single worktree", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repo = yield* makeRepo("mono", ["apps/web/index.ts", "apps/api/index.ts"]);
    const workspaceFolders = yield* snapshotOf([
      path.join(repo.root, "apps", "web"),
      path.join(repo.root, "apps", "api"),
    ]);

    const set = yield* withCoordinator(
      createSet({ workspaceFolders, baseRef: repo.branch, branch: "feature/mono" }),
    );

    const session = path.join(config.worktreesDir, "web", "feature-mono");
    assert.deepEqual(set.members, [
      { repositoryRoot: repo.root, path: session, branch: "feature/mono" },
    ]);
    // A linked project's thread works at its primary folder's place in the set.
    assert.deepEqual(WorktreeSet.worktreeSetBinding(set), {
      branch: "feature/mono",
      worktreePath: path.join(session, "apps", "web"),
      worktrees: set.members,
    });
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

/**
 * A parent repository holding an independent repository it ignores and a
 * submodule, each listed as a workspace folder.
 */
const makeNestedWorkspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = yield* makeRepo("parent", ["apps/web/index.ts"]);
  yield* fileSystem.writeFileString(path.join(parent.root, ".gitignore"), "libs/\n");
  yield* git(parent.root, ["add", ".gitignore"]);
  yield* git(parent.root, ["commit", "-m", "ignore nested repositories"]);
  const child = yield* makeRepo("child", ["src/index.ts"], path.join(parent.root, "libs"));
  const submodule = yield* makeRepo("vendored");
  yield* git(parent.root, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    submodule.root,
    "mods/vendored",
  ]);
  yield* git(parent.root, ["commit", "-m", "add submodule"]);
  return { parent, child, submodule };
});

it.effect(
  "nests an independent repository's worktree in its parent's and lets a submodule ride",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const { parent, child } = yield* makeNestedWorkspace;
      const workspaceFolders = yield* snapshotOf([
        path.join(parent.root, "apps", "web"),
        child.root,
        path.join(parent.root, "mods", "vendored"),
      ]);

      const set = yield* withCoordinator(
        createSet({ workspaceFolders, baseRef: parent.branch, branch: "feature/nested" }),
      );

      const session = path.join(config.worktreesDir, "web", "feature-nested");
      assert.deepEqual(set.members, [
        { repositoryRoot: parent.root, path: session, branch: "feature/nested" },
        {
          repositoryRoot: child.root,
          path: path.join(session, "libs", "child"),
          branch: "feature/nested",
        },
      ]);
      assert.equal(
        yield* git(path.join(session, "libs", "child"), ["branch", "--show-current"]),
        "feature/nested",
      );
      // The submodule isn't a member: its folder lies in the parent's worktree.
      assert.equal(
        WorktreeSet.worktreeSetBinding(set).worktreePath,
        path.join(session, "apps", "web"),
      );
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("makes a submodule its own member when its superproject isn't one", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const outer = yield* makeRepo("outer", ["README.md"]);
    yield* fileSystem.writeFileString(path.join(outer.root, ".gitignore"), "nested/\n");
    yield* git(outer.root, ["add", ".gitignore"]);
    yield* git(outer.root, ["commit", "-m", "ignore the nested repository"]);
    // An independent repository the outer one ignores, holding a submodule.
    const nested = yield* makeRepo("nested", ["README.md"], outer.root);
    const vendored = yield* makeRepo("vendored");
    yield* git(nested.root, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      vendored.root,
      "vendor",
    ]);
    yield* git(nested.root, ["commit", "-m", "add submodule"]);
    const vendor = yield* fileSystem.realPath(path.join(nested.root, "vendor"));
    const workspaceFolders = yield* snapshotOf([outer.root, vendor]);

    const set = yield* withCoordinator(
      createSet({ workspaceFolders, baseRef: outer.branch, branch: "feature/vendor" }),
    );

    const session = path.join(config.worktreesDir, "outer", "feature-vendor");
    assert.deepEqual(
      set.members.map((member) => [member.repositoryRoot, member.path]),
      [
        [outer.root, session],
        [vendor, path.join(session, "nested", "vendor")],
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("creates a primary nested inside another member after that member", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const { parent, child } = yield* makeNestedWorkspace;
    const workspaceFolders = yield* snapshotOf([child.root, parent.root]);
    const created: Array<string> = [];

    const set = yield* withCoordinator(
      createSet({ workspaceFolders, baseRef: child.branch, branch: "feature/inner" }),
      {
        git: {
          createWorktree: (input, options) =>
            driver
              .createWorktree(input, options)
              .pipe(Effect.tap(() => Effect.sync(() => void created.push(input.cwd)))),
        },
      },
    );

    const session = path.join(config.worktreesDir, "child", "feature-inner");
    // The primary's member comes first in the set, but its parent was created first.
    assert.deepEqual(
      set.members.map((member) => member.repositoryRoot),
      [child.root, parent.root],
    );
    assert.deepEqual(created, [parent.root, child.root]);
    assert.equal(
      WorktreeSet.worktreeSetBinding(set).worktreePath,
      path.join(session, "libs", "child"),
    );
    assert.equal(
      yield* git(path.join(session, "libs", "child"), ["branch", "--show-current"]),
      "feature/inner",
    );
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

/** Two sibling repositories, a second checkout of the first, and a snapshot of all three. */
const makeSiblingWorkspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "wts-" });
  const api = yield* makeRepo("api", ["README.md"], workspace);
  const web = yield* makeRepo("web", ["README.md"], workspace);
  const release = path.join(workspace, "api-release");
  yield* git(api.root, ["worktree", "add", "-b", "release", release]);
  const workspaceFolders = yield* snapshotOf([api.root, web.root, release]);
  return { api, web, release: yield* fileSystem.realPath(release), workspaceFolders };
});

it.effect("mirrors sibling repositories and names a second checkout of one repository apart", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const { api, web, release, workspaceFolders } = yield* makeSiblingWorkspace;

    const set = yield* withCoordinator(
      createSet({ workspaceFolders, baseRef: api.branch, branch: "feature/shared" }),
    );

    const session = path.join(config.worktreesDir, "api", "feature-shared");
    assert.deepEqual(set.members, [
      { repositoryRoot: api.root, path: path.join(session, "api"), branch: "feature/shared" },
      { repositoryRoot: web.root, path: path.join(session, "web"), branch: "feature/shared" },
      {
        repositoryRoot: release,
        path: path.join(session, "api-release"),
        branch: "feature/shared-api-release",
      },
    ]);
    // The second checkout started from what it had checked out.
    assert.equal(
      yield* git(path.join(session, "api-release"), ["rev-parse", "HEAD"]),
      yield* git(release, ["rev-parse", "HEAD"]),
    );
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("fails before creating anything when a name is taken in any member", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const { api, web, workspaceFolders } = yield* makeSiblingWorkspace;
    yield* git(web.root, ["branch", "feature/taken"]);

    const error = yield* withCoordinator(
      createSet({ workspaceFolders, baseRef: api.branch, branch: "feature/taken" }),
    ).pipe(Effect.flip);

    assert.equal(error._tag, "VcsThreadWorktreesError");
    assert.include(error.message, web.root);
    assert.isFalse(
      yield* fileSystem.exists(path.join(config.worktreesDir, "api", "feature-taken")),
    );
    assert.isFalse(yield* branchExists(api.root, "feature/taken"));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("removes the members it created and their branches when a later one fails", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const { api, web, workspaceFolders } = yield* makeSiblingWorkspace;

    const error = yield* withCoordinator(
      createSet({ workspaceFolders, baseRef: api.branch, branch: "feature/doomed" }),
      {
        git: {
          createWorktree: (input, options) =>
            input.cwd === web.root
              ? Effect.fail(
                  new GitCommandError({
                    operation: "GitVcsDriver.createWorktree",
                    command: "git",
                    cwd: input.cwd,
                    detail: "disk full",
                  }),
                )
              : driver.createWorktree(input, options),
        },
      },
    ).pipe(Effect.flip);

    assert.equal(error.detail, "disk full");
    const session = path.join(config.worktreesDir, "api", "feature-doomed");
    assert.isFalse(yield* fileSystem.exists(path.join(session, "api")));
    assert.isFalse(yield* branchExists(api.root, "feature/doomed"));
    assert.isFalse(yield* branchExists(web.root, "feature/doomed"));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("renames every member together, and reverts them all when one rename fails", () =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const { api, web, release, workspaceFolders } = yield* makeSiblingWorkspace;
    const set = yield* withCoordinator(
      createSet({ workspaceFolders, baseRef: api.branch, branch: "t3code/abcd1234" }),
    );
    const branchesOf = (renamed: WorktreeSet.WorktreeSet) =>
      Effect.forEach(renamed.members, (member) => git(member.path, ["branch", "--show-current"]));
    const rename = (failIn?: string) =>
      withCoordinator(
        Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
          worktreeSets.renameBranch(set, { branch: "feature/login", exactName: false }),
        ),
        {
          git: {
            renameBranch: (input) =>
              input.cwd === failIn && input.newBranch !== input.oldBranch
                ? Effect.fail(
                    new GitCommandError({
                      operation: "GitVcsDriver.renameBranch",
                      command: "git",
                      cwd: input.cwd,
                      detail: "rename refused",
                    }),
                  )
                : driver.renameBranch(input),
          },
        },
      );

    // The web member fails after the api member was renamed.
    yield* rename(set.members[1]!.path).pipe(Effect.flip);
    assert.deepEqual(yield* branchesOf(set), [
      "t3code/abcd1234",
      "t3code/abcd1234",
      "t3code/abcd1234-api-release",
    ]);

    // Taken in one repository, so the whole set moves to the next free name.
    yield* git(web.root, ["branch", "feature/login"]);
    const renamed = yield* rename();
    assert.deepEqual(
      renamed.members.map((member) => member.branch),
      ["feature/login-1", "feature/login-1", "feature/login-1-api-release"],
    );
    assert.deepEqual(yield* branchesOf(renamed), [
      "feature/login-1",
      "feature/login-1",
      "feature/login-1-api-release",
    ]);
    assert.isTrue(yield* branchExists(api.root, "feature/login-1-api-release"));
    assert.equal(renamed.members[2]?.repositoryRoot, release);
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("removes a claimed worktree and deletes its branch when creation then fails", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* makeRepo("app");
    let claimedPath: string | null = null;

    const error = yield* withCoordinator(
      createSet({ projectRoot: repo.root, baseRef: repo.branch, branch: "doomed" }),
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
    ).pipe(Effect.flip);

    assert.equal(error.detail, "could not lock config file");
    assert.isNotNull(claimedPath);
    assert.isFalse(yield* fileSystem.exists(claimedPath!));
    assert.isFalse(yield* branchExists(repo.root, "doomed"));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("deletes the branch a failed add made before it could claim the worktree", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const repo = yield* makeRepo("app");
    // Something else took the place after the plan checked it.
    const place = path.join(config.worktreesDir, "app", "late");

    const error = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
        worktreeSets
          .plan({
            thread: { id: threadId },
            projectRoot: repo.root,
            baseRef: repo.branch,
            branch: "late",
            startFromOrigin: false,
          })
          .pipe(
            Effect.tap(() =>
              fileSystem
                .makeDirectory(place, { recursive: true })
                .pipe(Effect.andThen(fileSystem.writeFileString(path.join(place, "x"), "x"))),
            ),
            Effect.flatMap((plan) => worktreeSets.create(plan, noProgress)),
          ),
      ),
    ).pipe(Effect.flip);

    assert.equal(error._tag, "GitCommandError");
    assert.isFalse(yield* branchExists(repo.root, "late"));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("keeps a branch with work that appeared after the plan when the add fails", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* makeRepo("app");
    const elsewhere = path.join(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "wts-" }),
      "elsewhere",
    );

    const error = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
        worktreeSets
          .plan({
            thread: { id: threadId },
            projectRoot: repo.root,
            baseRef: repo.branch,
            branch: "raced",
            startFromOrigin: false,
          })
          .pipe(
            // Another operation takes the name and commits on it meanwhile.
            Effect.tap(() =>
              Effect.gen(function* () {
                yield* git(repo.root, ["worktree", "add", "-b", "raced", elsewhere]);
                yield* fileSystem.writeFileString(path.join(elsewhere, "work.txt"), "work\n");
                yield* git(elsewhere, ["add", "."]);
                yield* git(elsewhere, ["commit", "-m", "work"]);
                yield* git(repo.root, ["worktree", "remove", elsewhere]);
              }),
            ),
            Effect.flatMap((plan) => worktreeSets.create(plan, noProgress)),
          ),
      ),
    ).pipe(Effect.flip);

    assert.equal(error._tag, "GitCommandError");
    assert.isTrue(yield* branchExists(repo.root, "raced"));
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
        const fiber = yield* createSet({
          projectRoot: repo.root,
          baseRef: repo.branch,
          branch: "cancelled",
        }).pipe(Effect.forkChild);
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
        const fiber = yield* createSet({
          projectRoot: repo.root,
          baseRef: repo.branch,
          branch: "mid-checkout",
          progress: {
            stage: () => Effect.void,
            // Fires from git's progress output, while `git worktree add` runs.
            checkout: () => Deferred.succeed(checkingOut, undefined).pipe(Effect.asVoid),
          },
        }).pipe(Effect.forkChild);
        yield* Deferred.await(checkingOut);
        yield* Fiber.interrupt(fiber);
      }),
    );

    assert.isFalse(yield* fileSystem.exists(path.join(config.worktreesDir, "app", "mid-checkout")));
    assert.isFalse(yield* branchExists(repo.root, "mid-checkout"));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("creates and binds a set for a thread that works in place", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const { api, web, workspaceFolders } = yield* makeSiblingWorkspace;
    const dispatched: Array<MetadataUpdate> = [];

    const binding = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
        worktreeSets.createForThread({ threadId, baseRef: api.branch, branch: "feature/later" }),
      ),
      {
        projectRoot: api.root,
        thread: {
          id: threadId,
          title: "In place",
          branch: null,
          worktreePath: null,
          workspaceFolders: workspaceFolders.slice(0, 2),
        },
        dispatched,
      },
    );

    const session = path.join(config.worktreesDir, "api", "feature-later");
    const worktrees = [
      { repositoryRoot: api.root, path: path.join(session, "api"), branch: "feature/later" },
      { repositoryRoot: web.root, path: path.join(session, "web"), branch: "feature/later" },
    ];
    assert.deepEqual(binding, {
      branch: "feature/later",
      worktreePath: path.join(session, "api"),
      worktrees,
    });
    assert.equal(dispatched.length, 1);
    assert.deepInclude(dispatched[0], {
      branch: "feature/later",
      worktreePath: path.join(session, "api"),
      worktrees,
      // A binding that landed meanwhile wins over this one.
      expectedWorktreePath: null,
    });
    assert.equal(
      yield* git(path.join(session, "web"), ["branch", "--show-current"]),
      "feature/later",
    );
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("switches a set's members to a branch, each under its own name, and records it", () =>
  Effect.gen(function* () {
    const { api, web, release, workspaceFolders } = yield* makeSiblingWorkspace;
    const set = yield* withCoordinator(
      createSet({ workspaceFolders, baseRef: api.branch, branch: "feature/one" }),
    );
    for (const [cwd, branch] of [
      [api.root, "feature/two"],
      [web.root, "feature/two"],
      [release, "feature/two-api-release"],
    ] as const) {
      yield* git(cwd, ["branch", branch]);
    }
    const binding = WorktreeSet.worktreeSetBinding(set);
    const thread = {
      id: threadId,
      title: "Set",
      branch: binding.branch,
      worktreePath: binding.worktreePath,
      worktrees: set.members,
      workspaceFolders,
    };
    const switchTo = (branch: string, members?: ReadonlyArray<string>) => {
      const dispatched: Array<MetadataUpdate> = [];
      return withCoordinator(
        Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
          worktreeSets.switchBranch({ threadId, branch, ...(members ? { members } : {}) }),
        ),
        { thread, dispatched },
      ).pipe(Effect.map((switched) => ({ switched, dispatched })));
    };
    const checkedOut = Effect.forEach(set.members, (member) =>
      git(member.path, ["branch", "--show-current"]),
    );

    const all = yield* switchTo("feature/two");
    assert.deepEqual(yield* checkedOut, ["feature/two", "feature/two", "feature/two-api-release"]);
    assert.deepEqual(
      all.dispatched[0]?.worktrees?.map((member) => member.branch),
      ["feature/two", "feature/two", "feature/two-api-release"],
    );
    assert.equal(all.dispatched[0]?.branch, "feature/two");

    // A writer that moved the thread meanwhile wins over the recorded branches.
    assert.equal(all.dispatched[0]?.expectedWorktreePath, binding.worktreePath);

    // Switching one repository back to the set's branch leaves the others.
    const back = yield* switchTo("feature/one", [web.root]);
    assert.deepEqual(
      back.switched.map((member) => member.repositoryRoot),
      [web.root],
    );
    assert.deepEqual(yield* checkedOut, ["feature/two", "feature/one", "feature/two-api-release"]);

    // "Switch back" may also name the member's own expected branch.
    yield* git(set.members[2]!.path, ["checkout", "-b", "drifted"]);
    yield* switchTo("feature/one-api-release", [release]);
    assert.equal(
      yield* git(set.members[2]!.path, ["branch", "--show-current"]),
      "feature/one-api-release",
    );
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect(
  "refreshes both a switched member root and its frozen folder cwd, leaving other members alone",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const api = yield* makeRepo("api", ["service/README.md"]);
      const web = yield* makeRepo("web");
      const workspaceFolders = yield* snapshotOf([path.join(api.root, "service"), web.root]);
      const set = yield* withCoordinator(
        createSet({ workspaceFolders, baseRef: api.branch, branch: "feature" }),
      );
      const binding = WorktreeSet.worktreeSetBinding(set);
      yield* git(api.root, ["branch", "other"]);
      const refreshed: Array<string> = [];
      yield* withCoordinator(
        Effect.flatMap(WorktreeSet.WorktreeSetService, (service) =>
          service.switchBranch(
            { threadId, branch: "other", members: [api.root] },
            {
              onSwitched: (cwd) =>
                Effect.sync(() => {
                  refreshed.push(cwd);
                }),
            },
          ),
        ),
        {
          thread: { id: threadId, title: "Set", ...binding, workspaceFolders },
        },
      );
      assert.deepEqual(
        refreshed.toSorted(),
        [set.members[0]!.path, path.join(set.members[0]!.path, "service")].toSorted(),
      );
      assert.equal(yield* git(set.members[0]!.path, ["branch", "--show-current"]), "other");
      assert.equal(yield* git(set.members[1]!.path, ["branch", "--show-current"]), "feature");
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("reuses the set of the newest thread whose primary works in a worktree", () =>
  Effect.gen(function* () {
    const folders = [{ path: "/repo", name: "repo", label: "repo", checkoutRoot: "/repo" }];
    const older = {
      id: ThreadId.make("thread:older"),
      title: "Older",
      branch: "a",
      worktreePath: "/wt/s",
      worktrees: [{ repositoryRoot: "/repo", path: "/wt/s", branch: "a" }],
      workspaceFolders: folders,
      createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
    };
    const newer = {
      ...older,
      id: ThreadId.make("thread:newer"),
      branch: "b",
      worktrees: [{ repositoryRoot: "/repo", path: "/wt/s", branch: "b" }],
      createdAt: DateTime.makeUnsafe("2026-10-02T00:00:00.000Z"),
    };
    const resolve = (worktreePath: string) =>
      withCoordinator(
        Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
          worktreeSets.resolveForReuse({ projectId, worktreePath }),
        ),
        { activeThreads: [older, newer], threads: [older, newer] },
      );

    assert.deepEqual(Option.getOrUndefined(yield* resolve("/wt/s"))?.worktrees, newer.worktrees);
    assert.isTrue(Option.isNone(yield* resolve("/wt/elsewhere")));
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
  "recreates a plain thread's worktree and falls back to its project's current branch",
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
      yield* recreate("gone");
      assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "gone");
      assert.equal(
        yield* git(worktreePath, ["rev-parse", "HEAD"]),
        yield* git(repo.root, ["rev-parse", "HEAD"]),
      );

      yield* fileSystem.remove(worktreePath, { recursive: true });
      yield* git(repo.root, ["switch", "--detach"]);
      const error = yield* recreate("missing-on-detached-head").pipe(Effect.flip);
      assert.equal(error._tag, "WorktreeRecreateError");
      assert.equal(error.path, worktreePath);
      assert.isFalse(yield* fileSystem.exists(worktreePath));
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect(
  "recreates a snapshot thread's worktree from its own primary folder, not its project",
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
        newRefName: "frozen",
        path: worktreePath,
      });
      yield* fileSystem.remove(worktreePath, { recursive: true });

      yield* withCoordinator(
        Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
          worktreeSets.recreateMissing({
            id: threadId,
            projectId,
            branch: "frozen",
            worktreePath,
            workspaceFolders: [{ path: repo.root, name: "app", label: "app", checkoutRoot: null }],
          }),
        ),
        // A relink may have moved the project's primary elsewhere.
        { projectRoot: "/not/a/repository" },
      );

      assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "frozen");
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

    // So do a linked project's other folders.
    const linked = yield* withCoordinator(
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
        projects: [
          {
            title: "Workspace",
            workspaceRoot: "/elsewhere",
            folders: [
              { path: "/elsewhere", name: "elsewhere" },
              { path: childMember.path, name: "child" },
            ],
          },
        ],
      },
    );
    assert.include(linked.message, '"Workspace"');
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

it.effect("removes no member without force while any member has changes", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { api, workspaceFolders } = yield* makeSiblingWorkspace;
    const set = yield* withCoordinator(
      createSet({
        workspaceFolders: workspaceFolders.slice(0, 2),
        baseRef: api.branch,
        branch: "dirty",
      }),
    );
    yield* fileSystem.writeFileString(path.join(set.members[1]!.path, "draft.txt"), "draft\n");

    const error = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
        worktreeSets.remove({ threadId }),
      ).pipe(Effect.flip),
      {
        thread: {
          id: threadId,
          title: "Set",
          branch: "dirty",
          worktreePath: set.members[0]!.path,
          worktrees: set.members,
        },
      },
    );

    assert.equal(error._tag, "VcsThreadWorktreesError");
    assert.include(error.message, set.members[1]!.path);
    for (const member of set.members) assert.isTrue(yield* fileSystem.exists(member.path));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("writes and rewrites the frozen folders in workspace order at their worktree paths", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const { api, web, workspaceFolders } = yield* makeSiblingWorkspace;
    const shared = yield* fileSystem.makeTempDirectoryScoped({ prefix: "shared-" });
    const missing = path.join(shared, "missing");
    const snapshot = [
      { ...workspaceFolders[0]!, name: 'API "core"' },
      { ...workspaceFolders[1]!, name: "Web app" },
      { path: shared, name: "Shared", label: "Shared", checkoutRoot: null },
      { path: missing, name: "Missing", label: "Missing", checkoutRoot: null },
      { uri: "vscode-remote://ssh-remote+devbox/team", name: "Remote", label: "Remote" },
    ];
    const set = yield* withCoordinator(
      createSet({ workspaceFolders: snapshot, baseRef: api.branch, branch: "editor" }),
    );
    const thread = {
      id: threadId,
      title: "Set",
      ...WorktreeSet.worktreeSetBinding(set),
      workspaceFolders: snapshot,
    };
    const open = withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
        coordinator.editorWorkspaceFile(threadId),
      ),
      {
        thread,
        projectRoot: path.join(shared, "different-primary-after-relink"),
      },
    );
    const target = yield* open;
    assert.equal(target, path.join(config.worktreesDir, "api", "editor", "editor.code-workspace"));
    const expected = {
      folders: [
        { name: 'API "core"', path: set.members[0]!.path },
        { name: "Web app", path: set.members[1]!.path },
        { name: "Shared", path: shared },
        { name: "Missing", path: missing },
        { name: "Remote", uri: "vscode-remote://ssh-remote+devbox/team" },
      ],
    };
    assert.deepEqual(decodeJson(yield* fileSystem.readFileString(target)), expected);
    yield* fileSystem.writeFileString(target, "stale");
    assert.equal(yield* open, target);
    assert.deepEqual(decodeJson(yield* fileSystem.readFileString(target)), expected);
    assert.equal(yield* git(api.root, ["status", "--porcelain"]), "");
    assert.equal(yield* git(set.members[0]!.path, ["status", "--porcelain"]), "");
    assert.equal(yield* git(set.members[1]!.path, ["status", "--porcelain"]), "");
    assert.equal(yield* git(web.root, ["status", "--porcelain"]), "");
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("puts a one-member workspace beside git and maps snapshot checkout prefixes", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* makeRepo("monorepo", ["apps/web/README.md", "packages/core/README.md"]);
    const snapshot = yield* snapshotOf([
      path.join(repo.root, "apps", "web"),
      path.join(repo.root, "packages", "core"),
    ]);
    const set = yield* withCoordinator(
      createSet({ workspaceFolders: snapshot, baseRef: repo.branch, branch: "one-editor" }),
    );
    const target = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
        coordinator.editorWorkspaceFile(threadId),
      ),
      {
        thread: {
          id: threadId,
          title: "Set",
          ...WorktreeSet.worktreeSetBinding(set),
          workspaceFolders: snapshot,
        },
      },
    );
    assert.equal(target, `${set.members[0]!.path}.code-workspace`);
    assert.deepEqual(decodeJson(yield* fileSystem.readFileString(target)), {
      folders: [
        { name: "web", path: path.join(set.members[0]!.path, "apps", "web") },
        { name: "core", path: path.join(set.members[0]!.path, "packages", "core") },
      ],
    });
    assert.equal(yield* git(set.members[0]!.path, ["status", "--porcelain"]), "");
    yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
        coordinator.remove({ threadId }),
      ),
      {
        thread: {
          id: threadId,
          title: "Set",
          ...WorktreeSet.worktreeSetBinding(set),
          workspaceFolders: snapshot,
        },
      },
    );
    assert.isFalse(yield* fileSystem.exists(target));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect(
  "uses the primary's chosen worktree without moving other folders when there is no tuple",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { api, workspaceFolders } = yield* makeSiblingWorkspace;
      const set = yield* withCoordinator(
        createSet({ projectRoot: api.root, baseRef: api.branch, branch: "chosen-editor" }),
      );
      const worktreePath = set.members[0]!.path;
      const target = yield* withCoordinator(
        Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
          coordinator.editorWorkspaceFile(threadId),
        ),
        {
          thread: {
            id: threadId,
            title: "Set",
            branch: "chosen-editor",
            worktreePath,
            workspaceFolders,
          },
        },
      );
      assert.equal(target, `${worktreePath}.code-workspace`);
      assert.deepEqual(decodeJson(yield* fileSystem.readFileString(target)), {
        folders: workspaceFolders.map((folder, index) => ({
          name: folder.name,
          path: index === 0 ? worktreePath : folder.path,
        })),
      });
      assert.equal(yield* git(worktreePath, ["status", "--porcelain"]), "");
      assert.equal(path.dirname(target), path.dirname(worktreePath));
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect(
  "generates and removes a picked subfolder worktree's file at the same checkout root",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* makeRepo("picked-subfolder", [
        "apps/web/index.ts",
        "packages/core/index.ts",
      ]);
      const snapshot = yield* snapshotOf([
        path.join(repo.root, "apps", "web"),
        path.join(repo.root, "packages", "core"),
      ]);
      const set = yield* withCoordinator(
        createSet({ projectRoot: repo.root, baseRef: repo.branch, branch: "picked-subfolder" }),
      );
      const root = set.members[0]!.path;
      const thread = {
        id: threadId,
        title: "Picked subfolder",
        branch: "picked-subfolder",
        worktreePath: path.join(root, "apps", "web"),
        workspaceFolders: snapshot,
      };
      const target = yield* withCoordinator(
        Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
          coordinator.editorWorkspaceFile(threadId),
        ),
        { thread, projectRoot: repo.root },
      );
      assert.equal(target, `${root}.code-workspace`);
      assert.deepEqual(decodeJson(yield* fileSystem.readFileString(target)), {
        folders: [
          { name: "web", path: thread.worktreePath },
          { name: "core", path: snapshot[1]!.path },
        ],
      });
      assert.equal(yield* git(root, ["status", "--porcelain"]), "");
      yield* withCoordinator(
        Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
          coordinator.remove({ threadId }),
        ),
        { thread, projectRoot: repo.root },
      );
      assert.isFalse(yield* fileSystem.exists(target));
      assert.isFalse(yield* fileSystem.exists(root));
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect(
  "uses the physical worktree root when a subfolder alias has a different lexical depth",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resolver = yield* WorkspaceFolderResolver.WorkspaceFolderResolver;
      const repo = yield* makeRepo("aliased-subfolder", ["apps/web/index.ts"]);
      const snapshot = yield* snapshotOf([path.join(repo.root, "apps", "web")]);
      const set = yield* withCoordinator(
        createSet({ projectRoot: repo.root, baseRef: repo.branch, branch: "alias" }),
      );
      const root = yield* fileSystem.realPath(set.members[0]!.path);
      const aliases = yield* fileSystem.makeTempDirectoryScoped({ prefix: "subfolder-alias-" });
      const alias = path.join(aliases, "web");
      // Model an OS subfolder symlink's resolver result without requiring
      // Windows symlink privileges; git still resolves the real worktree.
      const input = {
        projectRoot: repo.root,
        thread: {
          id: threadId,
          title: "Alias",
          branch: "alias",
          worktreePath: alias,
          workspaceFolders: snapshot,
        },
        probe: (cwd: string, options: { readonly vcs: boolean }) =>
          resolver.probe(cwd === alias ? path.join(root, "apps", "web") : cwd, options),
      };
      const target = yield* withCoordinator(
        Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
          coordinator.editorWorkspaceFile(threadId),
        ),
        input,
      );
      assert.equal(target, `${root}.code-workspace`);
      assert.isTrue(yield* fileSystem.exists(target));
      assert.equal(yield* git(root, ["status", "--porcelain"]), "");
      yield* withCoordinator(
        Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
          coordinator.remove({ threadId }),
        ),
        input,
      );
      assert.isFalse(yield* fileSystem.exists(root));
      assert.isFalse(yield* fileSystem.exists(target));
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("puts a nested set's workspace beside its parent member, outside both repositories", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const parent = yield* makeRepo("parent");
    const child = yield* makeRepo("child", ["README.md"], parent.root);
    const snapshot = yield* snapshotOf([child.root, parent.root]);
    const set = yield* withCoordinator(
      createSet({ workspaceFolders: snapshot, baseRef: child.branch, branch: "nested-editor" }),
    );
    const parentMember = set.members.find((member) => member.repositoryRoot === parent.root)!;
    const target = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
        coordinator.editorWorkspaceFile(threadId),
      ),
      {
        thread: {
          id: threadId,
          title: "Nested",
          ...WorktreeSet.worktreeSetBinding(set),
          workspaceFolders: snapshot,
        },
      },
    );
    assert.equal(target, `${parentMember.path}.code-workspace`);
    assert.deepEqual(decodeJson(yield* fileSystem.readFileString(target)), {
      folders: [
        { name: "child", path: set.members[0]!.path },
        { name: "parent", path: parentMember.path },
      ],
    });
    assert.notInclude(yield* git(parentMember.path, ["status", "--porcelain"]), ".code-workspace");
    assert.equal(yield* git(set.members[0]!.path, ["status", "--porcelain"]), "");
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("never overwrites the linked source file when a reused worktree collides with it", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* makeRepo("source-collision");
    const external = yield* fileSystem.makeTempDirectoryScoped({ prefix: "external-worktree-" });
    const worktreePath = path.join(external, "feature");
    yield* git(repo.root, ["worktree", "add", "-b", "feature", worktreePath]);
    const source = `${worktreePath}.code-workspace`;
    const original = '{"folders":[{"path":"./feature"}],"settings":{"editor.tabSize":4}}\n';
    yield* fileSystem.writeFileString(source, original);
    const snapshot = yield* snapshotOf([repo.root]);
    const result = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
        coordinator.editorWorkspaceFile(threadId),
      ),
      {
        projectRoot: repo.root,
        workspaceFile: source,
        thread: {
          id: threadId,
          title: "Reused",
          branch: "feature",
          worktreePath,
          workspaceFolders: snapshot,
        },
      },
    ).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure._tag, "VcsThreadWorktreesError");
      assert.include(result.failure.detail, "overwrite the linked source file");
    }
    assert.equal(yield* fileSystem.readFileString(source), original);
    assert.equal(yield* git(worktreePath, ["status", "--porcelain"]), "");
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("protects another linked project's source file at the generated target", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const repo = yield* makeRepo("other-project-source");
    const snapshot = yield* snapshotOf([repo.root]);
    const set = yield* withCoordinator(
      createSet({ workspaceFolders: snapshot, baseRef: repo.branch, branch: "other-source" }),
    );
    const source = `${set.members[0]!.path}.code-workspace`;
    const original = '{"folders":[{"path":"./other"}],"tasks":{"version":"2.0.0"}}\n';
    yield* fileSystem.writeFileString(source, original);
    const result = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
        coordinator.editorWorkspaceFile(threadId),
      ),
      {
        thread: {
          id: threadId,
          title: "Set",
          ...WorktreeSet.worktreeSetBinding(set),
          workspaceFolders: snapshot,
        },
        projects: [{ title: "Other project", workspaceRoot: repo.root, workspaceFile: source }],
      },
    ).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure._tag, "VcsThreadWorktreesError");
    assert.equal(yield* fileSystem.readFileString(source), original);
    yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
        coordinator.remove({ threadId }),
      ),
      {
        thread: {
          id: threadId,
          title: "Set",
          ...WorktreeSet.worktreeSetBinding(set),
          workspaceFolders: snapshot,
        },
        projects: [{ title: "Other project", workspaceRoot: repo.root, workspaceFile: source }],
      },
    );
    assert.equal(yield* fileSystem.readFileString(source), original);
    assert.isFalse(yield* fileSystem.exists(set.members[0]!.path));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("reports a workspace-file write failure without changing the worktree binding", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const repo = yield* makeRepo("write-error");
    const snapshot = yield* snapshotOf([repo.root]);
    const set = yield* withCoordinator(
      createSet({ workspaceFolders: snapshot, baseRef: repo.branch, branch: "editor-error" }),
    );
    const target = `${set.members[0]!.path}.code-workspace`;
    yield* fileSystem.makeDirectory(target);
    const dispatched: Array<MetadataUpdate> = [];
    const error = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
        coordinator.editorWorkspaceFile(threadId),
      ),
      {
        thread: {
          id: threadId,
          title: "Set",
          ...WorktreeSet.worktreeSetBinding(set),
          workspaceFolders: snapshot,
        },
        dispatched,
      },
    ).pipe(Effect.flip);
    assert.equal(error._tag, "VcsThreadWorktreesError");
    assert.include(error.detail, target);
    assert.isDefined(error.cause);
    assert.deepEqual(dispatched, []);
    assert.equal(yield* git(set.members[0]!.path, ["status", "--porcelain"]), "");
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("does not generate a workspace file for a current-checkout thread", () =>
  Effect.gen(function* () {
    const repo = yield* makeRepo("current");
    const workspaceFolders = yield* snapshotOf([repo.root]);
    const error = yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (coordinator) =>
        coordinator.editorWorkspaceFile(threadId),
      ),
      {
        thread: {
          id: threadId,
          title: "Current",
          branch: repo.branch,
          worktreePath: null,
          workspaceFolders,
        },
      },
    ).pipe(Effect.flip);
    assert.equal(error._tag, "VcsThreadWorktreesError");
    assert.equal(yield* git(repo.root, ["status", "--porcelain"]), "");
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect("removes a set's editor workspace file and its emptied session directory", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const { api, web, workspaceFolders } = yield* makeSiblingWorkspace;
    const set = yield* withCoordinator(
      createSet({
        workspaceFolders: workspaceFolders.slice(0, 2),
        baseRef: api.branch,
        branch: "done",
      }),
    );
    const session = path.join(config.worktreesDir, "api", "done");
    yield* fileSystem.writeFileString(path.join(session, "done.code-workspace"), "{}\n");

    yield* withCoordinator(
      Effect.flatMap(WorktreeSet.WorktreeSetService, (worktreeSets) =>
        worktreeSets.remove({ threadId }),
      ),
      {
        thread: {
          id: threadId,
          title: "Set",
          branch: "done",
          worktreePath: set.members[0]!.path,
          worktrees: set.members,
        },
      },
    );

    assert.isFalse(yield* fileSystem.exists(session));
    // The repositories and their branches stay.
    assert.isTrue(yield* branchExists(web.root, "done"));
  }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);

it.effect(
  "temporary names flatten independently in each checkout whose t3 branch blocks the namespace",
  () =>
    Effect.gen(function* () {
      const { api, web, workspaceFolders } = yield* makeSiblingWorkspace;
      yield* git(web.root, ["branch", "t3"]);
      const set = yield* withCoordinator(
        createSet({
          workspaceFolders: workspaceFolders.slice(0, 2),
          baseRef: api.branch,
          branch: "t3/abcdef12",
        }),
      );
      assert.deepEqual(
        set.members.map((member) => [member.repositoryRoot, member.branch]),
        [
          [api.root, "t3/abcdef12"],
          [web.root, "t3-abcdef12"],
        ],
      );
      assert.isTrue(yield* branchExists(api.root, "t3/abcdef12"));
      assert.isTrue(yield* branchExists(web.root, "t3-abcdef12"));
    }).pipe(Effect.scoped, Effect.provide(GitLayer)),
);
