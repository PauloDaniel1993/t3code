import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ServerProvider,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Duration from "effect/Duration";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { PendingTurnStartRecoveryError } from "../../orchestration/Services/ProviderCommandReactor.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  ProjectionThreadSessionRepository,
  type ProjectionThreadSession,
} from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  ProjectionTurnRepository,
  type ProjectionPendingTurnStart,
  type ProjectionTurnById,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import {
  makeProviderSessionStartupRecovery,
  startupRecoveryPendingClaimCommandId,
  startupRecoverySessionCommandId,
} from "./ProviderSessionStartupRecovery.ts";

const instanceId = ProviderInstanceId.make("kimi");
const threadId = ThreadId.make("thread-kimi-recovery");
const turnId = TurnId.make("turn-kimi-running");
const baseTime = "2026-07-23T10:00:00.000Z";

function makeRuntime(
  status: "starting" | "running" | "stopped" | "error" = "running",
): ProviderSessionRuntime.ProviderSessionRuntime {
  return {
    threadId,
    providerName: "kimi",
    providerInstanceId: instanceId,
    adapterKey: "kimi",
    runtimeMode: "full-access",
    status,
    lastSeenAt: baseTime,
    resumeCursor: { sessionId: "kimi-resume-cursor" },
    runtimePayload: {
      activeTurnId: turnId,
      lastRuntimeEvent: "turn.completed",
    },
  };
}

function makeProjectedSession(
  status: ProjectionThreadSession["status"] = "running",
): ProjectionThreadSession {
  return {
    threadId,
    status,
    providerName: "kimi",
    providerInstanceId: instanceId,
    runtimeMode: "full-access",
    activeTurnId: status === "running" ? turnId : null,
    lastError: null,
    recovery: null,
    updatedAt: baseTime,
  };
}

function makeRunningTurn(): ProjectionTurnById {
  return {
    threadId,
    turnId,
    pendingMessageId: MessageId.make("message-kimi-running"),
    sourceProposedPlanThreadId: null,
    sourceProposedPlanId: null,
    assistantMessageId: null,
    state: "running",
    requestedAt: baseTime,
    startedAt: baseTime,
    completedAt: null,
    checkpointTurnCount: null,
    checkpointRef: null,
    checkpointStatus: null,
    checkpointFiles: [],
  };
}

