import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointRef,
  CheckpointScopeId,
  RunId,
  ThreadId,
  VcsProcessSpawnError,
  VcsProcessExitError,
  type OrchestrationV2CheckpointPart,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES } from "../vcs/VcsDriver.ts";
import {
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
} from "./Errors.ts";

const threadId = ThreadId.make("thread:checkpoint-diff-v2");
const firstRunId = RunId.make("run:checkpoint-diff-v2:1");
const secondRunId = RunId.make("run:checkpoint-diff-v2:2");
const firstScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:1");
const secondScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:2");
const secondRef = CheckpointRef.make("refs/t3/test/second");

function makeProjection(): ProjectionCheckpointContext {
  return {
    runs: [
      { id: firstRunId, ordinal: 1, status: "completed" },
      { id: secondRunId, ordinal: 2, status: "completed" },
    ],
    checkpointScopes: [
      { id: firstScopeId, runId: firstRunId, kind: "root_run", cwd: "/repo" },
      { id: secondScopeId, runId: secondRunId, kind: "root_run", cwd: "/repo" },
    ],
    checkpoints: [
      {
        scopeId: secondScopeId,
        runId: secondRunId,
        appRunOrdinal: 2,
        status: "ready",
        ref: secondRef,
      },
    ],
  };
}

function makeLayer(input: {
  readonly projection: Effect.Effect<ProjectionCheckpointContext, OrchestratorProjectionError>;
  readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
}) {
  return CheckpointDiffQuery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () => input.projection,
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          diffCheckpoints: input.diffCheckpoints ?? (() => Effect.succeed("diff")),
        }),
      ),
    ),
  );
}

