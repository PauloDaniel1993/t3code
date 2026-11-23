import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  ProjectId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ThreadWorkspaceFolder,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- symlink fixtures require native lstat semantics.
import * as NodeFSP from "node:fs/promises";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";

const noTrackedFolders = Layer.mock(WorkspaceFolders.WorkspaceFolders)({
  forThread: () => Effect.succeed({ folders: [], extraRoots: [] }),
  submodules: () => Effect.succeed([]),
});
const layerNoTrackedFolders = Layer.merge(NodeServices.layer, noTrackedFolders);

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
        layerNoTrackedFolders,
        NodeCrypto.layer,
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(true),
          hasCheckpointRef: () => Effect.succeed(false),
          captureCheckpoint: () => Effect.void,
          listAuthoredPaths: () => Effect.succeed(null),
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
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          layerNoTrackedFolders,
          NodeCrypto.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef,
            captureCheckpoint: () => Effect.void,
            listAuthoredPaths: () => Effect.succeed(null),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );

    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      if (lookupFails === "interrupt") {
        const exit = yield* Effect.exit(
          checkpoints.materializeBaselineCheckpoint({
            scope,
            ordinalWithinScope: 2,
            nodeId: scope.nodeId,
            capturedAt: scope.createdAt,
          }),
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
        nodeId: scope.nodeId,
        capturedAt: scope.createdAt,
      });

      assert.equal(baseline.ordinalWithinScope, 2);
      assert.equal(
        baseline.ref,
        yield* CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 2,
        }),
      );
      assert.equal(baseline.status, lookupFails ? "error" : "ready");
      assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
        cwd: scope.cwd,
        checkpointRef: baseline.ref,
      });
    }).pipe(Effect.provide(layerTest));
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
        yield* CheckpointService.checkpointRefForScopeOrdinal({
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
      yield* CheckpointService.checkpointRefForScopeOrdinal({
        scopeId: scope.id,
        ordinalWithinScope: 2,
      }),
    );
    assert.deepStrictEqual(
      checkpoint.parts?.map((part) => [part.key, part.status, part.ref, part.folders[0]?.label]),
      [
        ["primary", "ready", checkpoint.ref, "api"],
        [keys[1], "error", yield* partRef(keys[1]!), "broken"],
        [keys[2], "missing", yield* partRef(keys[2]!), "moved"],
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

it.effect(
  "multi-root summaries exclude imported files while preserving folder-relative authored paths",
  () =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const scope = yield* checkpoints.prepareRootRunScope({
        threadId,
        runId,
        rootNodeId: nodeId,
        providerThreadId,
        cwd: "/repo/app",
        createdAt,
        thread: {
          worktreePath: null,
          workspaceFolders: [
            snapshotFolder("/repo/app", "app", "/repo", "app"),
            snapshotFolder("/lib", "lib", "/lib"),
          ],
        },
      });
      const checkpoint = yield* checkpoints.capture({
        scope,
        runId,
        nodeId,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        capturedAt: createdAt,
      });
      assert.deepEqual(
        checkpoint.files.map((file) => file.path),
        ["app/written.ts", "lib/written.ts"],
      );
      assert.equal(checkpoint.status, "ready");
    }).pipe(
      Effect.provide(
        mockedService({
          hasCheckpointRef: () => Effect.succeed(true),
          listAuthoredPaths: ({ cwd }) =>
            Effect.succeed(new Set([cwd === "/repo" ? "app/written.ts" : "written.ts"])),
          diffCheckpoints: () => Effect.succeed("1\t0\twritten.ts\x002\t0\timported.ts\0"),
        }),
      ),
    ),
);

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
        checkpointRef: yield* CheckpointService.checkpointRefForScopeOrdinal({
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
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-checkpoint-parts-test-" }),
  ),
  Layer.provideMerge(layerNoTrackedFolders),
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
        const alias = path.join(root, "deep-alias");
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
        const originalInnerBranch = yield* git(inner, ["branch", "--show-current"]);
        yield* git(inner, ["switch", "-c", "inner-alternate"]);
        yield* write(path.join(inner, "x.txt"), "x on alternate");
        yield* git(inner, ["commit", "-am", "Alternate checkout"]);
        yield* git(inner, ["switch", originalInnerBranch]);
        yield* write(path.join(notes, "n.txt"), "n0");
        const realMono = yield* fileSystem.realPath(mono);
        const realInner = yield* fileSystem.realPath(inner);
        // Junctions let this directory-alias case run without Windows symlink privileges.
        yield* Effect.promise(() =>
          NodeFSP.symlink(path.join(mono, "a", "deep"), alias, "junction"),
        );

        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        const thread = {
          worktreePath: null,
          workspaceFolders: [
            snapshotFolder(path.join(mono, "a"), "a", realMono, "a"),
            snapshotFolder(path.join(mono, "b"), "b", realMono, "b"),
            snapshotFolder(path.join(mono, "a", "deep"), "deep", realMono, "a/deep"),
            snapshotFolder(alias, "alias", realMono, "a/deep"),
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
        yield* git(inner, ["switch", "inner-alternate"]);
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
        assert.include(diff.diff, "-x on alternate");
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
          unavailableFolderPaths: [path.join(mono, "a", "deep"), alias, inner],
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
  it.effect("restores every part or names the folders it couldn't, leaving HEAD", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "checkpoint-restore-" });
      const write = (file: string, contents: string) =>
        Effect.andThen(
          fileSystem.makeDirectory(path.dirname(file), { recursive: true }),
          fileSystem.writeFileString(file, contents),
        );
      const repositories = ["app", "lib"].map((name) => path.join(root, name));
      for (const repository of repositories) {
        yield* write(path.join(repository, "file.txt"), "0");
        for (const args of [
          ["init"],
          ["config", "user.email", "test@test.com"],
          ["config", "user.name", "Test"],
          ["config", "core.autocrlf", "false"],
          ["add", "."],
          ["commit", "-m", "initial"],
        ]) {
          yield* git(repository, args);
        }
      }
      const [app, lib] = yield* Effect.forEach(repositories, (repository) =>
        fileSystem.realPath(repository),
      );
      const heads = yield* Effect.forEach([app!, lib!], (cwd) => git(cwd, ["rev-parse", "HEAD"]));
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const scope = yield* checkpoints.prepareRootRunScope({
        threadId,
        runId,
        rootNodeId: nodeId,
        providerThreadId,
        cwd: app!,
        thread: {
          worktreePath: null,
          workspaceFolders: [snapshotFolder(app!, "app", app!), snapshotFolder(lib!, "lib", lib!)],
        },
        createdAt,
      });
      const checkpoint = yield* checkpoints.capture({
        scope,
        runId,
        nodeId,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        capturedAt: createdAt,
      });
      const [appPart, libPart] = checkpoint.parts ?? [];
      const withLib = (part: Partial<NonNullable<typeof libPart>>) => ({
        ...checkpoint,
        parts: [appPart!, { ...libPart!, ...part }],
      });
      const edit = Effect.forEach(
        [app!, lib!],
        (cwd) =>
          Effect.andThen(
            write(path.join(cwd, "file.txt"), "1"),
            write(path.join(cwd, "new.txt"), "1"),
          ),
        { discard: true },
      );
      const assertRestored = (cwd: string, restored: boolean) =>
        Effect.gen(function* () {
          assert.equal(
            yield* fileSystem.readFileString(path.join(cwd, "file.txt")),
            restored ? "0" : "1",
          );
          assert.equal(yield* fileSystem.exists(path.join(cwd, "new.txt")), !restored);
        });

      assert.isUndefined(yield* checkpoints.preflightRestore({ scope, checkpoint }));
      assert.deepStrictEqual(
        yield* checkpoints.preflightRestore({
          scope,
          checkpoint: { ...withLib({ status: "error" }), status: "error" },
        }),
        { reason: "not-ready", folders: ["lib"] },
      );
      assert.deepStrictEqual(
        yield* checkpoints.preflightRestore({
          scope,
          checkpoint: withLib({ cwd: path.join(root, "moved") }),
        }),
        { reason: "missing-checkout", folders: ["lib"] },
      );
      const missingRef = withLib({ ref: CheckpointRef.make("refs/t3/checkpoints/missing") });
      assert.deepStrictEqual(
        yield* checkpoints.preflightRestore({ scope, checkpoint: missingRef }),
        {
          reason: "missing-ref",
          folders: ["lib"],
        },
      );

      // One part failing leaves the other restored, and says which is which.
      yield* edit;
      const failure = yield* checkpoints
        .restoreParts({ scope, checkpoint: missingRef })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "CheckpointRestoreError");
      if (failure._tag === "CheckpointRestoreError") {
        assert.deepStrictEqual(failure.restoredFolders, ["app"]);
        assert.deepStrictEqual(failure.unrestoredFolders, ["lib"]);
      }
      yield* assertRestored(app!, true);
      yield* assertRestored(lib!, false);

      // Restoring again converges.
      yield* checkpoints.restoreParts({ scope, checkpoint });
      yield* assertRestored(app!, true);
      yield* assertRestored(lib!, true);
      assert.deepStrictEqual(
        yield* Effect.forEach([app!, lib!], (cwd) => git(cwd, ["rev-parse", "HEAD"])),
        heads,
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

it.effect(
  "skips unsupported baseline and turn checkpoints without swallowing capture failures",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:capture-failure"),
        threadId: ThreadId.make("thread:capture-failure"),
        runId: RunId.make("run:capture-failure:1"),
        nodeId: NodeId.make("node:capture-failure:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:capture-failure"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/ignored",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      for (const captureError of [
        new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: scope.cwd,
          timeoutMs: 30000,
        }),
        new VcsUnsupportedOperationError({
          operation: "test.capture",
          kind: "git",
          detail: "The workspace directory is ignored by its Git repository.",
        }),
      ]) {
        const layerTest = CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              layerNoTrackedFolders,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        );
        yield* Effect.gen(function* () {
          const checkpoints = yield* CheckpointService.CheckpointServiceV2;
          const baseline = yield* Effect.result(
            checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
          );
          const checkpoint = yield* checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          });

          assert.deepEqual(
            { baseline: baseline._tag, turn: checkpoint.status, files: checkpoint.files },
            captureError._tag === "VcsUnsupportedOperationError"
              ? { baseline: "Success", turn: "missing", files: [] }
              : { baseline: "Failure", turn: "error", files: [] },
          );
          if (baseline._tag === "Failure") {
            assert.strictEqual(baseline.failure.cause, captureError);
          } else {
            const materialized = yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
              nodeId: scope.nodeId,
              capturedAt: scope.createdAt,
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);

it.effect.each(["legacy", "multipart"] as const)(
  "bounds a slow baseline snapshot but waits for an in-flight capture of the same ref (%s)",
  (layout) =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:slow-baseline"),
        threadId: ThreadId.make("thread:slow-baseline"),
        runId: RunId.make("run:slow-baseline:1"),
        nodeId: NodeId.make("node:slow-baseline:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:slow-baseline"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/slow",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
        ...(layout === "multipart"
          ? {
              parts: [
                {
                  key: "primary",
                  cwd: "/repo/slow",
                  vcs: "git" as const,
                  pathspecs: ["."],
                  folders: [],
                },
                {
                  key: "fast",
                  cwd: "/repo/fast",
                  vcs: "git" as const,
                  pathspecs: ["."],
                  folders: [],
                },
              ],
            }
          : {}),
      };
      const refs = yield* Ref.make<ReadonlySet<string>>(new Set());
      const snapshots = yield* Ref.make(0);
      const firstSnapshotStarted = yield* Deferred.make<void>();
      const baselineSnapshots = yield* Queue.unbounded<void>();
      const releaseBaselineSnapshot = yield* Deferred.make<void>();
      const releaseSnapshot = yield* Deferred.make<void>();
      const layerTest = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            noTrackedFolders,
            Path.layer,
            FileSystem.layerNoop({ realPath: (target) => Effect.succeed(target) }),
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: () => Effect.succeed(true),
              hasCheckpointRef: ({ checkpointRef }) =>
                Ref.get(refs).pipe(Effect.map((current) => current.has(checkpointRef))),
              captureCheckpoint: ({ cwd, checkpointRef }) =>
                cwd === "/repo/fast"
                  ? Ref.update(refs, (current) => new Set([...current, checkpointRef]))
                  : Effect.gen(function* () {
                      const count = yield* Ref.updateAndGet(snapshots, (count) => count + 1);
                      if (count === 1) {
                        yield* Deferred.succeed(firstSnapshotStarted, undefined);
                        yield* Deferred.await(releaseSnapshot);
                      } else {
                        yield* Queue.offer(baselineSnapshots, undefined);
                        yield* Deferred.await(releaseBaselineSnapshot);
                      }
                      yield* Ref.update(refs, (current) => new Set([...current, checkpointRef]));
                    }),
            }),
          ),
        ),
        Layer.provideMerge(NodeCrypto.layer),
      );

      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        // A stopped run's post-turn capture writes the next run's baseline ref while holding the lock.
        const postTurn = yield* checkpoints
          .capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstSnapshotStarted);
        const waitingBaseline = yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: 1 })
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        yield* Deferred.succeed(releaseSnapshot, undefined);
        assert.strictEqual((yield* Fiber.join(postTurn)).status, "ready");
        assert.strictEqual((yield* Fiber.join(waitingBaseline))._tag, "Success");

        for (const ordinalWithinScope of [2, 3]) {
          const slowBaseline = yield* checkpoints
            .captureBaseline({ scope, ordinalWithinScope })
            .pipe(Effect.result, Effect.forkChild);
          yield* Queue.take(baselineSnapshots);
          yield* TestClock.adjust("5 seconds");
          const result = yield* Fiber.join(slowBaseline);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.isTrue(Cause.isTimeoutError(result.failure.cause));
          }
        }
        const backedOffBaseline = yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: 4 })
          .pipe(Effect.result, Effect.forkChild);
        if (layout === "multipart") {
          yield* Queue.take(baselineSnapshots);
          yield* TestClock.adjust("5 seconds");
        }
        assert.strictEqual(
          (yield* Fiber.join(backedOffBaseline))._tag,
          layout === "multipart" ? "Failure" : "Success",
        );
        assert.strictEqual(yield* Ref.get(snapshots), layout === "multipart" ? 4 : 3);
        assert.strictEqual((yield* Ref.get(refs)).size, layout === "multipart" ? 5 : 1);
      }).pipe(Effect.provide(layerTest));
    }),
);

