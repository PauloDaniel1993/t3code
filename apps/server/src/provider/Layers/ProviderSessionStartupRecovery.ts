import {
  CommandId,
  ProviderInstanceId,
  type PendingTurnRecoveryFailure,
  type PendingTurnRecoveryFailureCode,
  type ProviderSession,
  type ServerProvider,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  PendingTurnStartRecoveryError,
  type PendingTurnStartRecoveryInput,
} from "../../orchestration/Services/ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderValidationError } from "../Errors.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, providerStartupRecoveryTotal } from "../../observability/Metrics.ts";
import {
  ProviderSessionStartupRecovery,
  ProviderSessionStartupRecoveryError,
  type ProviderSessionStartupRecoveryReport,
  type ProviderSessionStartupRecoveryShape,
} from "../Services/ProviderSessionStartupRecovery.ts";

const isPendingTurnStartRecoveryError = Schema.is(PendingTurnStartRecoveryError);
const isProviderValidationError = Schema.is(ProviderValidationError);

const RECOVERY_INTERRUPTED_DETAIL =
  "Provider work was interrupted because its live session was not present after server restart.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runtimeActiveTurnId(runtimePayload: unknown | null): string | null {
  if (!isRecord(runtimePayload)) {
    return null;
  }
  return typeof runtimePayload.activeTurnId === "string" ? runtimePayload.activeTurnId : null;
}

function recoveryReason(
  runtimePayload: unknown | null,
): "provider-session-missing" | "terminal-event-missing" {
  if (!isRecord(runtimePayload)) {
    return "provider-session-missing";
  }
  const lastRuntimeEvent = runtimePayload.lastRuntimeEvent;
  return lastRuntimeEvent === "turn.completed" || lastRuntimeEvent === "turn.aborted"
    ? "terminal-event-missing"
    : "provider-session-missing";
}

function mergeRecoveredRuntimePayload(
  runtimePayload: unknown | null,
  recoveredAt: string,
): Record<string, unknown> {
  return {
    ...(isRecord(runtimePayload) ? runtimePayload : {}),
    activeTurnId: null,
    lastRuntimeEvent: "provider.startup-recovery",
    lastRuntimeEventAt: recoveredAt,
  };
}

function sameProviderOwner(
  live: ProviderSession,
  runtime: ProviderSessionRuntime.ProviderSessionRuntime | undefined,
  projected:
    | {
        readonly providerInstanceId: string | null;
        readonly providerName: string | null;
      }
    | undefined,
): boolean {
  const expectedInstanceId = projected?.providerInstanceId ?? runtime?.providerInstanceId ?? null;
  if (expectedInstanceId !== null) {
    return live.providerInstanceId === expectedInstanceId;
  }
  const expectedProvider = projected?.providerName ?? runtime?.providerName ?? null;
  return expectedProvider === null || live.provider === expectedProvider;
}

function liveSessionOwnsRecordedWork(input: {
  readonly live: ProviderSession | undefined;
  readonly runtime: ProviderSessionRuntime.ProviderSessionRuntime | undefined;
  readonly projected:
    | {
        readonly providerInstanceId: string | null;
        readonly providerName: string | null;
        readonly activeTurnId: string | null;
      }
    | undefined;
}): boolean {
  if (input.live === undefined || !sameProviderOwner(input.live, input.runtime, input.projected)) {
    return false;
  }
  const recordedActiveTurnId =
    input.projected?.activeTurnId ?? runtimeActiveTurnId(input.runtime?.runtimePayload ?? null);
  return recordedActiveTurnId === null || input.live.activeTurnId === recordedActiveTurnId;
}

function commandIdentityPart(value: string): string {
  return encodeURIComponent(value);
}

export function startupRecoverySessionCommandId(input: {
  readonly threadId: ThreadId;
  readonly activeTurnId: string | null;
}): CommandId {
  return CommandId.make(
    [
      "server",
      "startup-recovery",
      "session",
      commandIdentityPart(input.threadId),
      commandIdentityPart(input.activeTurnId ?? "no-active-turn"),
    ].join(":"),
  );
}

export function startupRecoveryPendingClaimCommandId(input: {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly requestedAt: string;
}): CommandId {
  return CommandId.make(
    [
      "server",
      "startup-recovery",
      "pending-claim",
      commandIdentityPart(input.threadId),
      commandIdentityPart(input.messageId),
      commandIdentityPart(input.requestedAt),
    ].join(":"),
  );
}

