import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/shell";
import * as DateTime from "effect/DateTime";

/**
 * Names the occurrence of the error a thread is showing, so a dismissal hides
 * that failure and not every later failure with the same text.
 *
 * The provider session's error is stamped by the session update that wrote it;
 * a run failure is identified by the run that failed; a client-local error by
 * the time it was written. A repeat failure gets a new stamp, an unrelated
 * update to the thread does not.
 */
export function deriveThreadErrorOccurrence(input: {
  localError: { readonly message: string | null; readonly at: number } | undefined;
  projection: {
    readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "providerInstanceId">;
    readonly providerSessions: ReadonlyArray<
      Pick<
        OrchestrationV2ThreadProjection["providerSessions"][number],
        "providerInstanceId" | "lastError" | "updatedAt"
      >
    >;
  } | null;
  latestRun: Pick<ThreadRunSummary, "runId" | "completedAt"> | null;
}): string {
  if (input.localError?.message != null) {
    return `local:${input.localError.at}`;
  }
  const providerInstanceId = input.projection?.thread.providerInstanceId;
  const session = input.projection?.providerSessions.findLast(
    (candidate) => candidate.providerInstanceId === providerInstanceId,
  );
  if (session?.lastError != null) {
    return `session:${DateTime.toEpochMillis(session.updatedAt)}`;
  }
  return `run:${input.latestRun?.runId ?? ""}:${input.latestRun?.completedAt ?? ""}`;
}