it.effect("computes V2 run diffs from projected checkpoint scopes", () => {
  const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed("diff --git a/file b/file"),
  );
  const layer = makeLayer({ projection: Effect.succeed(makeProjection()), diffCheckpoints });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });

    assert.deepEqual(result, {
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      diff: "diff --git a/file b/file",
    });
    assert.deepEqual(diffCheckpoints.mock.calls[0]?.[0], {
      cwd: "/repo",
      fromCheckpointRef: checkpointRefForScopeOrdinal({
        scopeId: firstScopeId,
        ordinalWithinScope: 0,
      }),
      toCheckpointRef: secondRef,
      fallbackFromToHead: false,
      ignoreWhitespace: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-thread error contract", () => {
  const layer = makeLayer({
    projection: Effect.fail(new OrchestratorProjectionError({ threadId })),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointThreadNotFoundError);
    assert.deepEqual(
      { operation: error.operation, threadId: error.threadId },
      { operation: "CheckpointDiffQuery.getTurnDiff", threadId },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed unavailable-range error contract", () => {
  const layer = makeLayer({ projection: Effect.succeed(makeProjection()) });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 3 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 3, availableTurnCount: 2 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("excludes ready checkpoints from rolled-back runs", () => {
  const projection = makeProjection();
  const layer = makeLayer({
    projection: Effect.succeed({
      ...projection,
      runs: projection.runs.map((run) =>
        run.id === secondRunId ? { ...run, status: "rolled_back" as const } : run,
      ),
      checkpoints: [
        {
          ...projection.checkpoints[0]!,
          scopeId: firstScopeId,
          runId: firstRunId,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("refs/t3/test/first"),
        },
        ...projection.checkpoints,
      ],
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 2, availableTurnCount: 1 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-baseline-ref error contract", () => {
  const projection = makeProjection();
  const layer = makeLayer({
    projection: Effect.succeed({
      ...projection,
      checkpointScopes: projection.checkpointScopes.map((scope) => ({
        ...scope,
        kind: "tool" as const,
      })),
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointRefUnavailableError);
    assert.deepEqual(
      { checkpoint: error.checkpoint, turnCount: error.turnCount },
      { checkpoint: "from", turnCount: 0 },
    );
  }).pipe(Effect.provide(layer));
});

function part(
  key: string,
  ordinal: number,
  overrides: Partial<OrchestrationV2CheckpointPart> = {},
): OrchestrationV2CheckpointPart {
  return {
    key,
    cwd: `/checkpoints/${key}`,
    vcs: "git",
    ref: CheckpointRef.make(`refs/test/${key}/${ordinal}`),
    status: "ready",
    pathspecs: ["."],
    folders: [{ folderPath: `/source/${key}`, label: key, relativePath: "" }],
    ...overrides,
  };
}

function partsProjection(
  first: ReadonlyArray<OrchestrationV2CheckpointPart>,
  second: ReadonlyArray<OrchestrationV2CheckpointPart>,
): ProjectionCheckpointContext {
  return {
    ...makeProjection(),
    checkpointScopes: [
      { id: firstScopeId, runId: secondRunId, kind: "root_run", cwd: "/changed-primary" },
    ],
    checkpoints: [first, second].map((parts, index) => ({
      scopeId: firstScopeId,
      runId: index === 0 ? firstRunId : secondRunId,
      appRunOrdinal: index + 1,
      status: "error",
      ref: CheckpointRef.make(`refs/unused-primary/${index + 1}`),
      parts,
    })),
  };
}

it.effect("diffs healthy parts of error barriers using each folder's ready endpoints", () => {
  const projection = partsProjection(
    [part("primary", 1), part("lib", 1, { status: "error" })],
    [part("primary", 2, { status: "error" }), part("lib", 2)],
  );
  const calls: CheckpointStore.DiffCheckpointsInput[] = [];
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    assert.equal(result.diff, "refs/test/primary/1\nrefs/test/lib/2\n");
    assert.deepEqual(
      calls.map((call) => call.cwd),
      ["/checkpoints/primary", "/checkpoints/lib"],
    );
    assert.equal(
      calls[1]?.fromCheckpointRef,
      checkpointRefForScopeOrdinal({
        scopeId: firstScopeId,
        ordinalWithinScope: 0,
        partKey: "lib",
      }),
    );
    calls.length = 0;
    const turn = yield* query.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2 });
    assert.equal(turn.diff, "refs/test/lib/2\n");
  }).pipe(
    Effect.provide(
      makeLayer({
        projection: Effect.succeed(projection),
        diffCheckpoints: (input) => {
          calls.push(input);
          return Effect.succeed(`${input.toCheckpointRef}\n`);
        },
      }),
    ),
  );
});

it.effect(
  "uses checkpoint labels and a joining folder's own baseline inside an existing part",
  () => {
    const older = part("primary", 1, {
      folders: [{ folderPath: "/source/app", label: "old", relativePath: "app" }],
    });
    const newer = part("primary", 2, {
      folders: [
        { folderPath: "/source/app", label: "new", relativePath: "app" },
        { folderPath: "/source/lib", label: "lib", relativePath: "lib" },
      ],
    });
    const calls: CheckpointStore.DiffCheckpointsInput[] = [];
    return Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 });
      assert.equal(calls[0]?.srcPrefix, "a/old/");
      calls.length = 0;
      yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
      assert.deepEqual(
        calls.map((call) => [call.srcPrefix, call.fromCheckpointRef]),
        [
          [
            "a/new/",
            checkpointRefForScopeOrdinal({ scopeId: firstScopeId, ordinalWithinScope: 0 }),
          ],
          [
            "a/lib/",
            checkpointRefForScopeOrdinal({ scopeId: firstScopeId, ordinalWithinScope: 1 }),
          ],
        ],
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          projection: Effect.succeed(partsProjection([older], [newer])),
          diffCheckpoints: (input) => {
            calls.push(input);
            return Effect.succeed("patch\n");
          },
        }),
      ),
    );
  },
);

it.effect("diffs git secondaries when the primary was never checkpointed", () => {
  const projection = partsProjection(
    [],
    [part("primary", 2, { vcs: null, status: "missing", ref: null }), part("lib", 2)],
  );
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    assert.equal(result.diff, "secondary patch");
  }).pipe(
    Effect.provide(
      makeLayer({
        projection: Effect.succeed(projection),
        diffCheckpoints: (input) => {
          assert.equal(input.cwd, "/checkpoints/lib");
          return Effect.succeed("secondary patch");
        },
      }),
    ),
  );
});