function makeProviderSnapshot(overrides?: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("kimi"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: baseTime,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const makeHarness = Effect.fn("makeStartupRecoveryHarness")(function* (input?: {
  readonly runtimeRows?: ReadonlyArray<ProviderSessionRuntime.ProviderSessionRuntime>;
  readonly projectedSessions?: ReadonlyArray<ProjectionThreadSession>;
  readonly runningTurns?: ReadonlyArray<ProjectionTurnById>;
  readonly pendingTurnStarts?: ReadonlyArray<ProjectionPendingTurnStart>;
  readonly liveSessions?: ReadonlyArray<ProviderSession>;
  readonly providerSnapshots?: ReadonlyArray<ServerProvider>;
  readonly pendingRecovery?: () => Effect.Effect<
    ProviderTurnStartResult,
    PendingTurnStartRecoveryError
  >;
  readonly claimedCommandIds?: ReadonlyArray<string>;
  readonly failDispatch?: (command: OrchestrationCommand) => boolean;
  readonly pendingRecoveryTimeout?: Duration.Input;
}) {
  const runtimes = yield* Ref.make([...(input?.runtimeRows ?? [makeRuntime()])]);
  const sessions = yield* Ref.make([...(input?.projectedSessions ?? [makeProjectedSession()])]);
  const turns = yield* Ref.make([...(input?.runningTurns ?? [makeRunningTurn()])]);
  const pendingTurns = yield* Ref.make([...(input?.pendingTurnStarts ?? [])]);
  const commands = yield* Ref.make<Array<OrchestrationCommand>>([]);
  const receipts = yield* Ref.make(new Set(input?.claimedCommandIds ?? []));
  const pendingRecoveryCalls = yield* Ref.make(0);

  const runtimeRepository: ProviderSessionRuntime.ProviderSessionRuntimeRepository["Service"] = {
    upsert: (row) =>
      Ref.update(runtimes, (rows) => [
        ...rows.filter((item) => item.threadId !== row.threadId),
        row,
      ]),
    getByThreadId: ({ threadId: requestedThreadId }) =>
      Ref.get(runtimes).pipe(
        Effect.map((rows) =>
          Option.fromNullishOr(rows.find((row) => row.threadId === requestedThreadId)),
        ),
      ),
    list: () => Ref.get(runtimes),
    listActive: () =>
      Ref.get(runtimes).pipe(
        Effect.map((rows) =>
          rows.filter((row) => row.status === "starting" || row.status === "running"),
        ),
      ),
    deleteByThreadId: ({ threadId: requestedThreadId }) =>
      Ref.update(runtimes, (rows) => rows.filter((row) => row.threadId !== requestedThreadId)),
  };

  const projectedSessionRepository: ProjectionThreadSessionRepository["Service"] = {
    upsert: (row) =>
      Ref.update(sessions, (rows) => [
        ...rows.filter((item) => item.threadId !== row.threadId),
        row,
      ]),
    getByThreadId: ({ threadId: requestedThreadId }) =>
      Ref.get(sessions).pipe(
        Effect.map((rows) =>
          Option.fromNullishOr(rows.find((row) => row.threadId === requestedThreadId)),
        ),
      ),
    listActive: () =>
      Ref.get(sessions).pipe(
        Effect.map((rows) =>
          rows.filter(
            (row) =>
              row.status === "starting" || row.status === "running" || row.activeTurnId !== null,
          ),
        ),
      ),
    deleteByThreadId: ({ threadId: requestedThreadId }) =>
      Ref.update(sessions, (rows) => rows.filter((row) => row.threadId !== requestedThreadId)),
  };

  const turnRepository: ProjectionTurnRepository["Service"] = {
    upsertByTurnId: (row) =>
      Ref.update(turns, (rows) => [
        ...rows.filter((item) => item.threadId !== row.threadId || item.turnId !== row.turnId),
        row,
      ]),
    replacePendingTurnStart: () => Effect.void,
    getPendingTurnStartByThreadId: ({ threadId: requestedThreadId }) =>
      Ref.get(pendingTurns).pipe(
        Effect.map((rows) =>
          Option.fromNullishOr(rows.find((row) => row.threadId === requestedThreadId)),
        ),
      ),
    listPendingTurnStarts: () => Ref.get(pendingTurns),
    deletePendingTurnStartByThreadId: ({ threadId: requestedThreadId }) =>
      Ref.update(pendingTurns, (rows) => rows.filter((row) => row.threadId !== requestedThreadId)),
    listByThreadId: ({ threadId: requestedThreadId }) =>
      Ref.get(turns).pipe(
        Effect.map((rows) => rows.filter((row) => row.threadId === requestedThreadId)),
      ),
    getByTurnId: ({ threadId: requestedThreadId, turnId: requestedTurnId }) =>
      Ref.get(turns).pipe(
        Effect.map((rows) =>
          Option.fromNullishOr(
            rows.find(
              (row) => row.threadId === requestedThreadId && row.turnId === requestedTurnId,
            ),
          ),
        ),
      ),
    listRunningTurns: () =>
      Ref.get(turns).pipe(Effect.map((rows) => rows.filter((row) => row.state === "running"))),
    clearCheckpointTurnConflict: () => Effect.void,
    deleteByThreadId: ({ threadId: requestedThreadId }) =>
      Ref.update(turns, (rows) => rows.filter((row) => row.threadId !== requestedThreadId)),
  };

  const providerService = {
    startSession: () => Effect.die("not used"),
    sendTurn: () => Effect.die("not used"),
    interruptTurn: () => Effect.die("not used"),
    respondToRequest: () => Effect.die("not used"),
    respondToUserInput: () => Effect.die("not used"),
    stopSession: () => Effect.die("not used"),
    listSessions: () => Effect.succeed(input?.liveSessions ?? []),
    getCapabilities: () => Effect.die("not used"),
    getInstanceInfo: () => Effect.die("not used"),
    rollbackConversation: () => Effect.die("not used"),
    streamEvents: Stream.empty,
  } satisfies ProviderService["Service"];

  const commandReceiptRepository: OrchestrationCommandReceiptRepository["Service"] = {
    upsert: (receipt) =>
      Ref.update(receipts, (existing) => new Set(existing).add(receipt.commandId)),
    tryInsert: (receipt) =>
      Ref.modify(receipts, (existing) => {
        if (existing.has(receipt.commandId)) {
          return [false, existing] as const;
        }
        const next = new Set(existing);
        next.add(receipt.commandId);
        return [true, next] as const;
      }),
    getByCommandId: ({ commandId }) =>
      Ref.get(receipts).pipe(
        Effect.map((existing) =>
          existing.has(commandId)
            ? Option.some({
                commandId,
                aggregateKind: "thread" as const,
                aggregateId: threadId,
                acceptedAt: baseTime,
                resultSequence: 0,
                status: "accepted" as const,
                error: null,
              })
            : Option.none(),
        ),
      ),
  };

  const recoverPendingTurnStart = () =>
    Ref.update(pendingRecoveryCalls, (count) => count + 1).pipe(
      Effect.andThen(
        input?.pendingRecovery?.() ??
          Effect.succeed({
            threadId,
            turnId: TurnId.make("turn-kimi-replayed"),
            resumeCursor: { sessionId: "kimi-resume-cursor" },
          }),
      ),
    );

  const providerRegistry = {
    getProviders: Effect.succeed(input?.providerSnapshots ?? [makeProviderSnapshot()]),
    refresh: () => Effect.succeed([]),
    refreshInstance: () => Effect.succeed([]),
    getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("not used"),
    setProviderMaintenanceActionState: () => Effect.succeed([]),
    streamChanges: Stream.empty,
  } satisfies ProviderRegistry["Service"];

  const engine = {
    readEvents: () => Stream.empty,
    dispatch: (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        if (input?.failDispatch?.(command) === true) {
          return yield* Effect.die(new Error(`dispatch failed: ${command.type}`));
        }
        yield* Ref.update(commands, (items) => [...items, command]);
        if (command.type === "thread.session.set") {
          yield* projectedSessionRepository.upsert({
            threadId: command.threadId,
            status: command.session.status,
            providerName: command.session.providerName,
            providerInstanceId: command.session.providerInstanceId ?? null,
            runtimeMode: command.session.runtimeMode,
            activeTurnId: command.session.activeTurnId,
            lastError: command.session.lastError,
            recovery: command.session.recovery ?? null,
            updatedAt: command.session.updatedAt,
          });
          yield* Ref.update(turns, (rows) =>
            rows.map((row) =>
              row.threadId === command.threadId && row.state === "running"
                ? {
                    ...row,
                    state: "interrupted" as const,
                    completedAt: command.createdAt,
                  }
                : row,
            ),
          );
          if (
            command.session.activeTurnId !== null ||
            command.session.recovery?.pendingTurnFailure !== undefined
          ) {
            yield* Ref.update(pendingTurns, (rows) =>
              rows.filter((row) => row.threadId !== command.threadId),
            );
          }
        }
        return { sequence: 1 };
      }),
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  } satisfies OrchestrationEngineService["Service"];

  const service = yield* makeProviderSessionStartupRecovery({
    recoverPendingTurnStart,
    ...(input?.pendingRecoveryTimeout === undefined
      ? {}
      : { pendingRecoveryTimeout: input.pendingRecoveryTimeout }),
  }).pipe(
    Effect.provideService(
      ProviderSessionRuntime.ProviderSessionRuntimeRepository,
      runtimeRepository,
    ),
    Effect.provideService(ProjectionThreadSessionRepository, projectedSessionRepository),
    Effect.provideService(ProjectionTurnRepository, turnRepository),
    Effect.provideService(OrchestrationCommandReceiptRepository, commandReceiptRepository),
    Effect.provideService(ProviderRegistry, providerRegistry),
    Effect.provideService(ProviderService, providerService),
    Effect.provideService(OrchestrationEngineService, engine),
  );

  return {
    service,
    runtimes,
    sessions,
    turns,
    pendingTurns,
    commands,
    receipts,
    pendingRecoveryCalls,
  };
});

it.effect("interrupts unmatched work idempotently while preserving the Kimi resume cursor", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();

    const first = yield* harness.service.run;
    const second = yield* harness.service.run;

    assert.deepStrictEqual(first, {
      reconciledSessions: 1,
      interruptedTurns: 1,
      replayedPendingRequests: 0,
      failedRecoveries: 0,
    });
    assert.deepStrictEqual(second, {
      reconciledSessions: 0,
      interruptedTurns: 0,
      replayedPendingRequests: 0,
      failedRecoveries: 0,
    });

    const runtime = (yield* Ref.get(harness.runtimes))[0];
    assert.strictEqual(runtime?.status, "stopped");
    assert.deepStrictEqual(runtime?.resumeCursor, { sessionId: "kimi-resume-cursor" });
    assert.deepStrictEqual(
      runtime === undefined
        ? undefined
        : (runtime.runtimePayload as Record<string, unknown>).activeTurnId,
      null,
    );

    const projected = (yield* Ref.get(harness.sessions))[0];
    assert.strictEqual(projected?.status, "interrupted");
    assert.strictEqual(projected?.activeTurnId, null);
    assert.strictEqual(projected?.recovery?.reason, "terminal-event-missing");
    assert.strictEqual((yield* Ref.get(harness.turns))[0]?.state, "interrupted");

    const commands = yield* Ref.get(harness.commands);
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(yield* Ref.get(harness.pendingRecoveryCalls), 0);
    assert.strictEqual(
      commands[0]?.commandId,
      startupRecoverySessionCommandId({
        threadId,
        activeTurnId: turnId,
      }),
    );
    assert.ok(
      (yield* Metric.snapshot).some(
        (snapshot) =>
          snapshot.id === "t3_provider_startup_recovery_total" &&
          snapshot.attributes?.outcome === "interrupted-turn",
      ),
    );
  }),
);

