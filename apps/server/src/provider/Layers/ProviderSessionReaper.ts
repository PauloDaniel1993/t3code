import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { forkParked } from "../../serverActivation.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const logLifecycleInfo = (message: string, context: Record<string, unknown>) =>
      Effect.logInfo(message).pipe(Effect.annotateLogs(context));

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const evaluatedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
        const decisionId = `${binding.threadId}:${now}`;
        const candidateContext = {
          decisionId,
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId: binding.providerInstanceId ?? null,
          adapterKey: binding.adapterKey ?? null,
          bindingStatus: binding.status ?? null,
          runtimeMode: binding.runtimeMode ?? null,
          lastSeenAt: binding.lastSeenAt,
          evaluatedAt,
          idleDurationMs,
          inactivityThresholdMs,
        };
        yield* logLifecycleInfo("provider.session.reaper.candidate", candidateContext);

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          yield* logLifecycleInfo("provider.session.reaper.decision", {
            ...candidateContext,
            decision: "skip_active_turn",
            projectionFound: thread !== undefined,
            sessionStatus: thread.session.status,
            activeTurnId: thread.session.activeTurnId,
            sessionUpdatedAt: thread.session.updatedAt,
          });
          continue;
        }

        const stopContext = {
          ...candidateContext,
          decision: "stop_inactive_session",
          projectionFound: thread !== undefined,
          sessionStatus: thread?.session?.status ?? null,
          activeTurnId: thread?.session?.activeTurnId ?? null,
          sessionUpdatedAt: thread?.session?.updatedAt ?? null,
        };
        yield* logLifecycleInfo("provider.session.reaper.decision", stopContext);
        yield* logLifecycleInfo("provider.session.reaper.stop-requested", stopContext);

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            logLifecycleInfo("provider.session.reaped", {
              ...stopContext,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed").pipe(
              Effect.annotateLogs({
                ...stopContext,
                cause,
              }),
              Effect.as(false),
            ),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    }).pipe(
      Effect.withSpan("provider.session.reaper.sweep", {
        root: true,
        attributes: {
          inactivityThresholdMs,
          sweepIntervalMs,
        },
      }),
    );

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
