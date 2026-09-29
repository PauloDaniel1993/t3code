import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";

/*
 * Dismissing a thread's error banner, and deciding when it comes back.
 *
 * Rule: a dismissed error on a thread stays hidden until the thread has a
 * failed run that had not failed when the user dismissed, or until the
 * thread's error text becomes one it did not have at dismissal.
 *
 * A dismissal records a watermark, not an identity for the error: the texts
 * the thread had, which runs had failed, and which run was the latest. Every
 * field an identity could be built from (a session's update time, the latest
 * run's status, error items in the loaded history window) also changes for
 * reasons other than a new failure. Runs are in every snapshot, bounded or
 * not, so the watermark reads only them.
 *
 * The latest run at dismissal is not new when it later fails with a dismissed
 * text: a provider publishes a failure on the session first and finalises the
 * run afterwards, and that is one failure. A new failed run is shown with its
 * own message, even while the session still holds older text, which V2's
 * `threadErrorSummary` would otherwise prefer.
 *
 * Client-local errors are not recorded: the dismiss handler clears them.
 *
 * State is renderer memory, one entry per environment-scoped thread key, and
 * is lost on reload, as upstream's mask is. A dismissal replaces the thread's
 * entry. Entries are not evicted: one is written only by a click and holds a
 * few strings and run ids, so an entry for a thread deleted since stays until
 * reload.
 *
 * Known limit: two session-only failures with the same text and no run
 * between them are one banner. A different text always shows.
 */

type FailureClass = OrchestrationV2ProviderFailureClass | null;
type Projection = Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">;

interface Dismissal {
  readonly texts: ReadonlyArray<string>;
  readonly failedRunIds: ReadonlySet<string>;
  readonly latestRunId: string | null;
}

/** What the dismiss handler records for the error on screen. */
export interface PendingThreadErrorDismissal {
  readonly threadKey: string;
  readonly texts: ReadonlyArray<string>;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
}

export interface PresentedThreadError {
  readonly message: string | null;
  readonly errorClass: FailureClass;
  /** Null when there is nothing to remember, such as a client-local error. */
  readonly dismissal: PendingThreadErrorDismissal | null;
}

const dismissalsByThreadKey = new Map<string, Dismissal>();

const NOTHING_SHOWN: PresentedThreadError = { message: null, errorClass: null, dismissal: null };

// A hidden banner rerenders with the same run and history on most renders, so
// keep the last root failure lookup instead of walking the turn items again.
let lastLookup: {
  readonly run: OrchestrationV2Run;
  readonly turnItems: Projection["turnItems"];
  readonly failure: OrchestrationV2ProviderFailure | null;
} | null = null;

function rootFailure(run: OrchestrationV2Run, turnItems: Projection["turnItems"]) {
  if (lastLookup?.run !== run || lastLookup.turnItems !== turnItems) {
    lastLookup = { run, turnItems, failure: latestRootProviderFailure(run, turnItems) };
  }
  return lastLookup.failure;
}

/** The newest run that failed after the dismissal, with the message it failed with. */
function failureSinceDismissal(
  projection: Projection,
  dismissal: Dismissal,
  serverError: string,
  serverErrorClass: FailureClass,
): { readonly message: string; readonly errorClass: FailureClass } | null {
  let newest: OrchestrationV2Run | null = null;
  for (const run of projection.runs) {
    if (run.status !== "failed" || dismissal.failedRunIds.has(run.id)) continue;
    if (newest === null || run.ordinal > newest.ordinal) newest = run;
  }
  if (newest === null) return null;
  const failure = rootFailure(newest, projection.turnItems);
  const message = failure?.message ?? serverError;
  if (newest.id === dismissal.latestRunId && dismissal.texts.includes(message)) return null;
  return failure === null
    ? { message: serverError, errorClass: serverErrorClass }
    : { message: failure.message, errorClass: failure.class };
}

/**
 * The thread error to show in the banner, or null once the user dismissed it.
 * `serverError` and `serverErrorClass` are the thread runtime's `lastError`
 * and `lastErrorClass`; a local error takes precedence, as in the chat view.
 */
export function presentThreadError(input: {
  threadKey: string;
  localError: string | null;
  serverError: string | null;
  serverErrorClass: FailureClass;
  projection: Projection | null;
}): PresentedThreadError {
  if (input.localError !== null) {
    return { message: input.localError, errorClass: null, dismissal: null };
  }
  const { serverError, projection } = input;
  if (serverError === null) return NOTHING_SHOWN;
  const show = (message: string, errorClass: FailureClass): PresentedThreadError => ({
    message,
    errorClass,
    dismissal: {
      threadKey: input.threadKey,
      texts: message === serverError ? [serverError] : [serverError, message],
      runs: projection?.runs ?? [],
    },
  });
  const dismissal = dismissalsByThreadKey.get(input.threadKey);
  if (dismissal === undefined) return show(serverError, input.serverErrorClass);
  const failure =
    projection === null
      ? null
      : failureSinceDismissal(projection, dismissal, serverError, input.serverErrorClass);
  if (failure !== null) return show(failure.message, failure.errorClass);
  return dismissal.texts.includes(serverError)
    ? NOTHING_SHOWN
    : show(serverError, input.serverErrorClass);
}

/** Records the watermark for the error the user just dismissed. */
export function dismissThreadError(pending: PendingThreadErrorDismissal | null): void {
  if (pending === null) return;
  const failedRunIds = new Set<string>();
  for (const run of pending.runs) {
    if (run.status === "failed") failedRunIds.add(run.id);
  }
  dismissalsByThreadKey.set(pending.threadKey, {
    texts: pending.texts,
    failedRunIds,
    latestRunId: latestExecutedRun(pending.runs)?.id ?? null,
  });
}