it.effect("leaves live-owned work and cleanly stopped sessions unchanged", () =>
  Effect.gen(function* () {
    const stoppedRuntime = makeRuntime("stopped");
    const stoppedSession = makeProjectedSession("stopped");
    const liveSession: ProviderSession = {
      provider: ProviderDriverKind.make("kimi"),
      providerInstanceId: instanceId,
      status: "running",
      runtimeMode: "full-access",
      threadId,
      activeTurnId: turnId,
      createdAt: baseTime,
      updatedAt: baseTime,
    };
    const harness = yield* makeHarness({
      runtimeRows: [makeRuntime(), stoppedRuntime],
      projectedSessions: [makeProjectedSession(), stoppedSession],
      runningTurns: [makeRunningTurn()],
      liveSessions: [liveSession],
    });

    const report = yield* harness.service.run;

    assert.strictEqual(report.reconciledSessions, 0);
    assert.strictEqual((yield* Ref.get(harness.commands)).length, 0);
    assert.strictEqual((yield* Ref.get(harness.runtimes))[0]?.status, "running");
    assert.strictEqual(
      (yield* Ref.get(harness.runtimes)).find((row) => row.status === "stopped")?.lastSeenAt,
      baseTime,
    );
    assert.strictEqual(
      (yield* Ref.get(harness.sessions)).find((row) => row.status === "stopped")?.recovery,
      null,
    );
  }),
);