function startupRecoveryPendingOutcomeCommandId(input: {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly outcome: "delivered" | "failed";
}): CommandId {
  return CommandId.make(
    [
      "server",
      "startup-recovery",
      `pending-${input.outcome}`,
      commandIdentityPart(input.threadId),
      commandIdentityPart(input.messageId),
    ].join(":"),
  );
}

function recoveryFailureMessage(code: PendingTurnRecoveryFailureCode): string {
  switch (code) {
    case "provider-disabled":
      return "The pending request could not restart because its provider instance is disabled.";
    case "provider-unavailable":
      return "The pending request could not restart because its provider instance is unavailable.";
    case "provider-incompatible":
      return "The pending request could not restart because its saved provider state is incompatible.";
    case "resume-failed":
      return "The pending request could not resume its saved provider session. Retry the request manually.";
    case "start-failed":
      return "The pending request could not be delivered during startup recovery. Retry the request manually.";
  }
}

function classifyPendingRecoveryFailure(input: {
  readonly provider: ServerProvider | undefined;
  readonly runtime: ProviderSessionRuntime.ProviderSessionRuntime | undefined;
  readonly error: PendingTurnStartRecoveryError | undefined;
}): PendingTurnRecoveryFailureCode {
  if (input.error?.code === "thread-missing" || input.error?.code === "message-missing") {
    return "start-failed";
  }
  if (input.provider?.enabled === false || input.provider?.status === "disabled") {
    return "provider-disabled";
  }
  if (
    input.provider === undefined ||
    input.provider.availability === "unavailable" ||
    input.provider.installed === false ||
    input.provider.status === "error"
  ) {
    return "provider-unavailable";
  }
  const errorText = `${input.error?.message ?? ""} ${
    input.error?.cause instanceof Error ? input.error.cause.message : ""
  }`.toLowerCase();
  if (
    errorText.includes("incompatible") ||
    errorText.includes("cannot switch") ||
    (input.runtime !== undefined && input.runtime.providerName !== input.provider.driver)
  ) {
    return "provider-incompatible";
  }
  return input.runtime?.resumeCursor !== null && input.runtime?.resumeCursor !== undefined
    ? "resume-failed"
    : "start-failed";
}

type PendingTurnStartRecoveryExecutor = (input: PendingTurnStartRecoveryInput) => Effect.Effect<
  {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly resumeCursor?: unknown;
  },
  PendingTurnStartRecoveryError
>;

export const makePendingTurnStartRecoveryExecutor = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const recoverPendingTurnStart: PendingTurnStartRecoveryExecutor = Effect.fn(
    "recoverPendingTurnStartAtStartup",
  )(function* (input) {
    const thread = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getThreadDetailById(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new PendingTurnStartRecoveryError({
              code: "provider-send-failed",
              message: "Failed to read the pending thread during startup recovery.",
              cause,
            }),
        ),
      ),
    );
    if (thread === undefined) {
      return yield* new PendingTurnStartRecoveryError({
        code: "thread-missing",
        message: `Thread '${input.threadId}' was not found during pending-turn recovery.`,
      });
    }
    const message = thread.messages.find((entry) => entry.id === input.messageId);
    if (!message || message.role !== "user") {
      return yield* new PendingTurnStartRecoveryError({
        code: "message-missing",
        message: `User message '${input.messageId}' was not found during pending-turn recovery.`,
        providerInstanceId: thread.modelSelection.instanceId,
      });
    }

    const normalizedInput = message.text.trim();
    const attachments = message.attachments ?? [];
    const sendTurnInput = {
      threadId: input.threadId,
      ...(normalizedInput.length > 0 ? { input: normalizedInput } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection: thread.modelSelection,
      interactionMode: thread.interactionMode,
    } as const;
    const startFreshThenSend = Effect.gen(function* () {
      const [project, instanceInfo] = yield* Effect.all([
        projectionSnapshotQuery
          .getProjectShellById(thread.projectId)
          .pipe(Effect.map(Option.getOrUndefined)),
        providerService.getInstanceInfo(thread.modelSelection.instanceId),
      ]);
      const cwd = resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      });
      yield* providerService.startSession(input.threadId, {
        threadId: input.threadId,
        provider: instanceInfo.driverKind,
        providerInstanceId: thread.modelSelection.instanceId,
        ...(cwd ? { cwd } : {}),
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
      });
      return yield* providerService.sendTurn(sendTurnInput);
    });

    return yield* providerService.sendTurn(sendTurnInput).pipe(
      Effect.catchIf(
        (cause) =>
          isProviderValidationError(cause) && cause.issue.includes("no persisted provider binding"),
        () => startFreshThenSend,
      ),
      Effect.mapError(
        (cause) =>
          new PendingTurnStartRecoveryError({
            code: "provider-send-failed",
            message: "The provider could not resume and deliver the pending turn.",
            providerInstanceId: thread.modelSelection.instanceId,
            cause,
          }),
      ),
    );
  });

  return recoverPendingTurnStart;
});

