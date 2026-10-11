import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ThreadWorkspaceFolder,
  VcsProcessExitError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:checkpoint-parts");
const runId = RunId.make("run:checkpoint-parts:1");
const nodeId = NodeId.make("node:checkpoint-parts:1");
const providerThreadId = ProviderThreadId.make("provider-thread:checkpoint-parts");
const createdAt = DateTime.makeUnsafe("2026-10-10T00:00:00.000Z");

const snapshotFolder = (
  path: string,
  label: string,
  checkoutRoot: string | null,
  checkoutPrefix = "",
): OrchestrationV2ThreadWorkspaceFolder => ({
  path,
  name: label,
  label,
  checkoutRoot,
  ...(checkoutRoot === null ? {} : { checkoutPrefix }),
});

const legacyScope = (cwd: string): OrchestrationV2CheckpointScope => ({
  id: CheckpointScopeId.make(`checkpoint-scope:lock:${cwd}`),
  threadId,
  runId,
  nodeId,
  parentScopeId: null,
  providerThreadId,
  kind: "root_run",
  ordinalWithinParent: 0,
  advancesAppRunCount: true,
  cwd,
  createdAt,
});

// Also provides the file system, for tests that need real directories.
const mockedService = (store: Partial<CheckpointStore.CheckpointStore["Service"]>) =>
  CheckpointService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        IdAllocator.layer,
        NodeServices.layer,
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(true),
          hasCheckpointRef: () => Effect.succeed(false),
          captureCheckpoint: () => Effect.void,
          ...store,
        }),
      ),
    ),
  );

it.effect.each([false, true, "interrupt"] as const)(
  "materializes baseline, lookup fails=%s",
  (lookupFails) => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
      threadId: ThreadId.make("thread:materialize-baseline"),
      runId: RunId.make("run:materialize-baseline:3"),
      nodeId: NodeId.make("node:materialize-baseline:3"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const hasCheckpointRef = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
      lookupFails === "interrupt"
        ? Effect.interrupt
        : lookupFails
          ? Effect.fail(
              new VcsProcessTimeoutError({
                operation: "test.ref",
                command: "git",
                cwd: "/repo",
                timeoutMs: 30000,
              }),
            )
          : Effect.succeed(true),
    );
    const testLayer = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          NodeServices.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef,
            captureCheckpoint: () => Effect.void,
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      if (lookupFails === "interrupt") {
        const exit = yield* Effect.exit(
          checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 2 }),
        );
        assert.isTrue(Exit.hasInterrupts(exit));
        const captureExit = yield* Effect.exit(
          checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          }),
        );
        assert.isTrue(Exit.hasInterrupts(captureExit));
        return;
      }
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 2,
      });

      assert.equal(baseline.ordinalWithinScope, 2);
      assert.equal(
        baseline.ref,
        CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 2,
        }),
      );
      assert.equal(baseline.status, lookupFails ? "missing" : "ready");
      assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
        cwd: scope.cwd,
        checkpointRef: baseline.ref,
      });
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect("keeps a single-folder thread's scope and checkpoint as they were", () =>
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    for (const thread of [
      { worktreePath: null },
      {
        worktreePath: null,
        workspaceFolders: [snapshotFolder("/repo/app", "app", "/repo", "app")],
      },
    ]) {
      const scope = yield* checkpoints.prepareRootRunScope({
        threadId,
        runId,
        rootNodeId: nodeId,
        providerThreadId,
        cwd: "/repo/app",
        thread,
        createdAt,
      });
      assert.equal(scope.cwd, "/repo/app");
      assert.isFalse("parts" in scope);

      const checkpoint = yield* checkpoints.capture({
        scope,
        runId,
        nodeId,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        capturedAt: createdAt,
      });
      assert.equal(checkpoint.status, "ready");
      assert.equal(
        checkpoint.ref,
        CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 1,
        }),
      );
      assert.isFalse("parts" in checkpoint);
    }
  }).pipe(Effect.provide(mockedService({}))),
);