it.effect("claims and replays a never-delivered pending request exactly once", () =>
  Effect.gen(function* () {
    const pendingMessageId = MessageId.make("message-kimi-pending");
    const pending = {
      threadId,
      messageId: pendingMessageId,
      sourceProposedPlanThreadId: null,
      sourceProposedPlanId: null,
      requestedAt: baseTime,
    } satisfies ProjectionPendingTurnStart;
    const harness = yield* makeHarness({
      runtimeRows: [makeRuntime("stopped")],
      projectedSessions: [makeProjectedSession("interrupted")],
      runningTurns: [],
      pendingTurnStarts: [pending],
    });

    const first = yield* harness.service.run;

    assert.strictEqual(first.replayedPendingRequests, 1);
    assert.strictEqual(first.failedRecoveries, 0);
    assert.strictEqual(yield* Ref.get(harness.pendingRecoveryCalls), 1);
    assert.deepStrictEqual(yield* Ref.get(harness.pendingTurns), []);
    assert.strictEqual(
      (yield* Ref.get(harness.sessions))[0]?.activeTurnId,
      TurnId.make("turn-kimi-replayed"),
    );
    assert.strictEqual((yield* Ref.get(harness.sessions))[0]?.status, "running");
    assert.ok(
      (yield* Ref.get(harness.receipts)).has(
        startupRecoveryPendingClaimCommandId({
          threadId,
          messageId: pendingMessageId,
          requestedAt: baseTime,
        }),
      ),
    );

    const second = yield* harness.service.run;
    assert.strictEqual(second.replayedPendingRequests, 0);
    assert.strictEqual(yield* Ref.get(harness.pendingRecoveryCalls), 1);
  }),
);