it.effect(
  "asks Git about a tracked repository once a turn and snapshots it only when changed",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:repositories"),
        threadId: ThreadId.make("thread:repositories"),
        runId: RunId.make("run:repositories:1"),
        nodeId: NodeId.make("node:repositories:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:repositories"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/wrapper",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      const thread = { projectId: ProjectId.make("project:repositories"), worktreePath: null };
      const repositories = Array.from({ length: 30 }, (_, index) => `/wrapper/repo-${index}`);
      const [slowRepository, changedRepository] = [repositories[7]!, repositories[3]!];
      const unreadableRepository = repositories[5]!;
      const startHead = "a".repeat(40);
      const heads = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const refs = yield* Ref.make<ReadonlySet<string>>(new Set());
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (call: string) => Ref.update(calls, (current) => [...current, call]);
      const slow = yield* Ref.make(true);
      const slowStarted = yield* Deferred.make<void>();
      const othersSeen = yield* Deferred.make<void>();
      const layerTest = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            NodeServices.layer,
            Layer.mock(WorkspaceFolders.WorkspaceFolders)({
              forThread: () =>
                Effect.succeed({
                  folders: [
                    ...repositories.map((path) => ({
                      name: path,
                      path,
                      isGitRepository: true,
                      // The first is a task folder's worktree of a tracked checkout elsewhere.
                      ...(path === repositories[0] ? { repositoryPath: "/tracked/repo-0" } : {}),
                    })),
                    { name: "notes", path: "/wrapper/notes", isGitRepository: false },
                  ],
                  extraRoots: [],
                }),
              submodules: () => Effect.succeed([]),
            }),
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: (cwd) => record(`probe ${cwd}`).pipe(Effect.as(cwd !== "/wrapper")),
              resolveCleanHead: (cwd) =>
                Effect.gen(function* () {
                  // One repository is too slow for the turn to wait on.
                  if (cwd === slowRepository && (yield* Ref.get(slow))) {
                    yield* Deferred.succeed(slowStarted, undefined);
                    yield* Effect.sleep("1 minute");
                  }
                  yield* record(`status ${cwd}`);
                  if ((yield* Ref.get(calls)).length === repositories.length - 1) {
                    yield* Deferred.succeed(othersSeen, undefined);
                  }
                  return (yield* Ref.get(heads)).get(cwd) ?? startHead;
                }),
              hasCheckpointRef: ({ checkpointRef }) =>
                Ref.get(refs).pipe(Effect.map((current) => current.has(checkpointRef))),
              captureHeadCheckpoint: ({ cwd, head, checkpointRef }) =>
                record(`snapshot ${cwd} at ${head[0]}`).pipe(
                  Effect.andThen(
                    Ref.update(refs, (current) => new Set([...current, checkpointRef])),
                  ),
                ),
              diffCheckpoints: ({ cwd }) =>
                cwd === unreadableRepository
                  ? Effect.fail(
                      new VcsProcessExitError({
                        operation: "test.diff",
                        command: "git",
                        cwd,
                        exitCode: 128,
                        detail: "fatal: unable to read tree",
                      }),
                    )
                  : Effect.succeed("1\t0\tfile.ts\0"),
              listAuthoredPaths: () => Effect.succeed(null),
            }),
          ),
        ),
        Layer.provideMerge(NodeCrypto.layer),
      );

      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        const scopes = yield* checkpoints.repositoryScopes({ rootScope: scope, ...thread });
        // The plain folder gets no scope.
        assert.deepEqual(
          scopes.map((repository) => repository.cwd),
          repositories,
        );
        // A scope works in the thread's checkout and is known by the tracked folder it stands for.
        assert.deepEqual(
          scopes.slice(0, 2).map((repository) => repository.repositoryPath),
          ["/tracked/repo-0", repositories[1]],
        );
        const captureAll = (ordinalWithinScope: number) =>
          Effect.forEach(scopes, (repository) =>
            checkpoints.captureRepository({
              scope: repository,
              runId: scope.runId!,
              nodeId: scope.nodeId,
              ordinalWithinScope,
              capturedAt: scope.createdAt,
              baselineCapturedAt: scope.createdAt,
              baselineRecorded: false,
            }),
          );

        // Every baseline shares the turn's budget; the slow repository is left without one.
        const firstTurn = yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: 0, thread })
          .pipe(Effect.forkChild);
        yield* Deferred.await(slowStarted);
        yield* Deferred.await(othersSeen);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(firstTurn);
        yield* Ref.set(slow, false);

        // A turn that changes nothing writes nothing and records nothing.
        assert.isTrue((yield* captureAll(1)).every(Option.isNone));
        assert.isFalse((yield* Ref.get(calls)).some((call) => call.startsWith("snapshot")));

        // The next turn starts from what each repository's last run ended with, so only the
        // thread's own folder is read.
        yield* Ref.set(calls, []);
        yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 1, thread });
        assert.deepEqual(yield* Ref.get(calls), ["probe /wrapper"]);

        // The turn commits in two repositories: each baseline is snapshotted from where it started.
        // One of them cannot list what changed, which is not the same as nothing having changed.
        yield* Ref.set(
          heads,
          new Map([
            [changedRepository, "b".repeat(40)],
            [unreadableRepository, "b".repeat(40)],
          ]),
        );
        yield* Ref.set(calls, []);
        const recorded = (yield* captureAll(2)).flatMap(Option.toArray);
        assert.deepEqual(
          recorded.map(({ baseline, checkpoint }) => ({
            cwd: scopes.find((repository) => repository.id === checkpoint.scopeId)?.cwd,
            baseline: baseline?.ordinalWithinScope,
            ordinal: checkpoint.ordinalWithinScope,
            files: checkpoint.files.map((file) => file.path),
          })),
          [
            { cwd: changedRepository, baseline: 1, ordinal: 2, files: ["file.ts"] },
            { cwd: unreadableRepository, baseline: 1, ordinal: 2, files: [] },
          ],
        );
        assert.deepEqual(
          (yield* Ref.get(calls)).filter((call) => call.startsWith("snapshot")),
          [changedRepository, unreadableRepository].flatMap((cwd) => [
            `snapshot ${cwd} at a`,
            `snapshot ${cwd} at b`,
          ]),
        );
        assert.lengthOf(
          (yield* Ref.get(calls)).filter((call) => call.startsWith("status")),
          repositories.length,
        );
      }).pipe(Effect.provide(layerTest));
    }),
);

