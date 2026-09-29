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

import { dismissThreadErrorBannerForSession, getThreadErrorBannerKey } from "./ThreadErrorBanner";

/*
 * Dismissing a thread's error banner, and deciding when it comes back.
 *
 * Rule: a dismissed error on a thread stays hidden until a run fails that
 * comes after the latest run the thread had at dismissal, in V2's run order
 * (`ordinal`), or a run fails that had not finished then; or until the
 * thread's error text is one never dismissed on it.
 *
 * The text half is upstream's mask in `ThreadErrorBanner`: the chat view
 * passes its result in as `maskedError`, and a dismissal adds the texts on
 * screen to it. This module adds the run half, a watermark by order rather
 * than by membership: the client may hold only a window of the thread's runs,
 * and a fuller history can bring older failed runs it never saw. Those are
 * below the watermark, so they never bring the banner back.
 *
 * The run that was executing at dismissal is not new when it later fails with
 * a text dismissed then: a provider publishes a failure on the session first
 * and finalises the run afterwards, and that is one failure. A new failed run
 * is shown with its own message and class, even while the session still holds
 * older text, which V2's `threadErrorSummary` would otherwise prefer.
 *
 * Client-local errors always show; the dismiss handler clears them.
 *
 * State is renderer memory, one entry per environment-scoped thread key, and
 * is lost on reload, as upstream's mask is. A dismissal replaces the thread's
 * entry; an entry holds one or two texts, an ordinal and the ids of runs
 * still unfinished at dismissal.
 *
 * Known limit: two session-only failures with the same text and no run
 * between them are one banner.
 */

type FailureClass = OrchestrationV2ProviderFailureClass | null;
type Projection = Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">;

interface Dismissal {
  readonly texts: ReadonlyArray<string>;
  /** The highest run ordinal the thread had at dismissal. */
  readonly latestOrdinal: number;
  /** Runs that had not finished at dismissal and may still fail. */
  readonly unfinishedRunIds: ReadonlySet<string>;
  /** The run executing at dismissal, whose failure the session may have published first. */
  readonly executingRunId: string | null;
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

const FINISHED_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

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
    if (run.status !== "failed") continue;
    if (run.ordinal <= dismissal.latestOrdinal && !dismissal.unfinishedRunIds.has(run.id)) continue;
    if (newest === null || run.ordinal > newest.ordinal) newest = run;
  }
  if (newest === null) return null;
  const failure = rootFailure(newest, projection.turnItems);
  const message = failure?.message ?? serverError;
  if (newest.id === dismissal.executingRunId && dismissal.texts.includes(message)) return null;
  return failure === null
    ? { message: serverError, errorClass: serverErrorClass }
    : { message: failure.message, errorClass: failure.class };
}

/**
 * The thread error to show in the banner, or null once the user dismissed it.
 * `maskedError` is upstream's text mask applied to the thread error;
 * `serverError` and `serverErrorClass` are the thread runtime's `lastError`
 * and `lastErrorClass`. A local error takes precedence, as in the chat view.
 */
export function presentThreadError(input: {
  threadKey: string;
  maskedError: string | null;
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
  if (input.maskedError !== null) return show(serverError, input.serverErrorClass);
  const dismissal = dismissalsByThreadKey.get(input.threadKey);
  const failure =
    dismissal === undefined || projection === null
      ? null
      : failureSinceDismissal(projection, dismissal, serverError, input.serverErrorClass);
  return failure === null ? NOTHING_SHOWN : show(failure.message, failure.errorClass);
}

/** Records the watermark for the error the user just dismissed, and masks its texts. */
export function dismissThreadError(pending: PendingThreadErrorDismissal | null): void {
  if (pending === null) return;
  let latestOrdinal = 0;
  const unfinishedRunIds = new Set<string>();
  for (const run of pending.runs) {
    if (run.ordinal > latestOrdinal) latestOrdinal = run.ordinal;
    if (!FINISHED_RUN_STATUSES.has(run.status)) unfinishedRunIds.add(run.id);
  }
  const executing = latestExecutedRun(pending.runs);
  dismissalsByThreadKey.set(pending.threadKey, {
    texts: pending.texts,
    latestOrdinal,
    unfinishedRunIds,
    executingRunId: executing !== null && unfinishedRunIds.has(executing.id) ? executing.id : null,
  });
  for (const text of pending.texts) {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey(pending.threadKey, text));
  }
}
