import type { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";

import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";

export interface IdleSessionReleaseCandidate {
  readonly runtime: Pick<ProviderAdapterV2SessionRuntime, "instanceId" | "driver"> & {
    readonly providerSession: Pick<ProviderAdapterV2SessionRuntime["providerSession"], "status">;
  };
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
  readonly busyCount: number;
  readonly idleGeneration: number;
  readonly lastActivityAtMs: number;
}

/** Passes the effect's value, failure and interruption through untouched. */
type Observe = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

export interface IdleReleaseTrace {
  /** The pin outlived its cap; the stop decision that follows names it. */
  readonly pinExpired: (pinnedForMs: number) => Effect.Effect<void>;
  readonly changedDuringBackgroundProbe: () => Effect.Effect<void>;
  readonly deferredForBackgroundWork: (pinnedForMs: number) => Effect.Effect<void>;
  /** Wraps the manager's pending-work probe; a failure is logged, then still seen by the manager. */
  readonly observePendingWorkCheck: Observe;
  /** Wraps the manager's release: logs the stop decision before it and the outcome after it. */
  readonly observeStop: Observe;
}

const identity: Observe = (effect) => effect;

const inertTrace: IdleReleaseTrace = {
  pinExpired: () => Effect.void,
  changedDuringBackgroundProbe: () => Effect.void,
  deferredForBackgroundWork: () => Effect.void,
  observePendingWorkCheck: identity,
  observeStop: identity,
};
const noTrace = Effect.succeed(inertTrace);

/**
 * Telemetry must never decide whether a session is released. A logger, tracer
 * or annotation that throws is a defect; it is dropped here, and the caller
 * only ever sees an effect that succeeds. The thunk keeps even the synchronous
 * construction of the telemetry inside the guard. Interruption still passes.
 */
const safely = (telemetry: () => Effect.Effect<void>): Effect.Effect<void> =>
  Effect.suspend(telemetry).pipe(Effect.catchDefect(() => Effect.void));

/**
 * What the manager's guarded release left behind. It is a no-op, not a failure,
 * when the session became busy or active again after the idle decision.
 */
function releaseResult(
  remaining: IdleSessionReleaseCandidate | undefined,
  probedRuntime: IdleSessionReleaseCandidate["runtime"],
  expectedGeneration: number,
) {
  if (remaining?.runtime !== probedRuntime) return "entry_removed";
  if (remaining.busyCount > 0) return "skipped_session_busy";
  return remaining.idleGeneration === expectedGeneration
    ? "entry_still_resident"
    : "skipped_session_active_since_check";
}

/**
 * Explains V2's idle session release: which sessions the idle timer considered,
 * why each was kept or stopped, and what the stop did. It only observes.
 * ProviderSessionManager keeps the decisions, and calls in here at each point
 * of decision, so a merge that drops a call costs a log line and never changes
 * behavior. Calls before the first decision take the manager's own session key
 * and entry lookup instead of rebuilding them here.
 *
 * Every hook is safe by construction (see `safely`), and `begin` falls back to
 * a no-op trace if it cannot even describe the candidate. Nothing is read,
 * written or allocated when the timer finds no session: `begin` returns a
 * shared no-op trace. Each decision is a `root` span, because the idle timer is
 * forked from whichever request last touched the session and would otherwise
 * attach to a trace that ended long ago.
 *
 * Read the logs of one check by `decisionId`: candidate, one decision, and for
 * a stop the stop-requested and stop-completed pair. A probe that failed is
 * logged as `pending-work-check-failed` and marks the stop that follows with
 * `pendingWorkCheck: "failed"`.
 */
export function makeIdleReleaseTracer<Entry extends IdleSessionReleaseCandidate>(options: {
  readonly sessions: Ref.Ref<Map<string, Entry>>;
  readonly idleTimeoutMs: number;
  readonly maxIdlePinMs: number;
}) {
  const begin = (
    sessionKey: string,
    input: { readonly providerSessionId: ProviderSessionId; readonly generation: number },
    entry: Entry | undefined,
  ): Effect.Effect<IdleReleaseTrace> =>
    entry === undefined
      ? noTrace
      : Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const context: Record<string, unknown> = {
            decisionId: `${input.providerSessionId}:${input.generation}:${now}`,
            providerSessionId: input.providerSessionId,
            providerInstanceId: entry.runtime.instanceId,
            driver: entry.runtime.driver,
            threadIds: [...entry.attachedThreadIds],
            sessionStatus: entry.runtime.providerSession.status,
            evaluatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
            idleDurationMs: now - entry.lastActivityAtMs,
            inactivityThresholdMs: options.idleTimeoutMs,
            maxIdlePinMs: options.maxIdlePinMs,
            expectedGeneration: input.generation,
            generation: entry.idleGeneration,
            busyCount: entry.busyCount,
          };
          const probedRuntime = entry.runtime;
          let stopDecision = "stop_inactive_session";
          let stopContext = context;

          const decide = (decision: string, extra: Record<string, unknown> = {}) =>
            safely(() => {
              const decided = { ...context, ...extra, decision };
              return Effect.logInfo("provider.session.release.decision").pipe(
                Effect.annotateLogs(decided),
                Effect.withSpan("provider.session.release.idle-decision", {
                  root: true,
                  attributes: decided,
                }),
              );
            });

          yield* safely(() =>
            Effect.logInfo("provider.session.release.candidate").pipe(Effect.annotateLogs(context)),
          );
          if (entry.busyCount > 0 || entry.idleGeneration !== input.generation) {
            yield* decide(entry.busyCount > 0 ? "skip_active_turn" : "skip_stale_generation");
            return inertTrace;
          }

          const trace: IdleReleaseTrace = {
            pinExpired: (pinnedForMs) =>
              safely(() =>
                Effect.sync(() => {
                  stopDecision = "stop_expired_background_pin";
                  stopContext = { ...stopContext, pinnedForMs };
                }),
              ),
            changedDuringBackgroundProbe: () => decide("skip_changed_during_background_probe"),
            deferredForBackgroundWork: (pinnedForMs) =>
              decide("skip_background_work", { pinnedForMs }),
            // The manager treats a failed probe as "no pending work". Say so, or the
            // stop that follows reads as a successful negative answer.
            observePendingWorkCheck: (effect) =>
              effect.pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit)
                    ? Effect.void
                    : Cause.hasInterruptsOnly(exit.cause)
                      ? // Activity on the session cancels this timer mid-probe.
                        decide("skip_interrupted_during_background_probe")
                      : safely(() => {
                          stopContext = { ...stopContext, pendingWorkCheck: "failed" };
                          return Effect.logWarning(
                            "provider.session.release.pending-work-check-failed",
                          ).pipe(
                            Effect.annotateLogs({ ...context, cause: Cause.pretty(exit.cause) }),
                          );
                        }),
                ),
              ),
            observeStop: (effect) =>
              safely(() =>
                decide(stopDecision, { ...stopContext, reason: "idle_timeout" }).pipe(
                  Effect.andThen(
                    Effect.logInfo("provider.session.release.stop-requested").pipe(
                      Effect.annotateLogs({ ...stopContext, decision: stopDecision }),
                    ),
                  ),
                ),
              ).pipe(
                Effect.andThen(effect),
                // The manager's release can be a guarded no-op or fail, so report
                // the exit and what the entry looks like afterwards, under the
                // decision's own identifiers.
                Effect.onExit((exit) =>
                  safely(() =>
                    Ref.get(options.sessions).pipe(
                      Effect.flatMap((latest) => {
                        const remaining = latest.get(sessionKey);
                        const failed = Exit.isFailure(exit);
                        const interrupted = failed && Cause.hasInterruptsOnly(exit.cause);
                        const level = failed && !interrupted ? Effect.logWarning : Effect.logInfo;
                        return level("provider.session.release.stop-completed").pipe(
                          Effect.annotateLogs({
                            ...stopContext,
                            decision: stopDecision,
                            result: interrupted
                              ? "release_interrupted"
                              : failed
                                ? "release_failed"
                                : releaseResult(remaining, probedRuntime, input.generation),
                            currentGeneration: remaining?.idleGeneration ?? null,
                            currentBusyCount: remaining?.busyCount ?? null,
                            ...(failed && !interrupted ? { cause: Cause.pretty(exit.cause) } : {}),
                          }),
                        );
                      }),
                    ),
                  ),
                ),
              ),
          };
          return trace;
        }).pipe(Effect.catchDefect(() => noTrace));

  return { begin };
}