it.effect("records each part's outcome and a barrier status without failing the run", () => {
  const captured: Array<CheckpointStore.CaptureCheckpointInput> = [];
  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const scope = yield* checkpoints.prepareRootRunScope({
      threadId,
      runId,
      rootNodeId: nodeId,
      providerThreadId,
      cwd: "/api",
      thread: {
        worktreePath: null,
        workspaceFolders: [
          snapshotFolder("/api", "api", "/api"),
          snapshotFolder("/broken", "broken", "/broken"),
          snapshotFolder("/moved", "moved", "/moved"),
          snapshotFolder("/notes", "notes", null),
        ],
      },
      createdAt,
    });

    const checkpoint = yield* checkpoints.capture({
      scope,
      runId,
      nodeId,
      ordinalWithinScope: 2,
      appRunOrdinal: 2,
      capturedAt: createdAt,
    });

    const partRef = (partKey: string) =>
      CheckpointService.checkpointRefForScopeOrdinal({
        scopeId: scope.id,
        ordinalWithinScope: 2,
        partKey,
      });
    const keys = scope.parts?.map((part) => part.key) ?? [];
    assert.equal(scope.cwd, "/api");
    assert.equal(checkpoint.status, "error");
    assert.equal(
      checkpoint.ref,
      CheckpointService.checkpointRefForScopeOrdinal({ scopeId: scope.id, ordinalWithinScope: 2 }),
    );
    assert.deepStrictEqual(
      checkpoint.parts?.map((part) => [part.key, part.status, part.ref, part.folders[0]?.label]),
      [
        ["primary", "ready", checkpoint.ref, "api"],
        [keys[1], "error", partRef(keys[1]!), "broken"],
        [keys[2], "missing", partRef(keys[2]!), "moved"],
        [keys[3], "missing", null, "notes"],
      ],
    );
    assert.deepStrictEqual(captured.map((input) => [input.cwd, input.pathspecs]).sort(), [
      ["/api", ["."]],
      ["/broken", ["."]],
    ]);
  }).pipe(
    Effect.provide(
      mockedService({
        isGitRepository: (cwd) => Effect.succeed(cwd !== "/moved"),
        captureCheckpoint: (input) =>
          Effect.suspend(() => {
            captured.push(input);
            return input.cwd === "/broken"
              ? Effect.fail(
                  new VcsProcessExitError({
                    operation: "test.capture",
                    command: "git add",
                    cwd: input.cwd,
                    exitCode: 128,
                    detail: "fatal: index.lock exists",
                  }),
                )
              : Effect.void;
          }),
      }),
    ),
  );
});

it.effect("holds one lock per checkout, however its path is spelled", () => {
  const log: Array<string> = [];
  const entered = new Map<string, Deferred.Deferred<void>>();
  const holdFirst = Deferred.makeUnsafe<void>();
  const directories = { first: "", other: "" };
  const label = (cwd: string) =>
    cwd === directories.first ? "first" : cwd === directories.other ? "other" : "same";
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    directories.first = yield* fileSystem.makeTempDirectoryScoped({ prefix: "checkpoint-lock-" });
    directories.other = yield* fileSystem.makeTempDirectoryScoped({ prefix: "checkpoint-lock-" });
    const sameCheckout = `${directories.first}${path.sep}..${path.sep}${path.basename(directories.first)}`;
    for (const cwd of [directories.first, directories.other, sameCheckout]) {
      entered.set(cwd, Deferred.makeUnsafe<void>());
    }
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const capture = (cwd: string) =>
      checkpoints.capture({
        scope: legacyScope(cwd),
        runId,
        nodeId,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        capturedAt: createdAt,
      });

    const first = yield* Effect.forkChild(capture(directories.first));
    yield* Deferred.await(entered.get(directories.first)!);
    const same = yield* Effect.forkChild(capture(sameCheckout));
    const other = yield* Effect.forkChild(capture(directories.other));
    // Another checkout captures while the first still holds its lock.
    yield* Deferred.await(entered.get(directories.other)!);
    yield* Deferred.succeed(holdFirst, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(same);
    yield* Fiber.join(other);

    assert.isAbove(log.indexOf("start same"), log.indexOf("end first"));
    assert.isBelow(log.indexOf("start other"), log.indexOf("end first"));
  }).pipe(
    Effect.provide(
      mockedService({
        captureCheckpoint: (input) =>
          Effect.gen(function* () {
            log.push(`start ${label(input.cwd)}`);
            yield* Deferred.succeed(entered.get(input.cwd)!, undefined);
            if (input.cwd === directories.first) yield* Deferred.await(holdFirst);
            log.push(`end ${label(input.cwd)}`);
          }),
      }),
    ),
  );
});

