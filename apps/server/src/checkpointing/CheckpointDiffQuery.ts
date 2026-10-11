/**
 * CheckpointDiffQuery - Query interface for computed checkpoint diffs.
 *
 * Provides read-only diff operations across checkpoint snapshots used by
 * orchestration APIs.
 *
 * @module CheckpointDiffQuery
 */
import {
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type ThreadId,
  type OrchestrationV2CheckpointPart,
  type OrchestrationV2CheckpointFolder,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
  type CheckpointServiceError,
} from "./Errors.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { checkpointFolderDiffs, collectCheckpointDiffs } from "./CheckpointFolderDiffs.ts";

/** Service tag for checkpoint diff queries. */
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    /**
     * Read the patch diff for a single turn checkpoint transition.
     *
     * Verifies checkpoint availability in both projection state and filesystem.
     */
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    /**
     * Read the full patch diff across a thread range of checkpoints.
     *
     * Uses turn-diff semantics with `fromTurnCount = 0`.
     */
    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
  }
>()("t3/checkpointing/CheckpointDiffQuery") {}

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;

  const getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff = buildTurnDiffResult(input, "");
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const projection = yield* threads.getCheckpointContext(input.threadId).pipe(
        Effect.mapError(
          () =>
            new CheckpointThreadNotFoundError({
              operation,
              threadId: input.threadId,
            }),
        ),
        Effect.withSpan("checkpoint.turnDiff.lookupContext"),
      );
      const completedRunIds = new Set(
        projection.runs.filter((run) => run.status === "completed").map((run) => run.id),
      );
      const readyCheckpoints = projection.checkpoints.filter(
        (checkpoint) =>
          checkpoint.status !== "stale" &&
          (checkpoint.parts !== undefined || checkpoint.status === "ready") &&
          checkpoint.appRunOrdinal !== null &&
          checkpoint.runId !== null &&
          completedRunIds.has(checkpoint.runId),
      );
      const maxTurnCount = readyCheckpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.appRunOrdinal ?? 0),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointTurnRangeUnavailableError({
          operation,
          threadId: input.threadId,
          requestedTurnCount: input.toTurnCount,
          availableTurnCount: maxTurnCount,
        });
      }

      const toCheckpoint = readyCheckpoints.find(
        (checkpoint) => checkpoint.appRunOrdinal === input.toTurnCount,
      );
      if (toCheckpoint === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: "to",
        });
      }

      if (toCheckpoint.parts !== undefined) {
        const history = readyCheckpoints
          .filter((checkpoint) => checkpoint.appRunOrdinal! <= input.toTurnCount)
          .toSorted((left, right) => left.appRunOrdinal! - right.appRunOrdinal!);
        const endpoints = new Map<
          string,
          {
            readonly part: OrchestrationV2CheckpointPart;
            readonly folder: OrchestrationV2CheckpointFolder;
          }
        >();
        for (const checkpoint of history) {
          for (const part of checkpoint.parts ?? []) {
            if (part.vcs !== "git" || part.status !== "ready" || part.ref === null) continue;
            for (const folder of part.folders) {
              endpoints.set(JSON.stringify([part.key, folder.folderPath]), {
                part,
                folder,
              });
            }
          }
        }

        const diffInputs: CheckpointStore.DiffCheckpointsInput[] = [];
        for (const { part, folder } of endpoints.values()) {
          const folderHistory = history.flatMap((candidate) => {
            const candidatePart = candidate.parts?.find(
              (entry) =>
                entry.key === part.key &&
                entry.vcs === "git" &&
                entry.status === "ready" &&
                entry.ref !== null &&
                entry.folders.some((entryFolder) => entryFolder.folderPath === folder.folderPath),
            );
            return candidatePart === undefined
              ? []
              : [{ checkpoint: candidate, part: candidatePart }];
          });
          const from = folderHistory.findLast(
            (candidate) => candidate.checkpoint.appRunOrdinal! <= input.fromTurnCount,
          );
          const first = folderHistory[0]!;
          const fromCheckpointRef =
            from?.part.ref ??
            checkpointRefForScopeOrdinal({
              scopeId: first.checkpoint.scopeId,
              ordinalWithinScope: Math.max(0, first.checkpoint.appRunOrdinal! - 1),
              partKey: part.key,
            });
          if (fromCheckpointRef === part.ref) continue;
          // Include older healthy nested folders in ownership even if they were
          // unavailable at this endpoint, so a parent cannot show them twice.
          const folders = [...endpoints.values()]
            .filter((endpoint) => endpoint.part.key === part.key)
            .map((endpoint) => endpoint.folder);
          const folderDiff = checkpointFolderDiffs({ ...part, folders }).find(
            (entry) => entry.folder.folderPath === folder.folderPath,
          )!;
          diffInputs.push({
            cwd: part.cwd,
            fromCheckpointRef,
            toCheckpointRef: part.ref!,
            fallbackFromToHead: false,
            ignoreWhitespace,
            relativePath: folderDiff.relativePath,
            srcPrefix: folderDiff.srcPrefix,
            dstPrefix: folderDiff.dstPrefix,
            pathspecs: folderDiff.pathspecs,
          });
        }
        const diffs = yield* collectCheckpointDiffs(diffInputs, checkpointStore.diffCheckpoints);
        return buildTurnDiffResult(input, diffs.map(({ diff }) => diff).join(""));
      }

      const toScope = projection.checkpointScopes.find(
        (scope) => scope.id === toCheckpoint.scopeId,
      );
      if (toScope === undefined) {
        return yield* new CheckpointWorkspacePathMissingError({
          operation,
          threadId: input.threadId,
        });
      }

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? (() => {
              // The root scope is shared by every run in this thread. Its
              // runId tracks the latest owner, while ordinal zero stays the baseline.
              const firstScope = projection.checkpointScopes.find(
                (scope) => scope.kind === "root_run",
              );
              return firstScope === undefined
                ? undefined
                : checkpointRefForScopeOrdinal({
                    scopeId: firstScope.id,
                    ordinalWithinScope: 0,
                  });
            })()
          : readyCheckpoints.find((checkpoint) => checkpoint.appRunOrdinal === input.fromTurnCount)
              ?.ref;
      if (fromCheckpointRef === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          checkpoint: "from",
        });
      }

      const diff = yield* checkpointStore
        .diffCheckpoints({
          cwd: toScope.cwd,
          fromCheckpointRef,
          toCheckpointRef: toCheckpoint.ref,
          fallbackFromToHead: false,
          ignoreWhitespace,
        })
        .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"));

      const turnDiff = buildTurnDiffResult(input, diff);
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }

      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQuery["Service"]["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const turnDiff = yield* getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace,
    });
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
