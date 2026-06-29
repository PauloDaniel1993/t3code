// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/no-manual-effect-runtime-in-tests
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@t3tools/contracts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration, type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderCommandReactorLive } from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

// A tagged error for the simulated dispatch failure: a global `Error` in the
// Effect failure channel is disallowed (untagged errors merge together).
class SimulatedDispatchError extends Data.TaggedError("SimulatedDispatchError")<{
  readonly message: string;
}> {}
import * as Clock from "effect/Clock";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

const TARGET_THREAD = ThreadId.make("thread-2");
const TARGET_MODEL_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-sonnet-4-5",
};

type SendTurnRequest = {
  readonly threadId?: ThreadId;
  readonly input?: string;
};

type OrchestrationEngineShape = OrchestrationEngineService["Service"];
type OrchestrationDispatchEffect = ReturnType<OrchestrationEngineShape["dispatch"]>;

describe("ProviderCommandReactor handoff bootstrap wrapping", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderCommandReactor | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  // Mirrors createHarness in ProviderCommandReactor.test.ts. Replicated here (the
  // original is module-private) with an optional engine-dispatch interceptor so the
  // retry-of-completion path can be exercised deterministically.
  async function createHarness(input?: {
    readonly interceptDispatch?: (
      command: OrchestrationCommand,
      forward: () => OrchestrationDispatchEffect,
    ) => OrchestrationDispatchEffect;
  }) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-handoff-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSession = vi.fn((_: unknown, startInput: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof startInput === "object" && startInput !== null && "resumeCursor" in startInput
          ? startInput.resumeCursor
          : undefined;
      const threadId =
        typeof startInput === "object" &&
        startInput !== null &&
        "threadId" in startInput &&
        typeof startInput.threadId === "string"
          ? ThreadId.make(startInput.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof startInput === "object" && startInput !== null && "modelSelection" in startInput
          ? (startInput.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof startInput === "object" && startInput !== null && "providerInstanceId" in startInput
          ? (startInput.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof startInput === "object" &&
        startInput !== null &&
        "provider" in startInput &&
        typeof startInput.provider === "string"
          ? (startInput.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeMode:
          typeof startInput === "object" &&
          startInput !== null &&
          "runtimeMode" in startInput &&
          (startInput.runtimeMode === "approval-required" ||
            startInput.runtimeMode === "full-access")
            ? startInput.runtimeMode
            : "full-access",
        ...(typeof startInput === "object" &&
        startInput !== null &&
        "cwd" in startInput &&
        typeof startInput.cwd === "string"
          ? { cwd: startInput.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      runtimeSessions.push(session);
      return Effect.succeed(session);
    });
    let nextTurnIndex = 1;
    const sendTurn = vi.fn((request: unknown) => {
      const turnIndex = nextTurnIndex++;
      const threadId =
        typeof request === "object" &&
        request !== null &&
        "threadId" in request &&
        typeof request.threadId === "string"
          ? ThreadId.make(request.threadId)
          : ThreadId.make("thread-1");
      return Effect.succeed({
        threadId,
        turnId: asTurnId(`turn-${turnIndex}`),
      });
    });
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn((stopInput: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof stopInput === "object" && stopInput !== null && "threadId" in stopInput
            ? (stopInput as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((renameInput: unknown) =>
      Effect.succeed({
        branch:
          typeof renameInput === "object" &&
          renameInput !== null &&
          "newBranch" in renameInput &&
          typeof renameInput.newBranch === "string"
            ? renameInput.newBranch
            : "renamed-branch",
      }),
    );
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    );
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateHandoffSummary = vi.fn<TextGenerationShape["generateHandoffSummary"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateHandoffSummary",
          detail: "disabled in test harness",
        }),
      ),
    );
    const providerSnapshots = [{ instanceId: modelSelection.instanceId }];

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: "in-session",
        }),
      getInstanceInfo: (instanceId) => {
        const raw = String(instanceId);
        const driverKind = ProviderDriverKind.make(
          raw.startsWith("claude") ? "claudeAgent" : raw.startsWith("codex") ? "codex" : raw,
        );
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey:
              driverKind === ProviderDriverKind.make("codex")
                ? "codex:home:/shared-codex"
                : `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const baseOrchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const interceptDispatch = input?.interceptDispatch;
    const orchestrationLayer =
      interceptDispatch === undefined
        ? baseOrchestrationLayer
        : Layer.effect(
            OrchestrationEngineService,
            Effect.gen(function* () {
              const inner = yield* OrchestrationEngineService;
              return OrchestrationEngineService.of({
                ...inner,
                dispatch: (command) => interceptDispatch(command, () => inner.dispatch(command)),
              });
            }),
          ).pipe(Layer.provideMerge(baseOrchestrationLayer));
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never)),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          renameBranch,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.die("refreshLocalStatus should not be called in this test"),
          refreshStatus,
          streamStatus: () => Stream.die("streamStatus should not be called in this test"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
          generateHandoffSummary,
        }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      startSession,
      sendTurn,
      generateHandoffSummary,
      runtimeSessions,
      drain,
    };
  }

  type Harness = Awaited<ReturnType<typeof createHarness>>;

  // Seeds a source thread turn and an unbootstrapped target handoff thread, then
  // waits until the target handoff is projected as pending.
  async function seedPendingHandoff(harness: Harness): Promise<void> {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-source"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("source-user-message-1"),
          role: "user",
          text: "Investigate provider handoff bootstrap.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.handoff.create",
        commandId: CommandId.make("cmd-handoff-create"),
        sourceThreadId: ThreadId.make("thread-1"),
        targetThreadId: TARGET_THREAD,
        targetModelSelection: TARGET_MODEL_SELECTION,
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return readModel.threads.some(
        (entry) =>
          entry.id === TARGET_THREAD &&
          entry.handoff !== null &&
          entry.handoff.bootstrapStatus === "pending",
      );
    });
  }

  async function startTargetTurn(
    harness: Harness,
    options: { readonly commandId: string; readonly messageId: string; readonly text: string },
  ): Promise<void> {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(options.commandId),
        threadId: TARGET_THREAD,
        message: {
          messageId: asMessageId(options.messageId),
          role: "user",
          text: options.text,
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
  }

  const targetSendTurnCalls = (harness: Harness): ReadonlyArray<SendTurnRequest> =>
    harness.sendTurn.mock.calls
      .map((call) => call[0] as SendTurnRequest)
      .filter((request) => request?.threadId === TARGET_THREAD);

  it("wraps only the first native target turn (one-shot)", async () => {
    const harness = await createHarness();
    await seedPendingHandoff(harness);

    const firstPrompt = "Continue from the imported context with Claude.";
    await startTargetTurn(harness, {
      commandId: "cmd-turn-start-target-1",
      messageId: "target-user-message-1",
      text: firstPrompt,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    // Wait for the bootstrap to be marked completed so the next turn is no longer
    // a candidate for wrapping.
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === TARGET_THREAD)?.handoff?.bootstrapStatus ===
        "completed"
      );
    });

    const secondPrompt = "Now tighten the retry backoff.";
    await startTargetTurn(harness, {
      commandId: "cmd-turn-start-target-2",
      messageId: "target-user-message-2",
      text: secondPrompt,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 3);

    const targetCalls = targetSendTurnCalls(harness);
    expect(targetCalls).toHaveLength(2);
    // First wrapped turn carries the handoff context envelope.
    expect(targetCalls[0]?.input).toContain("<handoff_context>");
    expect(targetCalls[0]?.input).toContain(firstPrompt);
    // Second turn is sent verbatim, never re-wrapped.
    expect(targetCalls[1]?.input).not.toContain("<handoff_context>");
    expect(targetCalls[1]?.input).toBe(secondPrompt);
  });

  it("does not transfer any source resume cursor to the target session", async () => {
    const harness = await createHarness();
    await seedPendingHandoff(harness);

    await startTargetTurn(harness, {
      commandId: "cmd-turn-start-target-nocursor",
      messageId: "target-user-message-nocursor",
      text: "Continue with Claude.",
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    const targetStart = harness.startSession.mock.calls.find((call) => call[0] === TARGET_THREAD);
    expect(targetStart).toBeDefined();
    // Fresh target session: no resume cursor passed, so it cannot inherit the
    // source provider's cursor (source resume-1 stays on thread-1).
    const startArgs = targetStart?.[1] as { readonly resumeCursor?: unknown } | undefined;
    expect(startArgs).toBeDefined();
    expect(startArgs && "resumeCursor" in startArgs).toBe(false);

    // The source session still holds its own resume cursor; nothing transferred.
    const sourceSession = harness.runtimeSessions.find(
      (session) => session.threadId === ThreadId.make("thread-1"),
    );
    expect(sourceSession?.resumeCursor).toEqual({ opaque: "resume-1" });
  });

  it("wraps exactly once when two target turns are dispatched back-to-back", async () => {
    const harness = await createHarness();
    await seedPendingHandoff(harness);

    // Enqueue two native target turns before draining; the in-flight guard keyed
    // by target thread id must wrap only the first.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-concurrent-1"),
        threadId: TARGET_THREAD,
        message: {
          messageId: asMessageId("target-concurrent-1"),
          role: "user",
          text: "First concurrent prompt.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-concurrent-2"),
        threadId: TARGET_THREAD,
        message: {
          messageId: asMessageId("target-concurrent-2"),
          role: "user",
          text: "Second concurrent prompt.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );

    await waitFor(() => targetSendTurnCalls(harness).length === 2);
    await harness.drain();

    const wrappedCalls = targetSendTurnCalls(harness).filter((request) =>
      request?.input?.includes("<handoff_context>"),
    );
    expect(wrappedCalls).toHaveLength(1);

    const readModel = await harness.readModel();
    const targetThread = readModel.threads.find((entry) => entry.id === TARGET_THREAD);
    // Exactly one of the two native messages becomes the bootstrap message.
    expect(targetThread?.handoff?.bootstrapMessageId).toBe(asMessageId("target-concurrent-1"));
  });

  it("completes the bootstrap idempotently and never re-wraps after completion", async () => {
    const harness = await createHarness();
    await seedPendingHandoff(harness);

    await startTargetTurn(harness, {
      commandId: "cmd-turn-start-idempotent",
      messageId: "target-idempotent-1",
      text: "Continue with Claude.",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === TARGET_THREAD)?.handoff?.bootstrapStatus ===
        "completed"
      );
    });

    const completedReadModel = await harness.readModel();
    const completedThread = completedReadModel.threads.find((entry) => entry.id === TARGET_THREAD);
    expect(completedThread?.handoff).toMatchObject({
      bootstrapStatus: "completed",
      bootstrapMessageId: asMessageId("target-idempotent-1"),
    });

    // Replaying the deterministic completion command (same commandId) is a no-op:
    // command receipts dedupe it, and the handoff stays completed.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.handoff.bootstrap.complete",
        commandId: CommandId.make(
          `server:handoff-bootstrap-complete:${TARGET_THREAD}:target-idempotent-1`,
        ),
        threadId: TARGET_THREAD,
        bootstrapMessageId: asMessageId("target-idempotent-1"),
        providerTurnId: "turn-2",
        completedAt: "2026-01-01T00:00:05.000Z",
      }),
    );

    const replayReadModel = await harness.readModel();
    const replayThread = replayReadModel.threads.find((entry) => entry.id === TARGET_THREAD);
    expect(replayThread?.handoff?.bootstrapStatus).toBe("completed");
    expect(replayThread?.handoff?.bootstrapMessageId).toBe(asMessageId("target-idempotent-1"));

    // A later native turn after completion is sent verbatim (no re-wrap).
    await startTargetTurn(harness, {
      commandId: "cmd-turn-start-after-complete",
      messageId: "target-after-complete",
      text: "Verbatim follow-up.",
    });
    await waitFor(() => targetSendTurnCalls(harness).length === 2);
    const targetCalls = targetSendTurnCalls(harness);
    expect(targetCalls[1]?.input).toBe("Verbatim follow-up.");
  });

  it("retries the bootstrap completion dispatch after an initial failure", async () => {
    let bootstrapCompleteAttempts = 0;
    const harness = await createHarness({
      interceptDispatch: (command, forward) => {
        if (command.type !== "thread.handoff.bootstrap.complete") {
          return forward();
        }
        // Decide on each execution (Effect.suspend), not when the effect value is
        // built, so a retry of the same effect re-evaluates the attempt counter.
        return Effect.suspend((): OrchestrationDispatchEffect => {
          bootstrapCompleteAttempts += 1;
          if (bootstrapCompleteAttempts === 1) {
            return Effect.fail(
              new SimulatedDispatchError({ message: "simulated completion dispatch failure" }),
            ) as unknown as OrchestrationDispatchEffect;
          }
          return forward();
        });
      },
    });
    await seedPendingHandoff(harness);

    await startTargetTurn(harness, {
      commandId: "cmd-turn-start-retry",
      messageId: "target-retry-1",
      text: "Continue with Claude.",
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    // The reactor retries the completion dispatch (Schedule.spaced(2s)) until it
    // succeeds; the second attempt lands and the handoff reaches completed.
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === TARGET_THREAD)?.handoff?.bootstrapStatus ===
        "completed"
      );
    });

    expect(bootstrapCompleteAttempts).toBeGreaterThanOrEqual(2);
    // The wrapped turn was sent exactly once even though completion was retried.
    expect(targetSendTurnCalls(harness)).toHaveLength(1);
    expect(targetSendTurnCalls(harness)[0]?.input).toContain("<handoff_context>");
  });
});
