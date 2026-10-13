import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import {
  GitManagerError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VcsRepositoryDetectionError,
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as WorkspaceFolderResolver from "../project/WorkspaceFolderResolver.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

// What workspace actions read; tests of single-checkout methods never reach them.
const unusedWorkspaceDependencies = Layer.mergeAll(
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(WorkspaceFolderResolver.WorkspaceFolderResolver)({}),
);

function layer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provide(unusedWorkspaceDependencies),
  );
}

describe("GitWorkflowService", () => {
  it.effect("reports a non-Git VCS repository as not a Git repository", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const isRepository = yield* workflow.isRepository("/jj-repo");

      assert.equal(isRepository, false);
    }).pipe(
      Effect.provide(
        layer({
          detect: () =>
            Effect.succeed({
              kind: "jj",
              repository: {
                kind: "jj",
                rootPath: "/jj-repo",
                metadataPath: "/jj-repo/.jj",
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              },
              driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
            }),
        }),
      ),
    ),
  );

  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const layerTest = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
      Layer.provide(unusedWorkspaceDependencies),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provide(unusedWorkspaceDependencies),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});

const THREAD_ID = ThreadId.make("thread-workspace");
const PROJECT_ID = ProjectId.make("project-workspace");
const NOW = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");

const workspaceFolders = [
  { path: "/src/app", name: "app", label: "app", checkoutRoot: "/src/app" },
  { path: "/src/api", name: "api", label: "api", checkoutRoot: "/src/api" },
  { path: "/notes", name: "notes", label: "notes", checkoutRoot: null },
  { path: "/src/lib", name: "lib", label: "lib", checkoutRoot: "/src/lib" },
  { path: "/src/docs", name: "docs", label: "docs", checkoutRoot: "/src/docs" },
];

function workspaceThread(
  binding: Pick<OrchestrationV2AppThread, "worktreePath" | "worktrees">,
  folders: NonNullable<OrchestrationV2AppThread["workspaceFolders"]> = workspaceFolders,
): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Workspace thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: binding.worktrees?.[0]?.branch ?? null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    workspaceFolders: folders,
    ...binding,
  };
}

// A worktree set: lib's worktree is gone and docs checked out another branch.
const setThread = workspaceThread({
  worktreePath: "/wt/s/app",
  worktrees: ["app", "api", "lib", "docs"].map((name) => ({
    repositoryRoot: `/src/${name}`,
    path: `/wt/s/${name}`,
    branch: "feature",
  })),
});

function stackedResult(
  input: Pick<GitRunStackedActionInput, "action" | "commitMessage">,
  pr: GitRunStackedActionResult["pr"] = { status: "skipped_not_requested" },
): GitRunStackedActionResult {
  return {
    action: input.action,
    branch: { status: "skipped_not_requested" },
    commit:
      input.action === "commit"
        ? { status: "created", commitSha: "abc1234", subject: input.commitMessage ?? "Generated" }
        : { status: "skipped_not_requested" },
    push: { status: "skipped_not_requested" },
    pr,
    toast: { title: "Done", cta: { kind: "none" } },
  };
}