it.effect("records a repository probe failure as an error checkpoint, not a missing one", () =>
  Effect.gen(function* () {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:probe-failure"),
      threadId: ThreadId.make("thread:probe-failure"),
      runId: RunId.make("run:probe-failure:1"),
      nodeId: NodeId.make("node:probe-failure:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:probe-failure"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/bad-config",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          layerNoTrackedFolders,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () =>
              Effect.fail(
                new VcsProcessExitError({
                  operation: "GitVcsDriver.detectRepository",
                  command: "git",
                  cwd: scope.cwd,
                  exitCode: 128,
                  detail: "fatal: bad config line 1 in file .git/config",
                }),
              ),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );

    const statuses = yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 0,
        nodeId: scope.nodeId,
        capturedAt: scope.createdAt,
      });
      const turn = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId!,
        nodeId: scope.nodeId!,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      });
      return { baseline: baseline.status, turn: turn.status };
    }).pipe(Effect.provide(layerTest));

    assert.deepEqual(statuses, { baseline: "error", turn: "error" });
  }),
);

it.effect("backs off only baseline retries after repeated workspace capture timeouts", () =>
  Effect.gen(function* () {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:slow-capture"),
      threadId: ThreadId.make("thread:slow-capture"),
      runId: RunId.make("run:slow-capture:1"),
      nodeId: NodeId.make("node:slow-capture:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:slow-capture"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/slow",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const timeout = new VcsProcessTimeoutError({
      operation: "GitVcsDriver.checkpoints.captureCheckpoint",
      command: "git",
      cwd: scope.cwd,
      timeoutMs: 30_000,
    });
    let attempts = 0;
    let healthy = false;
    let nonTimeoutFailure = false;
    const failure = new VcsProcessExitError({
      operation: "test.capture",
      command: "git",
      cwd: scope.cwd,
      exitCode: 128,
      detail: "capture failed",
    });
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          layerNoTrackedFolders,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef: () => Effect.succeed(false),
            captureCheckpoint: () =>
              Effect.suspend(() => {
                attempts++;
                return healthy ? Effect.void : Effect.fail(nonTimeoutFailure ? failure : timeout);
              }),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );
    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const baseline = { scope, ordinalWithinScope: 0 };
      const turn = {
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId,
        nodeId: scope.nodeId,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      };
      yield* Effect.result(checkpoints.captureBaseline(baseline));
      assert.strictEqual((yield* checkpoints.capture(turn)).status, "error");
      assert.strictEqual(attempts, 2);

      const otherThread = { ...scope, id: CheckpointScopeId.make("checkpoint-scope:other") };
      const skipped = yield* Effect.result(
        checkpoints.captureBaseline({ scope: otherThread, ordinalWithinScope: 0 }),
      );
      assert.strictEqual(attempts, 2, "baseline retried a repeatedly timing-out workspace");
      assert.strictEqual(skipped._tag, "Success");

      yield* Effect.result(
        checkpoints.captureBaseline({
          scope: { ...otherThread, cwd: "/repo/other" },
          ordinalWithinScope: 0,
        }),
      );
      assert.strictEqual(attempts, 3, "another workspace must still attempt capture");

      const failedTurn = yield* checkpoints.capture(turn);
      assert.strictEqual(failedTurn.status, "error");
      assert.strictEqual(attempts, 4, "post-turn capture must not back off");

      yield* checkpoints.captureBaseline(baseline);
      assert.strictEqual(attempts, 4, "baseline retries must wait for post-turn recovery");
      healthy = true;
      assert.strictEqual((yield* checkpoints.capture(turn)).status, "ready");
      assert.strictEqual(attempts, 5);
      yield* checkpoints.captureBaseline(baseline);
      assert.strictEqual(attempts, 6, "a successful post-turn capture must clear backoff");

      healthy = false;
      yield* Effect.result(checkpoints.captureBaseline(baseline));
      yield* Effect.result(checkpoints.captureBaseline(baseline));
      yield* checkpoints.captureBaseline(baseline);
      assert.strictEqual(attempts, 8);
      nonTimeoutFailure = true;
      assert.strictEqual((yield* checkpoints.capture(turn)).status, "error");
      nonTimeoutFailure = false;
      yield* Effect.result(checkpoints.captureBaseline(baseline));
      assert.strictEqual(attempts, 10, "a non-timeout failure must clear backoff");
      healthy = true;
      yield* checkpoints.captureBaseline(baseline);
      healthy = false;
      yield* Effect.result(checkpoints.captureBaseline(baseline));
      yield* Effect.result(checkpoints.captureBaseline(baseline));
      assert.strictEqual(attempts, 13, "a successful baseline must clear the timeout streak");
    }).pipe(Effect.provide(layerTest));
  }),
);

