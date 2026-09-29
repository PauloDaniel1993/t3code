import type { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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

export interface IdleReleaseTrace {
  /** The pin outlived its cap; the stop decision that follows names it. */
  readonly pinExpired: (pinnedForMs: number) => Effect.Effect<void>;
  readonly changedDuringBackgroundProbe: () => Effect.Effect<void>;
  readonly deferredForBackgroundWork: (pinnedForMs: number) => Effect.Effect<void>;
  readonly stopRequested: () => Effect.Effect<void>;
  readonly stopFinished: () => Effect.Effect<void>;
}

const inertTrace: IdleReleaseTrace = {
  pinExpired: () => Effect.void,
  changedDuringBackgroundProbe: () => Effect.void,
  deferredForBackgroundWork: () => Effect.void,
  stopRequested: () => Effect.void,
  stopFinished: () => Effect.void,
};

/**
 * Explains V2's idle session release: which sessions the idle timer considered,
 * why each was kept or stopped, and what the stop did. It only observes.
 * ProviderSessionManager keeps the decisions, and calls in here at each point
 * of decision, so a merge that drops a call costs a log line and never changes
 * behavior. Calls before the first decision take the manager's own session key
 * and entry lookup instead of rebuilding them here.
 *
 * Nothing is read, written or allocated when the timer finds no session: `begin`
 * returns a shared no-op trace. Each decision is a `root` span, because the idle
 * timer is forked from whichever request last touched the session and would
 * otherwise attach to a trace that ended long ago.
 */
export function makeIdleReleaseTracer<Entry extends IdleSessionReleaseCandidate>(options: {
  readonly sessions: Ref.Ref<Map<string, Entry>>;
  readonly idleTimeoutMs: number;
  readonly maxIdlePinMs: number;
}) {
  // Not Effect.fn: a named function would open a span even when there is no entry.
  const begin = (
    sessionKey: string,
    input: { readonly providerSessionId: ProviderSessionId; readonly generation: number },
    entry: Entry | undefined,
  ): Effect.Effect<IdleReleaseTrace> =>
    Effect.gen(function* () {
      if (entry === undefined) return inertTrace;

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

      const decide = (decision: string, extra: Record<string, unknown> = {}) => {
        const decided = { ...context, ...extra, decision };
        return Effect.logInfo("provider.session.release.decision").pipe(
          Effect.annotateLogs(decided),
          Effect.withSpan("provider.session.release.idle-decision", {
            root: true,
            attributes: decided,
          }),
        );
      };

      yield* Effect.logInfo("provider.session.release.candidate").pipe(
        Effect.annotateLogs(context),
      );
      if (entry.busyCount > 0 || entry.idleGeneration !== input.generation) {
        yield* decide(entry.busyCount > 0 ? "skip_active_turn" : "skip_stale_generation");
        return inertTrace;
      }

      const trace: IdleReleaseTrace = {
        pinExpired: (pinnedForMs) =>
          Effect.sync(() => {
            stopDecision = "stop_expired_background_pin";
            stopContext = { ...context, pinnedForMs };
          }),
        changedDuringBackgroundProbe: () => decide("skip_changed_during_background_probe"),
        deferredForBackgroundWork: (pinnedForMs) => decide("skip_background_work", { pinnedForMs }),
        stopRequested: () =>
          decide(stopDecision, { ...stopContext, reason: "idle_timeout" }).pipe(
            Effect.andThen(
              Effect.logInfo("provider.session.release.stop-requested").pipe(
                Effect.annotateLogs({ ...stopContext, decision: stopDecision }),
              ),
            ),
          ),
        // The manager's release can be a guarded no-op or fail (it logs its own
        // warning), so report what the entry looks like afterwards, not "success".
        stopFinished: () =>
          Ref.get(options.sessions).pipe(
            Effect.flatMap((latest) => {
              const remaining = latest.get(sessionKey);
              return Effect.logInfo("provider.session.release.stop-completed").pipe(
                Effect.annotateLogs({
                  ...stopContext,
                  decision: stopDecision,
                  result:
                    remaining?.runtime === probedRuntime ? "entry_still_resident" : "entry_removed",
                  currentGeneration: remaining?.idleGeneration ?? null,
                  currentBusyCount: remaining?.busyCount ?? null,
                }),
              );
            }),
          ),
      };
      return trace;
    });

  return { begin };
}