function makeWorkspaceLayer(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly branches?: Readonly<Record<string, string | null>>;
  readonly missing?: ReadonlyArray<string>;
  readonly branchReads?: Array<string>;
  readonly runStackedAction: GitManager.GitManager["Service"]["runStackedAction"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: ({ cwd }) =>
          Effect.succeed({
            kind: "git",
            repository: {
              kind: "git",
              rootPath: cwd,
              metadataPath: `${cwd}/.git`,
              freshness: { source: "live-local", observedAt: NOW, expiresAt: Option.none() },
            },
            driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        // `git symbolic-ref`: the branch, or exit 1 for a detached HEAD.
        execute: ({ cwd }) =>
          Effect.sync(() => {
            input.branchReads?.push(cwd);
            const branch = input.branches?.[cwd] ?? null;
            return {
              exitCode: ChildProcessSpawner.ExitCode(branch === null ? 1 : 0),
              stdout:
                branch === null
                  ? ""
                  : `${branch}
`,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitManager.GitManager)({ runStackedAction: input.runStackedAction })),
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThread: () => Effect.succeed(input.thread),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeedSome({
            projectId: PROJECT_ID,
            title: "Workspace",
            workspaceRoot: "/src/app",
            workspaceFile: "/src/workspace.code-workspace",
            folders: workspaceFolders.map(({ path, name }) => ({ path, name })),
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
            deletedAt: null,
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(WorkspaceFolderResolver.WorkspaceFolderResolver)({
        probe: (path) =>
          Effect.succeed(
            input.missing?.includes(path)
              ? { path, availability: "unavailable", unavailableReason: "missing" }
              : { path, availability: "available" },
          ),
      }),
    ),
  );
}

const byCwd = (left: { readonly cwd: string }, right: { readonly cwd: string }) =>
  left.cwd.localeCompare(right.cwd);

describe("GitWorkflowService.runWorkspaceAction", () => {
  it.effect(
    "commits each checkout on its own with one message, skipping drifted, unavailable and shared folders",
    () => {
      const calls: Array<GitRunStackedActionInput> = [];
      const progress: Array<GitActionProgressEvent> = [];
      const layer = makeWorkspaceLayer({
        thread: setThread,
        branches: { "/wt/s/app": "feature", "/wt/s/api": "feature", "/wt/s/docs": "main" },
        missing: ["/wt/s/lib"],
        runStackedAction: (input, options) =>
          Effect.gen(function* () {
            calls.push(input);
            yield* (
              options?.progressReporter?.publish({
                kind: "action_started",
                actionId: input.actionId,
                cwd: input.cwd,
                action: input.action,
                phases: ["commit"],
              }) ?? Effect.void
            );
            if (input.cwd === "/wt/s/api") {
              return yield* new GitManagerError({
                operation: "runStackedAction",
                cwd: input.cwd,
                detail: "The commit hook failed.",
              });
            }
            return stackedResult(input);
          }),
      });

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const { results } = yield* workflow.runWorkspaceAction(
          {
            actionId: "batch-1",
            threadId: THREAD_ID,
            action: "commit",
            commitMessage: "Ship the workspace",
          },
          {
            progressReporter: {
              publish: (event) => Effect.sync(() => void progress.push(event)),
            },
          },
        );

        expect(results).toEqual([
          {
            repositoryRoot: "/src/app",
            cwd: "/wt/s/app",
            label: "app",
            outcome: {
              _tag: "completed",
              result: stackedResult({ action: "commit", commitMessage: "Ship the workspace" }),
            },
          },
          {
            repositoryRoot: "/src/api",
            cwd: "/wt/s/api",
            label: "api",
            outcome: {
              _tag: "failed",
              message: "Git manager failed in runStackedAction: The commit hook failed.",
            },
          },
          {
            repositoryRoot: "/src/lib",
            cwd: "/wt/s/lib",
            label: "lib",
            outcome: { _tag: "unavailable", reason: "missing" },
          },
          {
            repositoryRoot: "/src/docs",
            cwd: "/wt/s/docs",
            label: "docs",
            outcome: { _tag: "drifted", refName: "main", expectedBranch: "feature" },
          },
        ]);
        expect(calls.toSorted(byCwd)).toEqual(
          ["/wt/s/api", "/wt/s/app"].map((cwd) => ({
            actionId: "batch-1",
            cwd,
            action: "commit",
            commitMessage: "Ship the workspace",
            threadId: THREAD_ID,
          })),
        );
        expect(progress.map((event) => event.cwd).toSorted()).toEqual(["/wt/s/api", "/wt/s/app"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("asks each checkout to open its pull request or create the missing one", () => {
    const calls: Array<GitRunStackedActionInput> = [];
    const layer = makeWorkspaceLayer({
      thread: workspaceThread(
        { worktreePath: "/wt/s/app", worktrees: setThread.worktrees!.slice(0, 2) },
        workspaceFolders.slice(0, 2),
      ),
      branches: { "/wt/s/app": "feature", "/wt/s/api": "feature" },
      runStackedAction: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return stackedResult(
            input,
            input.cwd === "/wt/s/app"
              ? { status: "opened_existing", number: 7, url: "https://github.com/acme/app/pull/7" }
              : { status: "created", number: 3, url: "https://github.com/acme/api/pull/3" },
          );
        }),
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const { results } = yield* workflow.runWorkspaceAction({
        actionId: "batch-2",
        threadId: THREAD_ID,
        action: "create-prs",
        commitMessage: "Not a commit",
      });

      expect(
        results.map(({ label, outcome }) => [
          label,
          outcome._tag === "completed" ? outcome.result.pr.status : outcome._tag,
        ]),
      ).toEqual([
        ["app", "opened_existing"],
        ["api", "created"],
      ]);
      expect(calls.map(({ action, commitMessage }) => [action, commitMessage])).toEqual([
        ["create_pr", undefined],
        ["create_pr", undefined],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("runs only the named repositories and rejects one the thread doesn't work in", () => {
    const calls: Array<string> = [];
    const layer = makeWorkspaceLayer({
      thread: setThread,
      branches: { "/wt/s/api": "feature" },
      runStackedAction: (input) =>
        Effect.sync(() => {
          calls.push(input.cwd);
          return stackedResult(input);
        }),
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const { results } = yield* workflow.runWorkspaceAction({
        actionId: "batch-3",
        threadId: THREAD_ID,
        action: "push",
        members: ["/src/api"],
      });
      expect(results.map((result) => result.repositoryRoot)).toEqual(["/src/api"]);
      expect(calls).toEqual(["/wt/s/api"]);

      const error = yield* workflow
        .runWorkspaceAction({
          actionId: "batch-4",
          threadId: THREAD_ID,
          action: "push",
          members: ["/src/elsewhere"],
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "VcsWorkspaceActionError",
        detail: "/src/elsewhere is not one of this thread's repositories.",
      });
      expect(calls).toEqual(["/wt/s/api"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("runs current-checkout repositories on their own branches, never as drift", () => {
    const calls: Array<string> = [];
    const branchReads: Array<string> = [];
    const layer = makeWorkspaceLayer({
      thread: workspaceThread({ worktreePath: null }),
      branches: { "/src/app": "main", "/src/api": "experiment" },
      branchReads,
      runStackedAction: (input) =>
        Effect.sync(() => {
          calls.push(input.cwd);
          return stackedResult(input);
        }),
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const { results } = yield* workflow.runWorkspaceAction({
        actionId: "batch-5",
        threadId: THREAD_ID,
        action: "push",
      });
      expect(results.map(({ label, outcome }) => [label, outcome._tag])).toEqual([
        ["app", "completed"],
        ["api", "completed"],
        ["lib", "completed"],
        ["docs", "completed"],
      ]);
      expect(calls.toSorted()).toEqual(["/src/api", "/src/app", "/src/docs", "/src/lib"]);
      expect(branchReads).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to commit every repository without one message", () => {
    const calls: Array<string> = [];
    const layer = makeWorkspaceLayer({
      thread: setThread,
      runStackedAction: (input) =>
        Effect.sync(() => {
          calls.push(input.cwd);
          return stackedResult(input);
        }),
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow
        .runWorkspaceAction({ actionId: "batch-6", threadId: THREAD_ID, action: "commit" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "VcsWorkspaceActionError",
        detail: "Committing every repository needs a message.",
      });
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "hands each success on before the rest finish and keeps a defect to its checkout",
    () => {
      const completed: Array<string> = [];
      const appHandedOn = Deferred.makeUnsafe<void>();
      const layer = makeWorkspaceLayer({
        thread: workspaceThread(
          { worktreePath: "/wt/s/app", worktrees: setThread.worktrees!.slice(0, 2) },
          workspaceFolders.slice(0, 2),
        ),
        branches: { "/wt/s/app": "feature", "/wt/s/api": "feature" },
        runStackedAction: (input) =>
          input.cwd === "/wt/s/app"
            ? Effect.succeed(stackedResult(input))
            : // api ends only once app's success was handed on, and then crashes.
              Deferred.await(appHandedOn).pipe(
                Effect.andThen(Effect.die(new Error("git crashed"))),
              ),
      });

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const { results } = yield* workflow.runWorkspaceAction(
          { actionId: "batch-7", threadId: THREAD_ID, action: "push" },
          {
            onCompleted: ({ cwd }) =>
              Effect.sync(() => void completed.push(cwd)).pipe(
                Effect.andThen(Deferred.succeed(appHandedOn, undefined)),
                Effect.asVoid,
              ),
          },
        );
        expect(completed).toEqual(["/wt/s/app"]);
        expect(results.map(({ label, outcome }) => [label, outcome])).toEqual([
          ["app", { _tag: "completed", result: stackedResult({ action: "push" }) }],
          ["api", { _tag: "failed", message: "git crashed" }],
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("runs at the top of a checkout whose first folder is gone", () => {
    const calls: Array<string> = [];
    const layer = makeWorkspaceLayer({
      thread: workspaceThread(
        { worktreePath: "/wt/s/app", worktrees: setThread.worktrees!.slice(0, 2) },
        [
          workspaceFolders[0]!,
          {
            path: "/src/api/pkg",
            name: "pkg",
            label: "pkg",
            checkoutRoot: "/src/api",
            checkoutPrefix: "pkg",
          },
        ],
      ),
      branches: { "/wt/s/app": "feature", "/wt/s/api": "feature" },
      missing: ["/wt/s/api/pkg"],
      runStackedAction: (input) =>
        Effect.sync(() => {
          calls.push(input.cwd);
          return stackedResult(input);
        }),
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const { results } = yield* workflow.runWorkspaceAction({
        actionId: "batch-8",
        threadId: THREAD_ID,
        action: "push",
      });
      expect(results.map(({ cwd, outcome }) => [cwd, outcome._tag])).toEqual([
        ["/wt/s/app", "completed"],
        ["/wt/s/api", "completed"],
      ]);
      expect(calls.toSorted()).toEqual(["/wt/s/api", "/wt/s/app"]);
    }).pipe(Effect.provide(layer));
  });
});