it.effect("skips post-turn captures that waited out another capture's timeout in the folder", () =>
  Effect.gen(function* () {
    const scopeFor = (name: string): OrchestrationV2CheckpointScope => ({
      id: CheckpointScopeId.make(`checkpoint-scope:shared-folder:${name}`),
      threadId: ThreadId.make(`thread:shared-folder:${name}`),
      runId: RunId.make(`run:shared-folder:${name}:1`),
      nodeId: NodeId.make(`node:shared-folder:${name}:1`),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make(`provider-thread:shared-folder:${name}`),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/shared",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    });
    const attempts = yield* Ref.make(0);
    // Outcomes for upcoming attempts; an attempt with none scripted times out.
    const script = yield* Ref.make<ReadonlyArray<"ready" | "timeout">>([]);
    const started = yield* Queue.unbounded<void>();
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          noTrackedFolders,
          Path.layer,
          FileSystem.layerNoop({ realPath: (target) => Effect.succeed(target) }),
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef: () => Effect.succeed(false),
            resolveCleanHead: () => Effect.succeed(null),
            captureCheckpoint: ({ cwd }) =>
              Effect.gen(function* () {
                yield* Ref.update(attempts, (count) => count + 1);
                yield* Queue.offer(started, undefined);
                yield* Effect.sleep("30 seconds");
                const [next = "timeout", ...rest] = yield* Ref.get(script);
                yield* Ref.set(script, rest);
                if (next === "ready") return;
                return yield* new VcsProcessTimeoutError({
                  operation: "GitVcsDriver.checkpoints.captureCheckpoint",
                  command: "git",
                  cwd,
                  timeoutMs: 30_000,
                });
              }),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );
    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const captureTurn = (scope: OrchestrationV2CheckpointScope) =>
        checkpoints
          .capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
      // A baseline's short budget running out says nothing about a post-turn capture.
      const baseline = yield* checkpoints
        .captureBaseline({ scope: scopeFor("baseline"), ordinalWithinScope: 0 })
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      yield* Queue.take(started);
      const afterBaseline = yield* captureTurn(scopeFor("after-baseline"));
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(baseline);
      yield* Queue.take(started);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual((yield* Fiber.join(afterBaseline)).status, "error");
      assert.strictEqual(yield* Ref.get(attempts), 2);

      const first = yield* captureTurn(scopeFor("first"));
      yield* Queue.take(started);
      // Other threads in the same folder finish their turns while the first capture hangs.
      const waiting = [
        yield* captureTurn(scopeFor("second")),
        yield* captureTurn(scopeFor("third")),
      ];
      const repository = scopeFor("repository");
      const repositoryWaiting = yield* checkpoints
        .captureRepository({
          scope: repository,
          runId: repository.runId!,
          nodeId: repository.nodeId!,
          ordinalWithinScope: 1,
          capturedAt: repository.createdAt,
          baselineCapturedAt: repository.createdAt,
          baselineRecorded: true,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      // A thread's root capture first materializes its baseline, which waits on the lock too.
      const root = scopeFor("root");
      const rootWaiting = yield* Effect.gen(function* () {
        const capturesBeforeLock = yield* checkpoints.capturesSoFar(root.cwd);
        yield* checkpoints.materializeBaselineCheckpoint({
          scope: root,
          ordinalWithinScope: 0,
          nodeId: root.nodeId!,
          capturedAt: root.createdAt,
        });
        return yield* checkpoints.capture({
          scope: root,
          ordinalWithinScope: 1,
          runId: root.runId!,
          nodeId: root.nodeId!,
          appRunOrdinal: 1,
          capturedAt: root.createdAt,
          capturesBeforeLock,
        });
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual((yield* Fiber.join(first)).status, "error");
      // Room for every waiter to probe, so the count below is what fails without the fix.
      yield* TestClock.adjust("120 seconds");
      for (const fiber of waiting) {
        assert.strictEqual((yield* Fiber.join(fiber)).status, "error");
      }
      const repositoryCaptured = yield* Fiber.join(repositoryWaiting);
      assert.strictEqual(Option.getOrThrow(repositoryCaptured).checkpoint.status, "error");
      assert.strictEqual((yield* Fiber.join(rootWaiting)).status, "error");
      assert.strictEqual(yield* Ref.get(attempts), 3, "each waiter spent its own full timeout");

      // A capture that starts after the timeout still probes for recovery.
      const later = yield* captureTurn(scopeFor("later"));
      yield* Queue.take(started);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual((yield* Fiber.join(later)).status, "error");
      assert.strictEqual(yield* Ref.get(attempts), 4);

      // A success ahead in the queue does not hide a timeout that follows it.
      yield* Ref.set(script, ["ready", "timeout"]);
      const recovered = yield* captureTurn(scopeFor("recovered"));
      const relapsed = yield* captureTurn(scopeFor("relapsed"));
      const queuedBehind = yield* captureTurn(scopeFor("queued-behind"));
      yield* TestClock.adjust("90 seconds");
      assert.deepEqual(
        [
          (yield* Fiber.join(recovered)).status,
          (yield* Fiber.join(relapsed)).status,
          (yield* Fiber.join(queuedBehind)).status,
        ],
        ["ready", "error", "error"],
      );
      assert.strictEqual(yield* Ref.get(attempts), 6, "the waiter probed after a later timeout");
    }).pipe(Effect.provide(layerTest));
  }),
);

it.effect("keeps the pre-rewind snapshot of a folder a failed rewind could not put back", () => {
  const targets = ["first", "second"].map((name) => ({
    scope: { id: CheckpointScopeId.make(`checkpoint-scope:rewind:${name}`), cwd: `/repo/${name}` },
    checkpoint: {
      ordinalWithinScope: 1,
      ref: CheckpointRef.make(`refs/t3/test/rewind/${name}`),
      status: "ready" as const,
    },
  }));
  const failure = new VcsProcessTimeoutError({
    operation: "test.restore",
    command: "git",
    cwd: "/repo",
    timeoutMs: 30000,
  });
  const preRewindRefs = new Map<string, string>();
  const captured: Array<string> = [];
  const existing = new Set<string>();
  const deleted: Array<{ readonly cwd: string; readonly ref: string }> = [];
  const layerTest = CheckpointService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        layerNoTrackedFolders,
        Layer.mock(CheckpointStore.CheckpointStore)({
          hasCheckpointRef: (input) =>
            Effect.sync(
              () =>
                targets.some((target) => target.checkpoint.ref === input.checkpointRef) ||
                existing.has(input.checkpointRef),
            ),
          captureCheckpoint: (input) =>
            Effect.sync(() => {
              captured.push(input.cwd);
              existing.add(input.checkpointRef);
              preRewindRefs.set(input.cwd, input.checkpointRef);
            }),
          // The second folder's rewind fails, and then so does putting the first one back.
          restoreCheckpoint: (input) =>
            input.checkpointRef === targets[1]!.checkpoint.ref ||
            input.checkpointRef === preRewindRefs.get("/repo/first")
              ? Effect.fail(failure)
              : Effect.succeed(true),
          deleteCheckpointRefs: (input) =>
            Effect.sync(() => {
              for (const ref of input.checkpointRefs) {
                existing.delete(ref);
                deleted.push({ cwd: input.cwd, ref });
              }
            }),
        }),
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );
  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const result = yield* Effect.result(
      checkpoints.restore({ targets, scopes: targets.map((target) => target.scope) }),
    );
    assert.strictEqual(result._tag, "Failure");
    assert.deepEqual(deleted, [{ cwd: "/repo/second", ref: preRewindRefs.get("/repo/second")! }]);

    // A retry starts from a half-restored folder; the kept snapshot is not taken again.
    yield* Effect.result(
      checkpoints.restore({ targets, scopes: targets.map((target) => target.scope) }),
    );
    assert.deepEqual(captured, ["/repo/first", "/repo/second", "/repo/second"]);
  }).pipe(Effect.provide(layerTest));
});