it.effect("retains healthy patches when a previously ready checkout disappears", () => {
  const lost = part("lost", 1, {
    folders: [
      { folderPath: "/source/lost/a", label: "a", relativePath: "a" },
      { folderPath: "/source/lost/b", label: "b", relativePath: "b" },
    ],
  });
  const calls: string[] = [];
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    assert.equal(result.diff, "healthy patch");
    assert.deepEqual(calls, ["/checkpoints/lost", "/checkpoints/primary"]);
  }).pipe(
    Effect.provide(
      makeLayer({
        projection: Effect.succeed(
          partsProjection([lost, part("primary", 1)], [part("primary", 2)]),
        ),
        diffCheckpoints: (input) => {
          calls.push(input.cwd);
          return input.cwd === lost.cwd
            ? Effect.fail(
                new VcsProcessSpawnError({
                  operation: "test.diff",
                  command: "git",
                  cwd: input.cwd,
                  cause: new Error("ENOENT"),
                }),
              )
            : Effect.succeed("healthy patch");
        },
      }),
    ),
  );
});

it.effect("includes early interrupted work in the full-thread baseline", () => {
  const projection = partsProjection([part("primary", 1)], [part("primary", 2)]);
  const calls: CheckpointStore.DiffCheckpointsInput[] = [];
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    assert.equal(
      calls[0]?.fromCheckpointRef,
      checkpointRefForScopeOrdinal({
        scopeId: firstScopeId,
        ordinalWithinScope: 0,
      }),
    );
  }).pipe(
    Effect.provide(
      makeLayer({
        projection: Effect.succeed({
          ...projection,
          runs: projection.runs.map((run) =>
            run.id === firstRunId ? { ...run, status: "interrupted" } : run,
          ),
        }),
        diffCheckpoints: (input) => {
          calls.push(input);
          return Effect.succeed("early and completed work");
        },
      }),
    ),
  );
});

it.effect(
  "retains a joining folder's patch when another baseline in its checkout is missing",
  () => {
    const older = part("primary", 1, {
      folders: [{ folderPath: "/source/app", label: "app", relativePath: "app" }],
    });
    const newer = part("primary", 2, {
      folders: [...older.folders, { folderPath: "/source/lib", label: "lib", relativePath: "lib" }],
    });
    return Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
      assert.equal(result.diff, "joining folder patch");
    }).pipe(
      Effect.provide(
        makeLayer({
          projection: Effect.succeed(partsProjection([older], [newer])),
          diffCheckpoints: (input) =>
            input.srcPrefix === "a/app/"
              ? Effect.fail(
                  new VcsProcessExitError({
                    operation: "test.diff",
                    command: "git",
                    cwd: input.cwd,
                    exitCode: 128,
                    detail: "bad revision: missing baseline",
                  }),
                )
              : Effect.succeed("joining folder patch"),
        }),
      ),
    );
  },
);

it.effect("reads old labels and refs through a later checkpoint's checkout location", () => {
  const calls: CheckpointStore.DiffCheckpointsInput[] = [];
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 });
    assert.equal(calls[0]?.cwd, "/recreated/primary");
    assert.equal(calls[0]?.srcPrefix, "a/old/");
    assert.equal(calls[0]?.toCheckpointRef, "refs/test/primary/1");
  }).pipe(
    Effect.provide(
      makeLayer({
        projection: Effect.succeed(
          partsProjection(
            [
              part("primary", 1, {
                folders: [{ folderPath: "/source/primary", label: "old", relativePath: "" }],
              }),
            ],
            [part("primary", 2, { cwd: "/recreated/primary" })],
          ),
        ),
        diffCheckpoints: (input) => {
          calls.push(input);
          return Effect.succeed("old labelled patch");
        },
      }),
    ),
  );
});

it.effect("shares a UTF-8 byte budget across folders and skips calls after exhaustion", () => {
  const calls: CheckpointStore.DiffCheckpointsInput[] = [];
  const projection = partsProjection([], [part("primary", 2), part("lib", 2), part("third", 2)]);
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    assert.equal(Buffer.byteLength(result.diff, "utf8"), CHECKPOINT_DIFF_MAX_OUTPUT_BYTES - 1);
    assert.deepEqual(
      calls.map((call) => call.maxOutputBytes),
      [CHECKPOINT_DIFF_MAX_OUTPUT_BYTES, CHECKPOINT_DIFF_MAX_OUTPUT_BYTES - 3],
    );
  }).pipe(
    Effect.provide(
      makeLayer({
        projection: Effect.succeed(projection),
        diffCheckpoints: (input) => {
          calls.push(input);
          return Effect.succeed(
            calls.length === 1 ? "€" : `${"x".repeat(input.maxOutputBytes! - 1)}€`,
          );
        },
      }),
    ),
  );
});
