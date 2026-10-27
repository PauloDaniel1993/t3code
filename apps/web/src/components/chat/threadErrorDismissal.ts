import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2Run,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";

import { dismissThreadErrorBannerForSession, getThreadErrorBannerKey } from "./ThreadErrorBanner";

// Run ordinals keep older failures from reappearing as history loads.
// The run executing at dismissal may publish its failure before it finishes.
// Session-only failures with identical text and no intervening run remain one banner.

type FailureClass = OrchestrationV2ProviderFailureClass | null;
type Projection = Pick<ThreadStructure, "runs" | "turnItems">;

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

// A hidden banner rerenders with the same runs and history on most renders, so
// keep each run's root failure lookup instead of walking the turn items again.
const rootFailures = new WeakMap<
  OrchestrationV2Run,
  {
    readonly turnItems: Projection["turnItems"];
    readonly failure: OrchestrationV2ProviderFailure | null;
  }
>();

function rootFailure(run: OrchestrationV2Run, turnItems: Projection["turnItems"]) {
  let lookup = rootFailures.get(run);
  if (lookup?.turnItems !== turnItems) {
    lookup = { turnItems, failure: latestRootProviderFailure(run, turnItems) };
    rootFailures.set(run, lookup);
  }
  return lookup.failure;
}

/** The newest run that failed after the dismissal, with the message it failed with. */
function failureSinceDismissal(
  projection: Projection,
  dismissal: Dismissal,
  serverError: string,
  serverErrorClass: FailureClass,
): { readonly message: string; readonly errorClass: FailureClass } | null {
  // The failure the user dismissed, published on the session before its run
  // was finalised. It is skipped, not a veto: another run may still show.
  const isDismissedFailure = (run: OrchestrationV2Run) =>
    dismissal.texts.includes(rootFailure(run, projection.turnItems)?.message ?? serverError);
  let newest: OrchestrationV2Run | null = null;
  for (const run of projection.runs) {
    if (run.status !== "failed") continue;
    if (run.ordinal <= dismissal.latestOrdinal && !dismissal.unfinishedRunIds.has(run.id)) continue;
    if (run.id === dismissal.executingRunId && isDismissedFailure(run)) continue;
    if (newest === null || run.ordinal > newest.ordinal) newest = run;
  }
  if (newest === null) return null;
  const failure = rootFailure(newest, projection.turnItems);
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