it.effect("maps an unavailable pending recovery to a visible typed terminal error", () =>
  Effect.gen(function* () {
    const pendingMessageId = MessageId.make("message-kimi-disabled");
    const harness = yield* makeHarness({
      runtimeRows: [makeRuntime("stopped")],
      projectedSessions: [makeProjectedSession("interrupted")],
      runningTurns: [],
      pendingTurnStarts: [
        {
          threadId,
          messageId: pendingMessageId,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt: baseTime,
        },
      ],
      providerSnapshots: [
        makeProviderSnapshot({
          enabled: false,
          status: "disabled",
        }),
      ],
      pendingRecovery: () =>
        Effect.fail(
          new PendingTurnStartRecoveryError({
            code: "provider-send-failed",
            message: "Provider is disabled.",
            providerInstanceId: instanceId,
          }),
        ),
    });

    const report = yield* harness.service.run;
    const session = (yield* Ref.get(harness.sessions))[0];

    assert.strictEqual(report.replayedPendingRequests, 0);
    assert.strictEqual(report.failedRecoveries, 1);
    assert.strictEqual(session?.status, "error");
    assert.strictEqual(session?.recovery?.pendingTurnFailure?.code, "provider-disabled");
    assert.deepStrictEqual(yield* Ref.get(harness.pendingTurns), []);
  }),
);

it.effect("classifies an unavailable provider instance without exposing its failure cause", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      runtimeRows: [makeRuntime("stopped")],
      projectedSessions: [makeProjectedSession("interrupted")],
      runningTurns: [],
      pendingTurnStarts: [
        {
          threadId,
          messageId: MessageId.make("message-kimi-unavailable"),
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt: baseTime,
        },
      ],
      providerSnapshots: [
        makeProviderSnapshot({
          availability: "unavailable",
          unavailableReason: "Driver unavailable",
          status: "error",
        }),
      ],
      pendingRecovery: () =>
        Effect.fail(
          new PendingTurnStartRecoveryError({
            code: "provider-send-failed",
            message: "native failure with private process details",
            providerInstanceId: instanceId,
          }),
        ),
    });

    yield* harness.service.run;
    const failure = (yield* Ref.get(harness.sessions))[0]?.recovery?.pendingTurnFailure;

    assert.strictEqual(failure?.code, "provider-unavailable");
    assert.notInclude(failure?.message ?? "", "private process details");
  }),
);

