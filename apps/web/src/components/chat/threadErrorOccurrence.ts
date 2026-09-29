import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "turnItems" | "providerSessions"
>;

interface FailedRun {
  readonly stamp: string;
  readonly message: string;
}

// Newest first. Built once per projection object, so a render that changes
// nothing about the thread does not walk its turn items again.
const failedRunsByProjection = new WeakMap<Projection, ReadonlyArray<FailedRun>>();

function failedRunsOf(projection: Projection): ReadonlyArray<FailedRun> {
  const cached = failedRunsByProjection.get(projection);
  if (cached !== undefined) return cached;
  const failedRuns = projection.runs
    .filter((run) => run.status === "failed")
    .toSorted((a, b) => b.ordinal - a.ordinal)
    .flatMap((run) => {
      const failure = latestRootProviderFailure(run, projection.turnItems);
      return failure === null
        ? []
        : [
            {
              stamp: `${run.id}:${run.completedAt === null ? "" : DateTime.toEpochMillis(run.completedAt)}`,
              message: failure.message,
            },
          ];
    });
  failedRunsByProjection.set(projection, failedRuns);
  return failedRuns;
}

/**
 * Names the occurrence of the error a thread is showing, so a dismissal hides
 * that failure and not every later failure with the same text.
 *
 * V2 keeps no timestamp for a session's error: `providerSession.updatedAt`
 * moves on every session update (a model change, an idle release), so it says
 * nothing about when the error was written. The occurrence is therefore
 * derived from what does not move. A failure a run recorded is identified by
 * that run, the newest failed run whose failure has the shown text, and stays
 * the same when the session later repeats the text or drops it on idle
 * release. A session error no run recorded is identified by its session and
 * the latest started run. A failed latest run is always part of the stamp, so
 * a new failed run is shown even while an older session error, whose text V2
 * prefers, is still on the thread. A client-local error is identified by the
 * time it was written.
 *
 * Not told apart: a session error no run recorded that is written twice with
 * the same text, without a run starting in between.
 */
export function deriveThreadErrorOccurrence(input: {
  error: string | null;
  localError: { readonly message: string | null; readonly at: number } | undefined;
  projection: Projection | null;
}): string {
  if (input.error === null) return "";
  if (input.localError?.message != null) {
    return `local:${input.localError.at}`;
  }
  if (input.projection === null) return "";
  const { projection } = input;
  const latestRun = latestExecutedRun(projection.runs);
  const recordedBy = failedRunsOf(projection).find((failed) => failed.message === input.error);
  const session = projection.providerSessions.findLast(
    (candidate) => candidate.providerInstanceId === projection.thread.providerInstanceId,
  );
  const source =
    recordedBy !== undefined
      ? `run:${recordedBy.stamp}`
      : `session:${session?.id ?? ""}:${latestRun?.id ?? ""}`;
  return latestRun?.status === "failed" ? `${source}|${latestRun.id}` : source;
}