const multiFolderScope = Effect.gen(function* () {
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  return yield* checkpoints.prepareRootRunScope({
    threadId,
    runId,
    rootNodeId: nodeId,
    providerThreadId,
    cwd: "/api",
    thread: {
      worktreePath: null,
      workspaceFolders: [
        snapshotFolder("/api", "api", "/api"),
        snapshotFolder("/lib", "lib", "/lib"),
        snapshotFolder("/notes", "notes", null),
      ],
    },
    createdAt,
  });
});

it.effect("captures each missing part baseline, even when another part's fails", () => {
  const captured: Array<CheckpointStore.CaptureCheckpointInput> = [];
  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const scope = yield* multiFolderScope;
    const lib = scope.parts?.[1];

    const failure = yield* checkpoints
      .captureBaseline({ scope, ordinalWithinScope: 1 })
      .pipe(Effect.flip);

    assert.equal(failure._tag, "CheckpointBaselineCaptureError");
    // The api lookup failed; lib, which joined after turn 1, still got its baseline.
    assert.deepStrictEqual(captured, [
      {
        cwd: "/lib",
        checkpointRef: CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 1,
          partKey: lib!.key,
        }),
        pathspecs: ["."],
      },
    ]);
  }).pipe(
    Effect.provide(
      mockedService({
        hasCheckpointRef: ({ cwd }) =>
          cwd === "/api"
            ? Effect.fail(
                new VcsProcessTimeoutError({
                  operation: "test.ref",
                  command: "git",
                  cwd,
                  timeoutMs: 30000,
                }),
              )
            : Effect.succeed(false),
        captureCheckpoint: (input) => Effect.sync(() => void captured.push(input)),
      }),
    ),
  );
});

it.effect("deletes each part's stale refs in its own checkout, the primary's strictly", () => {
  const deleted: Array<CheckpointStore.DeleteCheckpointRefsInput> = [];
  const failAt = new Set<string>();
  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const scope = yield* multiFolderScope;
    const [api, lib, notes] = scope.parts ?? [];
    const stale = [1, 2].map((ordinal) => ({
      id: CheckpointId.make(`checkpoint:stale-${ordinal}`),
      threadId,
      scopeId: scope.id,
      runId,
      nodeId,
      parentCheckpointId: null,
      ordinalWithinScope: ordinal,
      appRunOrdinal: ordinal,
      ref: CheckpointRef.make(`ref:api-${ordinal}`),
      status: "ready" as const,
      files: [],
      parts: [
        { ...api!, ref: CheckpointRef.make(`ref:api-${ordinal}`), status: "ready" as const },
        // Captured where lib's worktree used to be; its current checkout is the scope's.
        {
          ...lib!,
          cwd: "/old/lib",
          ref: CheckpointRef.make(`ref:lib-${ordinal}`),
          status: "ready" as const,
        },
        { ...notes!, ref: null, status: "missing" as const },
        // A folder this scope no longer has keeps the checkout it was captured in.
        {
          key: "gone",
          cwd: "/gone",
          vcs: "git" as const,
          pathspecs: ["."],
          folders: [],
          ref: CheckpointRef.make(`ref:gone-${ordinal}`),
          status: "ready" as const,
        },
      ],
      capturedAt: createdAt,
    }));

    failAt.add("/gone");
    yield* checkpoints.deleteStaleRefs({ scope, checkpoints: stale });
    assert.deepStrictEqual(
      deleted.map((input) => `${input.cwd} ${input.checkpointRefs.join(" ")}`).sort(),
      ["/api ref:api-1 ref:api-2", "/gone ref:gone-1 ref:gone-2", "/lib ref:lib-1 ref:lib-2"],
    );

    failAt.add("/api");
    const failure = yield* checkpoints
      .deleteStaleRefs({ scope, checkpoints: stale })
      .pipe(Effect.flip);
    assert.equal(failure._tag, "CheckpointDeleteStaleRefsError");
  }).pipe(
    Effect.provide(
      mockedService({
        deleteCheckpointRefs: (input) =>
          Effect.suspend(() => {
            deleted.push(input);
            return failAt.has(input.cwd)
              ? Effect.fail(
                  new VcsProcessExitError({
                    operation: "test.delete",
                    command: "git update-ref",
                    cwd: input.cwd,
                    exitCode: 128,
                    detail: "not a git repository",
                  }),
                )
              : Effect.void;
          }),
      }),
    ),
  );
});