it.effect("does not resend a pending request claimed before a repeated crash", () =>
  Effect.gen(function* () {
    const pendingMessageId = MessageId.make("message-kimi-claimed");
    const claimId = startupRecoveryPendingClaimCommandId({
      threadId,
      messageId: pendingMessageId,
      requestedAt: baseTime,
    });
    const harness = yield* makeHarness({
      runtimeRows: [makeRuntime("stopped")],
      projectedSessions: [makeProjectedSession("interrupted")],
      runningTurns: [],
      pendingTurnStarts: [
        {
          threadId,
          messageId: pendingMessageId,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt: baseTime,
        },
      ],
      claimedCommandIds: [claimId],
    });

    const report = yield* harness.service.run;

    assert.strictEqual(report.failedRecoveries, 1);
    assert.strictEqual(yield* Ref.get(harness.pendingRecoveryCalls), 0);
    assert.deepStrictEqual(yield* Ref.get(harness.pendingTurns), []);
  }),
);

it.effect("settles a turns-only recovery candidate instead of recounting it forever", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      runtimeRows: [],
      projectedSessions: [],
      runningTurns: [makeRunningTurn()],
    });

    const first = yield* harness.service.run;
    const second = yield* harness.service.run;

    assert.deepStrictEqual(first, {
      reconciledSessions: 1,
      interruptedTurns: 1,
      replayedPendingRequests: 0,
      failedRecoveries: 0,
    });
    assert.strictEqual((yield* Ref.get(harness.turns))[0]?.state, "interrupted");
    assert.strictEqual(second.reconciledSessions, 0);
  }),
);

it.effect("isolates reconciliation dispatch failure and completes the recovery pass", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      failDispatch: () => true,
    });

    const report = yield* harness.service.run;

    assert.deepStrictEqual(report, {
      reconciledSessions: 0,
      interruptedTurns: 0,
      replayedPendingRequests: 0,
      failedRecoveries: 1,
    });
    assert.strictEqual((yield* Ref.get(harness.runtimes))[0]?.status, "running");
  }),
);

it.effect("does not replay a pending row when persisted state already names a provider turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      pendingTurnStarts: [
        {
          threadId,
          messageId: MessageId.make("message-already-delivered"),
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt: baseTime,
        },
      ],
    });

    const report = yield* harness.service.run;
    const failure = (yield* Ref.get(harness.sessions))[0]?.recovery?.pendingTurnFailure;

    assert.strictEqual(yield* Ref.get(harness.pendingRecoveryCalls), 0);
    assert.strictEqual(report.failedRecoveries, 1);
    assert.strictEqual(failure?.turnId, turnId);
    assert.include(failure?.message ?? "", "not sent again");
    assert.deepStrictEqual(yield* Ref.get(harness.pendingTurns), []);
  }),
);

it.effect("times out hung pending provider recovery without blocking startup", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      runtimeRows: [makeRuntime("stopped")],
      projectedSessions: [makeProjectedSession("interrupted")],
      runningTurns: [],
      pendingTurnStarts: [
        {
          threadId,
          messageId: MessageId.make("message-timeout"),
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt: baseTime,
        },
      ],
      pendingRecovery: () => Effect.never,
      pendingRecoveryTimeout: 0,
    });

    const report = yield* harness.service.run;
    const failure = (yield* Ref.get(harness.sessions))[0]?.recovery?.pendingTurnFailure;

    assert.strictEqual(report.failedRecoveries, 1);
    assert.include(failure?.message ?? "", "startup timeout");
  }),
);