export const makeProviderSessionStartupRecovery = (input: {
  readonly recoverPendingTurnStart: PendingTurnStartRecoveryExecutor;
  readonly pendingRecoveryTimeout?: Duration.Input;
}) =>
  Effect.gen(function* () {
    const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const projectedSessionRepository = yield* ProjectionThreadSessionRepository;
    const turnRepository = yield* ProjectionTurnRepository;
    const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
    const providerRegistry = yield* ProviderRegistry;
    const providerSessionDirectory = yield* ProviderSessionDirectory;
    const providerService = yield* ProviderService;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const runRecovery = Effect.gen(function* () {
      const [runtimeBindings, projectedSessions, runningTurns, liveSessions] = yield* Effect.all(
        [
          runtimeRepository.listActive(),
          projectedSessionRepository.listActive(),
          turnRepository.listRunningTurns(),
          providerService.listSessions(),
        ],
        { concurrency: "unbounded" },
      );

      const runtimeByThread = new Map(runtimeBindings.map((row) => [row.threadId, row] as const));
      const projectedByThread = new Map(
        projectedSessions.map((row) => [row.threadId, row] as const),
      );
      const liveByThread = new Map(liveSessions.map((row) => [row.threadId, row] as const));
      const runningTurnsByThread = new Map<ThreadId, Array<(typeof runningTurns)[number]>>();
      for (const turn of runningTurns) {
        const existing = runningTurnsByThread.get(turn.threadId);
        if (existing === undefined) {
          runningTurnsByThread.set(turn.threadId, [turn]);
        } else {
          existing.push(turn);
        }
      }
      const candidateThreadIds = new Set<ThreadId>([
        ...runtimeBindings.map((row) => row.threadId),
        ...projectedSessions.map((row) => row.threadId),
        ...runningTurns.map((row) => row.threadId),
      ]);

      let reconciledSessions = 0;
      let interruptedTurns = 0;
      let failedRecoveries = 0;
      const failedSessionRecoveryThreadIds = new Set<ThreadId>();

      for (const threadId of candidateThreadIds) {
        const runtime = runtimeByThread.get(threadId);
        const projected = projectedByThread.get(threadId);
        const live = liveByThread.get(threadId);
        if (liveSessionOwnsRecordedWork({ live, runtime, projected })) {
          continue;
        }

        yield* Effect.gen(function* () {
          const binding = yield* providerSessionDirectory.getBinding(threadId);
          if (Option.isSome(binding)) {
            yield* providerSessionDirectory.upsert({
              ...binding.value,
              status: "stopped",
              runtimePayload: { activeTurnId: null },
            });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("provider.session.startup-recovery.directory-cleanup-failed", {
                  threadId,
                  cause,
                }),
          ),
        );

        const activeTurnId =
          projected?.activeTurnId ??
          runtimeActiveTurnId(runtime?.runtimePayload ?? null) ??
          runningTurnsByThread.get(threadId)?.[0]?.turnId ??
          null;
        const recoveredAt = DateTime.formatIso(yield* DateTime.now);
        const reason = recoveryReason(runtime?.runtimePayload ?? null);

        const reconciliationExit = yield* Effect.exit(
          Effect.gen(function* () {
            yield* orchestrationEngine.dispatch({
              type: "thread.session.set",
              commandId: startupRecoverySessionCommandId({
                threadId,
                activeTurnId,
              }),
              threadId,
              session: {
                threadId,
                status: "interrupted",
                providerName: projected?.providerName ?? runtime?.providerName ?? null,
                ...(projected?.providerInstanceId !== null &&
                projected?.providerInstanceId !== undefined
                  ? { providerInstanceId: projected.providerInstanceId }
                  : runtime?.providerInstanceId !== null &&
                      runtime?.providerInstanceId !== undefined
                    ? { providerInstanceId: runtime.providerInstanceId }
                    : {}),
                runtimeMode: projected?.runtimeMode ?? runtime?.runtimeMode ?? "full-access",
                activeTurnId: null,
                lastError: RECOVERY_INTERRUPTED_DETAIL,
                recovery: {
                  state: "interrupted",
                  reason,
                  recoveredAt,
                },
                updatedAt: recoveredAt,
              },
              createdAt: recoveredAt,
            });

            if (runtime !== undefined) {
              yield* runtimeRepository.upsert({
                ...runtime,
                status: "stopped",
                lastSeenAt: recoveredAt,
                runtimePayload: mergeRecoveredRuntimePayload(runtime.runtimePayload, recoveredAt),
              });
            }
          }),
        );
        if (Exit.isFailure(reconciliationExit)) {
          failedRecoveries += 1;
          failedSessionRecoveryThreadIds.add(threadId);
          yield* Effect.logWarning("provider.session.startup-recovery.session-failed", {
            threadId,
            cause: reconciliationExit.cause,
          });
          continue;
        }

        reconciledSessions += 1;
        interruptedTurns += runningTurnsByThread.get(threadId)?.length ?? (activeTurnId ? 1 : 0);
      }

      let replayedPendingRequests = 0;
      const pendingTurnStarts = yield* turnRepository.listPendingTurnStarts();
      const providerSnapshots = yield* providerRegistry.getProviders;

      for (const pending of pendingTurnStarts) {
        const projected = Option.getOrUndefined(
          yield* projectedSessionRepository.getByThreadId({
            threadId: pending.threadId,
          }),
        );
        const runtime = Option.getOrUndefined(
          yield* runtimeRepository.getByThreadId({
            threadId: pending.threadId,
          }),
        );

        let recoveryError: PendingTurnStartRecoveryError | undefined;
        let recoveryDetailOverride: string | undefined;
        let deliveredTurnId: TurnId | undefined;
        const recordedTurnId =
          projectedByThread.get(pending.threadId)?.activeTurnId ??
          runtimeActiveTurnId(runtimeByThread.get(pending.threadId)?.runtimePayload ?? null);
        if (failedSessionRecoveryThreadIds.has(pending.threadId)) {
          recoveryDetailOverride =
            "The pending request was not replayed because stale provider state could not be reconciled.";
          recoveryError = new PendingTurnStartRecoveryError({
            code: "provider-send-failed",
            message: recoveryDetailOverride,
          });
        } else if (recordedTurnId !== null) {
          recoveryDetailOverride =
            "The request may already have reached the provider before restart, so it was not sent again.";
          recoveryError = new PendingTurnStartRecoveryError({
            code: "provider-send-failed",
            message: recoveryDetailOverride,
          });
        } else {
          const claimedAt = DateTime.formatIso(yield* DateTime.now);
          const claimCommandId = startupRecoveryPendingClaimCommandId({
            threadId: pending.threadId,
            messageId: pending.messageId,
            requestedAt: pending.requestedAt,
          });
          const claimed = yield* commandReceiptRepository.tryInsert({
            commandId: claimCommandId,
            aggregateKind: "thread",
            aggregateId: pending.threadId,
            acceptedAt: claimedAt,
            resultSequence: yield* orchestrationEngine.latestSequence,
            status: "accepted",
            error: null,
          });
          if (claimed) {
            const recoveryExit = yield* Effect.exit(
              input
                .recoverPendingTurnStart({
                  threadId: pending.threadId,
                  messageId: pending.messageId,
                })
                .pipe(Effect.timeoutOption(input.pendingRecoveryTimeout ?? Duration.seconds(30))),
            );
            if (Exit.isSuccess(recoveryExit) && Option.isSome(recoveryExit.value)) {
              deliveredTurnId = recoveryExit.value.value.turnId;
            } else if (Exit.isSuccess(recoveryExit)) {
              recoveryDetailOverride =
                "The provider did not finish recovering the pending request before the startup timeout.";
              recoveryError = new PendingTurnStartRecoveryError({
                code: "provider-send-failed",
                message: recoveryDetailOverride,
              });
            } else {
              const failureReason = recoveryExit.cause.reasons.find(Cause.isFailReason);
              recoveryError = isPendingTurnStartRecoveryError(failureReason?.error)
                ? failureReason.error
                : undefined;
            }
          } else {
            recoveryDetailOverride =
              "A previous startup claimed this pending request without recording a provider turn.";
            recoveryError = new PendingTurnStartRecoveryError({
              code: "provider-send-failed",
              message: recoveryDetailOverride,
            });
          }
        }

        if (deliveredTurnId !== undefined) {
          const deliveredAt = DateTime.formatIso(yield* DateTime.now);
          const deliveredRuntime = Option.getOrUndefined(
            yield* runtimeRepository.getByThreadId({
              threadId: pending.threadId,
            }),
          );
          const deliveredDispatchExit = yield* Effect.exit(
            orchestrationEngine.dispatch({
              type: "thread.session.set",
              commandId: startupRecoveryPendingOutcomeCommandId({
                threadId: pending.threadId,
                messageId: pending.messageId,
                outcome: "delivered",
              }),
              threadId: pending.threadId,
              session: {
                threadId: pending.threadId,
                status: "running",
                providerName: deliveredRuntime?.providerName ?? projected?.providerName ?? null,
                ...(deliveredRuntime?.providerInstanceId !== null &&
                deliveredRuntime?.providerInstanceId !== undefined
                  ? { providerInstanceId: deliveredRuntime.providerInstanceId }
                  : projected?.providerInstanceId !== null &&
                      projected?.providerInstanceId !== undefined
                    ? { providerInstanceId: projected.providerInstanceId }
                    : {}),
                runtimeMode:
                  deliveredRuntime?.runtimeMode ?? projected?.runtimeMode ?? "full-access",
                activeTurnId: deliveredTurnId,
                lastError: null,
                updatedAt: deliveredAt,
              },
              createdAt: deliveredAt,
            }),
          );
          if (Exit.isFailure(deliveredDispatchExit)) {
            failedRecoveries += 1;
            yield* Effect.logWarning("provider.session.startup-recovery.delivered-outcome-failed", {
              threadId: pending.threadId,
              cause: deliveredDispatchExit.cause,
            });
            continue;
          }
          replayedPendingRequests += 1;
          continue;
        }

        const providerInstanceId =
          recoveryError?.providerInstanceId ??
          runtime?.providerInstanceId ??
          projected?.providerInstanceId ??
          ProviderInstanceId.make("unknown");
        const providerSnapshot = providerSnapshots.find(
          (provider) => provider.instanceId === providerInstanceId,
        );
        const code = classifyPendingRecoveryFailure({
          provider: providerSnapshot,
          runtime,
          error: recoveryError,
        });
        const failedAt = DateTime.formatIso(yield* DateTime.now);
        const failure = {
          threadId: pending.threadId,
          providerInstanceId,
          code,
          message: recoveryDetailOverride ?? recoveryFailureMessage(code),
          occurredAt: failedAt,
        } satisfies PendingTurnRecoveryFailure;

        const failureDispatchExit = yield* Effect.exit(
          orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: startupRecoveryPendingOutcomeCommandId({
              threadId: pending.threadId,
              messageId: pending.messageId,
              outcome: "failed",
            }),
            threadId: pending.threadId,
            session: {
              threadId: pending.threadId,
              status: "error",
              providerName:
                runtime?.providerName ??
                projected?.providerName ??
                providerSnapshot?.driver ??
                null,
              providerInstanceId,
              runtimeMode: runtime?.runtimeMode ?? projected?.runtimeMode ?? "full-access",
              activeTurnId: null,
              lastError: failure.message,
              recovery: {
                state: "interrupted",
                reason: "unclean-shutdown",
                recoveredAt: failedAt,
                pendingTurnFailure: {
                  ...failure,
                  ...(recordedTurnId === null ? {} : { turnId: TurnId.make(recordedTurnId) }),
                },
              },
              updatedAt: failedAt,
            },
            createdAt: failedAt,
          }),
        );
        if (Exit.isFailure(failureDispatchExit)) {
          yield* Effect.logWarning("provider.session.startup-recovery.failure-outcome-failed", {
            threadId: pending.threadId,
            cause: failureDispatchExit.cause,
          });
        }
        failedRecoveries += 1;
      }

      const report = {
        reconciledSessions,
        interruptedTurns,
        replayedPendingRequests,
        failedRecoveries,
      } satisfies ProviderSessionStartupRecoveryReport;

      yield* Effect.forEach(
        [
          ["reconciled-session", report.reconciledSessions],
          ["interrupted-turn", report.interruptedTurns],
          ["replayed-pending-request", report.replayedPendingRequests],
          ["failed-recovery", report.failedRecoveries],
        ] as const,
        ([outcome, count]) =>
          count > 0 ? increment(providerStartupRecoveryTotal, { outcome }, count) : Effect.void,
        { discard: true },
      );
      yield* Effect.logInfo("provider.session.startup-recovery.complete", report);
      return report;
    });

    const run: ProviderSessionStartupRecoveryShape["run"] = runRecovery.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSessionStartupRecoveryError({
            operation: "reconcile-stale-sessions",
            cause,
          }),
      ),
    );

    return {
      run,
    } satisfies ProviderSessionStartupRecoveryShape;
  });

export const ProviderSessionStartupRecoveryLive = Layer.effect(
  ProviderSessionStartupRecovery,
  Effect.gen(function* () {
    const recoverPendingTurnStart = yield* makePendingTurnStartRecoveryExecutor;
    return yield* makeProviderSessionStartupRecovery({ recoverPendingTurnStart });
  }),
);
