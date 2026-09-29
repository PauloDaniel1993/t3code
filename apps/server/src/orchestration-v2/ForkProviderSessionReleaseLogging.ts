import type { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";

export interface IdleSessionReleaseCandidate {
  readonly runtime: Pick<
    ProviderAdapterV2SessionRuntime,
    "instanceId" | "driver" | "hasPendingBackgroundWork"
  > & {
    readonly providerSession: Pick<ProviderAdapterV2SessionRuntime["providerSession"], "status">;
  };
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
  readonly busyCount: number;
  readonly idleGeneration: number;
  readonly lastActivityAtMs: number;
  readonly pinnedSinceMs: number | null;
}

interface IdleReleaseInput {
  readonly providerSessionId: ProviderSessionId;
  readonly generation: number;
}

const logDecision = (message: string, context: Record<string, unknown>) =>
  Effect.logInfo(message).pipe(Effect.annotateLogs(context));

/**
 * Owns the fork's idle-release trace and V2's idle decision loop. The manager
 * still owns atomic removal, subscriber shutdown, scope close and persistence.
 * Create spans only after finding a live candidate, and end them before a pin
 * waits for its next idle window.
 */
export function makeLoggedIdleSessionRelease<
  Entry extends IdleSessionReleaseCandidate,
  E,
>(options: {
  readonly sessions: Ref.Ref<Map<string, Entry>>;
  readonly idleTimeoutMs: number;
  readonly maxIdlePinMs: number;
  readonly releaseEntry: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly reason: "idle_timeout";
    readonly cancelIdleFiber: false;
    readonly onlyIfIdleGeneration: number;
  }) => Effect.Effect<void, E>;
}) {
  const releaseIfStillIdle = (input: IdleReleaseInput): Effect.Effect<void> =>
    Effect.gen(function* () {
      const current = yield* Ref.get(options.sessions);
      const key = String(input.providerSessionId);
      const entry = current.get(key);
      // Keep the empty path as cheap as upstream: no clock, log, span or probe.
      if (entry === undefined) return;

      const now = yield* Clock.currentTimeMillis;
      const context = {
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
      const repeat = yield* Effect.gen(function* () {
        yield* logDecision("provider.session.release.candidate", context);
        if (entry.busyCount > 0 || entry.idleGeneration !== input.generation) {
          yield* logDecision("provider.session.release.decision", {
            ...context,
            decision: entry.busyCount > 0 ? "skip_active_turn" : "skip_stale_generation",
          });
          return false;
        }

        // Capture identity before yielding, as in V2: a replacement runtime
        // can reuse this session id while the pending-work probe is parked.
        const probedRuntime = entry.runtime;
        const hasPendingWork =
          probedRuntime.hasPendingBackgroundWork === undefined
            ? false
            : yield* probedRuntime.hasPendingBackgroundWork.pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.release.pending-work-check-failed").pipe(
                    Effect.annotateLogs({ ...context, cause }),
                    Effect.as(false),
                  ),
                ),
              );
        let decision = "stop_inactive_session";
        if (hasPendingWork) {
          const checkedAt = yield* Clock.currentTimeMillis;
          const pinnedSinceMs = entry.pinnedSinceMs ?? checkedAt;
          if (checkedAt - pinnedSinceMs < options.maxIdlePinMs) {
            const shouldContinuePin = yield* Ref.modify(options.sessions, (latest) => {
              const latestEntry = latest.get(key);
              if (
                latestEntry === undefined ||
                latestEntry.busyCount > 0 ||
                latestEntry.idleGeneration !== input.generation ||
                latestEntry.runtime !== probedRuntime
              ) {
                return [false, latest] as const;
              }
              const updated = new Map(latest);
              updated.set(key, { ...latestEntry, pinnedSinceMs });
              return [true, updated] as const;
            });
            if (!shouldContinuePin) {
              yield* logDecision("provider.session.release.decision", {
                ...context,
                decision: "skip_changed_during_background_probe",
              });
              return false;
            }
            yield* logDecision("provider.session.release.decision", {
              ...context,
              decision: "skip_background_work",
              pinnedForMs: checkedAt - pinnedSinceMs,
            });
            yield* Effect.logInfo("orchestration-v2.driver-session.idle-release-deferred", {
              providerSessionId: input.providerSessionId,
              pinnedForMs: checkedAt - pinnedSinceMs,
            });
            return true;
          }
          decision = "stop_expired_background_pin";
          yield* Effect.logWarning("orchestration-v2.driver-session.idle-release-pin-expired", {
            providerSessionId: input.providerSessionId,
            pinnedForMs: checkedAt - pinnedSinceMs,
          });
        }

        const stopContext = { ...context, decision, reason: "idle_timeout" };
        yield* logDecision("provider.session.release.decision", stopContext);
        yield* logDecision("provider.session.release.stop-requested", stopContext);
        // releaseEntry revalidates busyCount and generation atomically. A
        // successful call can be a guarded no-op, so inspect residency before
        // claiming this runtime was released.
        yield* options
          .releaseEntry({
            providerSessionId: input.providerSessionId,
            reason: "idle_timeout",
            cancelIdleFiber: false,
            onlyIfIdleGeneration: input.generation,
          })
          .pipe(
            Effect.tap(() =>
              Ref.get(options.sessions).pipe(
                Effect.flatMap((latest) => {
                  const remaining = latest.get(key);
                  return logDecision("provider.session.release.stop-completed", {
                    ...stopContext,
                    result:
                      remaining?.runtime === probedRuntime ? "skipped_changed_session" : "released",
                    currentGeneration: remaining?.idleGeneration ?? null,
                    currentBusyCount: remaining?.busyCount ?? null,
                  });
                }),
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.driver-session.idle-release-failed", {
                providerSessionId: input.providerSessionId,
                cause,
              }).pipe(Effect.annotateLogs({ ...stopContext, result: "failed" })),
            ),
          );
        return false;
      }).pipe(Effect.withSpan("provider.session.release.idle-decision", { attributes: context }));

      if (repeat) {
        // Re-arm on this fiber; scheduleIdleReleaseInternal would cancel itself.
        yield* Effect.sleep(Duration.millis(options.idleTimeoutMs));
        return yield* releaseIfStillIdle(input);
      }
    });

  return releaseIfStillIdle;
}