const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const GitServiceLayer = CheckpointService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      IdAllocator.layer,
      CheckpointStore.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer))),
      ),
    ),
  ),
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-checkpoint-parts-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(GitServiceLayer)("CheckpointService parts with git", (it) => {
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      const result = yield* process.run({
        operation: "CheckpointService.test.git",
        command: "git",
        cwd,
        args,
      });
      return result.stdout.trim();
    });

  it.effect(
    "captures each checkout's member folders, leaving nested checkouts to their parts",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "checkpoint-parts-" });
        const mono = path.join(root, "mono");
        const inner = path.join(mono, "a", "inner");
        const notes = path.join(root, "notes");
        const write = (file: string, contents: string) =>
          Effect.andThen(
            fileSystem.makeDirectory(path.dirname(file), { recursive: true }),
            fileSystem.writeFileString(file, contents),
          );
        const commitAll = (cwd: string) =>
          Effect.forEach(
            [
              ["init"],
              ["config", "user.email", "test@test.com"],
              ["config", "user.name", "Test"],
              ["add", "."],
              ["commit", "-m", "initial"],
            ],
            (args) => git(cwd, args),
            { discard: true },
          );
        for (const folder of ["a", "b", "c"]) {
          yield* write(path.join(mono, folder, "keep.txt"), `${folder}0`);
        }
        yield* write(path.join(mono, "a", "deep", "own.txt"), "deep0");
        yield* commitAll(mono);
        yield* write(path.join(inner, "x.txt"), "x0");
        yield* commitAll(inner);
        yield* write(path.join(notes, "n.txt"), "n0");
        const realMono = yield* fileSystem.realPath(mono);
        const realInner = yield* fileSystem.realPath(inner);

        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        const thread = {
          worktreePath: null,
          workspaceFolders: [
            snapshotFolder(path.join(mono, "a"), "a", realMono, "a"),
            snapshotFolder(path.join(mono, "b"), "b", realMono, "b"),
            snapshotFolder(path.join(mono, "a", "deep"), "deep", realMono, "a/deep"),
            snapshotFolder(inner, "inner", realInner),
            snapshotFolder(notes, "notes", null),
          ],
        };
        const scope = yield* checkpoints.prepareRootRunScope({
          threadId,
          runId,
          rootNodeId: nodeId,
          providerThreadId,
          cwd: path.join(mono, "a"),
          thread,
          createdAt,
        });
        yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
        yield* write(path.join(mono, "a", "keep.txt"), "a1");
        yield* write(path.join(mono, "b", "new.txt"), "b1");
        yield* write(path.join(mono, "a", "deep", "own.txt"), "deep1");
        yield* write(path.join(mono, "c", "keep.txt"), "c1");
        yield* write(path.join(inner, "x.txt"), "x1");
        yield* write(path.join(notes, "n.txt"), "n1");

        const checkpoint = yield* checkpoints.capture({
          scope,
          runId,
          nodeId,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          capturedAt: createdAt,
        });

        assert.equal(scope.cwd, realMono);
        assert.equal(checkpoint.status, "ready");
        assert.deepStrictEqual(
          checkpoint.parts?.map((part) => [part.cwd, part.vcs, part.status]),
          [
            [realMono, "git", "ready"],
            [realInner, "git", "ready"],
            [notes, null, "missing"],
          ],
        );
        // Member folders come from the worktree, everything else from HEAD.
        assert.equal(yield* git(realMono, ["show", `${checkpoint.ref}:a/keep.txt`]), "a1");
        assert.equal(yield* git(realMono, ["show", `${checkpoint.ref}:b/new.txt`]), "b1");
        assert.equal(yield* git(realMono, ["show", `${checkpoint.ref}:c/keep.txt`]), "c0");
        assert.equal(
          yield* git(realMono, ["ls-tree", "-r", "--name-only", checkpoint.ref, "--", "a/inner"]),
          "",
        );
        const innerPart = checkpoint.parts?.[1];
        assert.isTrue(innerPart?.ref?.endsWith(`/part-${innerPart.key}/ordinal/1`));
        assert.equal(yield* git(realInner, ["show", `${innerPart?.ref}:x.txt`]), "x1");
        assert.deepStrictEqual(
          checkpoint.files.map((file) => file.path),
          ["a/keep.txt", "b/new.txt", "deep/own.txt", "inner/x.txt"],
        );
        const query = yield* CheckpointDiffQuery.make.pipe(
          Effect.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getCheckpointContext: () =>
                Effect.succeed({
                  runs: [{ id: runId, ordinal: 1, status: "completed" }],
                  checkpointScopes: [scope],
                  checkpoints: [checkpoint],
                }),
            }),
          ),
        );
        const diff = yield* query.getFullThreadDiff({ threadId, toTurnCount: 1 });
        const headers = diff.diff.split("\n").filter((line) => line.startsWith("diff --git"));
        assert.deepStrictEqual(headers, [
          "diff --git a/a/keep.txt b/a/keep.txt",
          "diff --git a/b/new.txt b/b/new.txt",
          "diff --git a/deep/own.txt b/deep/own.txt",
          "diff --git a/inner/x.txt b/inner/x.txt",
        ]);

        // The nested member and checkout disappear after their first ready
        // checkpoints. Neither deletion belongs to the surviving parent.
        yield* fileSystem.remove(path.join(mono, "a", "deep"), { recursive: true });
        yield* fileSystem.remove(inner, { recursive: true });
        yield* write(path.join(mono, "a", "keep.txt"), "a2");
        const secondRunId = RunId.make("run:checkpoint-parts:2");
        const secondScope = yield* checkpoints.prepareRootRunScope({
          threadId,
          runId: secondRunId,
          rootNodeId: nodeId,
          providerThreadId,
          cwd: path.join(mono, "a"),
          thread,
          unavailableFolderPaths: [path.join(mono, "a", "deep"), inner],
          createdAt,
        });
        const second = yield* checkpoints.capture({
          scope: secondScope,
          runId: secondRunId,
          nodeId,
          ordinalWithinScope: 2,
          appRunOrdinal: 2,
          capturedAt: createdAt,
        });
        assert.deepStrictEqual(
          second.files.map((file) => file.path),
          ["a/keep.txt"],
        );
        const secondQuery = yield* CheckpointDiffQuery.make.pipe(
          Effect.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getCheckpointContext: () =>
                Effect.succeed({
                  runs: [
                    { id: runId, ordinal: 1, status: "completed" },
                    { id: secondRunId, ordinal: 2, status: "completed" },
                  ],
                  checkpointScopes: [secondScope],
                  checkpoints: [checkpoint, second],
                }),
            }),
          ),
        );
        const turn = yield* secondQuery.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2 });
        assert.deepStrictEqual(
          turn.diff.split("\n").filter((line) => line.startsWith("diff --git")),
          ["diff --git a/a/keep.txt b/a/keep.txt"],
        );
        const full = yield* secondQuery.getFullThreadDiff({ threadId, toTurnCount: 2 });
        assert.deepStrictEqual(
          full.diff.split("\n").filter((line) => line.startsWith("diff --git")),
          [
            "diff --git a/a/keep.txt b/a/keep.txt",
            "diff --git a/b/new.txt b/b/new.txt",
            "diff --git a/deep/own.txt b/deep/own.txt",
          ],
        );
      }),
  );
  it.effect("drops member folders git ignores or that vanished, instead of failing the part", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "checkpoint-ignored-" });
      const mono = path.join(root, "mono");
      const write = (file: string, contents: string) =>
        Effect.andThen(
          fileSystem.makeDirectory(path.dirname(file), { recursive: true }),
          fileSystem.writeFileString(file, contents),
        );
      const commitAll = (cwd: string) =>
        Effect.forEach(
          [
            ["init"],
            ["config", "user.email", "test@test.com"],
            ["config", "user.name", "Test"],
            ["add", "."],
            ["commit", "-m", "initial"],
          ],
          (args) => git(cwd, args),
          { discard: true },
        );
      yield* write(path.join(mono, ".gitignore"), "libs/child/\n.scratch/\n");
      yield* write(path.join(mono, "a", "keep.txt"), "a0");
      yield* write(path.join(mono, "libs", "readme.txt"), "l0");
      yield* commitAll(mono);
      // A nested repo the parent ignores, an ignored folder, and an untracked one.
      yield* write(path.join(mono, "libs", "child", "x.txt"), "x0");
      yield* commitAll(path.join(mono, "libs", "child"));
      yield* write(path.join(mono, ".scratch", "s.txt"), "s0");
      yield* write(path.join(mono, "gone", "g.txt"), "g0");
      const realMono = yield* fileSystem.realPath(mono);
      const realChild = yield* fileSystem.realPath(path.join(mono, "libs", "child"));
      const folder = (name: string, prefix: string) =>
        snapshotFolder(path.join(mono, ...prefix.split("/")), name, realMono, prefix);

      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const scope = yield* checkpoints.prepareRootRunScope({
        threadId,
        runId,
        rootNodeId: nodeId,
        providerThreadId,
        cwd: path.join(mono, "a"),
        thread: {
          worktreePath: null,
          workspaceFolders: [
            folder("a", "a"),
            folder("libs", "libs"),
            folder("scratch", ".scratch"),
            folder("gone", "gone"),
            snapshotFolder(path.join(mono, "libs", "child"), "child", realChild),
          ],
        },
        createdAt,
      });
      assert.deepStrictEqual(scope.parts?.[0]?.pathspecs, [
        ":(literal)a",
        ":(literal)libs",
        ":(literal).scratch",
        ":(literal)gone",
        ":(exclude,literal)libs/child",
      ]);
      yield* write(path.join(mono, "a", "keep.txt"), "a1");
      yield* write(path.join(mono, "libs", "readme.txt"), "l1");
      yield* fileSystem.remove(path.join(mono, "gone"), { recursive: true });

      const checkpoint = yield* checkpoints.capture({
        scope,
        runId,
        nodeId,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        capturedAt: createdAt,
      });

      assert.equal(checkpoint.status, "ready");
      assert.equal(yield* git(realMono, ["show", `${checkpoint.ref}:a/keep.txt`]), "a1");
      assert.equal(yield* git(realMono, ["show", `${checkpoint.ref}:libs/readme.txt`]), "l1");
      assert.equal(
        yield* git(realMono, [
          "ls-tree",
          "-r",
          "--name-only",
          checkpoint.ref,
          "--",
          ".scratch",
          "gone",
          "libs/child",
        ]),
        "",
      );
    }),
  );
});
