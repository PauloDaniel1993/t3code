import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "../src/cloud/serviceLauncherClient.ts";
import * as ServerConfig from "../src/config.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as Keybindings from "../src/keybindings.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import {
  OrchestrationInfrastructureLayerLive,
  OrchestrationLayerLive,
} from "../src/orchestration/runtimeLayer.ts";
import * as OrchestrationEngine from "../src/orchestration/Services/OrchestrationEngine.ts";
import * as OrchestrationReactor from "../src/orchestration/Services/OrchestrationReactor.ts";
import * as ProjectionSnapshotQuery from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { DatabaseMaintenanceRuntime } from "../src/persistence/Services/DatabaseMaintenanceRuntime.ts";
import * as ProviderSessionRuntime from "../src/persistence/ProviderSessionRuntime.ts";
import * as ExternalLauncher from "../src/process/externalLauncher.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionStartupRecoveryLive } from "../src/provider/Layers/ProviderSessionStartupRecovery.ts";
import * as ProviderService from "../src/provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../src/provider/Services/ProviderSessionDirectory.ts";
import * as ProviderSessionReaper from "../src/provider/Services/ProviderSessionReaper.ts";
import * as ProviderRegistry from "../src/provider/Services/ProviderRegistry.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import * as ServerLifecycleEvents from "../src/serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../src/serverRuntimeStartup.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import * as AnalyticsService from "../src/telemetry/AnalyticsService.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project-startup-orphan");
const threadId = ThreadId.make("thread-startup-orphan");
const stoppedBindingThreadId = ThreadId.make("thread-startup-orphan-stopped-binding");
const resumeCursor = { schemaVersion: 1, sessionId: "provider-session-before-restart" };
const stoppedBindingResumeCursor = {
  schemaVersion: 1,
  sessionId: "provider-session-stopped-before-restart",
};

const readRuntimePayloadField = (payload: unknown, key: string) =>
  Predicate.isObject(payload) ? payload[key] : undefined;

const makePersistedRuntimeLayer = (dbPath: string) => {
  const persistence = makeSqlitePersistenceLive(dbPath);
  const orchestration = OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(persistence),
  );
  const directory = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntime.layer),
    Layer.provide(persistence),
  );
  return Layer.mergeAll(orchestration, directory);
};

const makeProviderSessionStartupRecoveryLayer = (
  dbPath: string,
  options?: { readonly failSessionDispatchFor?: ThreadId },
) => {
  const persistence = makeSqlitePersistenceLive(dbPath);
  const orchestrationInfrastructure = OrchestrationInfrastructureLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(persistence),
  );
  const baseOrchestrationEngine = OrchestrationEngineLive.pipe(
    Layer.provide(orchestrationInfrastructure),
  );
  const orchestrationEngine =
    options?.failSessionDispatchFor === undefined
      ? baseOrchestrationEngine
      : Layer.effect(
          OrchestrationEngine.OrchestrationEngineService,
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngine.OrchestrationEngineService;
            return {
              ...engine,
              dispatch: (command: Parameters<typeof engine.dispatch>[0], dispatchOptions) =>
                command.type === "thread.session.set" &&
                command.threadId === options.failSessionDispatchFor &&
                command.commandId.startsWith("server:startup-recovery:session:")
                  ? Effect.die(new Error("injected startup recovery dispatch failure"))
                  : engine.dispatch(command, dispatchOptions),
            } satisfies OrchestrationEngine.OrchestrationEngineService["Service"];
          }),
        ).pipe(Layer.provide(baseOrchestrationEngine));
  const orchestration = Layer.mergeAll(orchestrationInfrastructure, orchestrationEngine);
  const directory = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntime.layer),
    Layer.provide(persistence),
  );
  const runtimeRepository = ProviderSessionRuntime.layer.pipe(Layer.provide(persistence));
  return ProviderSessionStartupRecoveryLive.pipe(
    Layer.provide(runtimeRepository),
    Layer.provideMerge(directory),
    Layer.provideMerge(orchestration),
  );
};

const startupDependencies = Layer.mergeAll(
  Layer.mock(Keybindings.Keybindings)({
    start: Effect.void,
  }),
  ServerSettings.layerTest(),
  Layer.succeed(OrchestrationReactor.OrchestrationReactor, {
    start: () => Effect.void,
    drain: Effect.void,
  }),
  Layer.succeed(ProviderSessionReaper.ProviderSessionReaper, {
    start: () => Effect.void,
  }),
  Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.succeed([]),
    refresh: () => Effect.succeed([]),
    refreshInstance: () => Effect.succeed([]),
    getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
    setProviderMaintenanceActionState: () => Effect.succeed([]),
    streamChanges: Stream.empty,
  }),
  Layer.succeed(DatabaseMaintenanceRuntime, {
    finalizeStartup: Effect.void,
  }),
  ServerLifecycleEvents.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-startup-orphan")),
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make("environment-startup-orphan"),
      label: "Startup orphan test",
      version: "test",
      platform: { os: "linux", arch: "x64" },
      capabilities: {},
    } as never),
  }),
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    issueStartupPairingUrl: (baseUrl: string) => Effect.succeed(`${baseUrl}/pair`),
  }),
  Layer.mock(ExternalLauncher.ExternalLauncher)({
    launchBrowser: () => Effect.void,
  }),
  Layer.succeed(ServiceLauncherClient.ServiceLauncherClient, {
    managed: false,
    requestUpdate: () => Effect.die("unused"),
    prepareTrial: Effect.sync(() => undefined),
  }),
  Layer.succeed(
    HttpServer.HttpServer,
    HttpServer.HttpServer.of({
      address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 3773 },
      serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
    }),
  ),
  AnalyticsService.layerTest,
  Layer.succeed(ProviderService.ProviderService, {
    startSession: () => Effect.die("unused"),
    sendTurn: () => Effect.die("unused"),
    interruptTurn: () => Effect.die("unused"),
    respondToRequest: () => Effect.die("unused"),
    respondToUserInput: () => Effect.die("unused"),
    stopSession: () => Effect.die("unused"),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.die("unused"),
    getInstanceInfo: () => Effect.die("unused"),
    rollbackConversation: () => Effect.die("unused"),
    streamEvents: Stream.empty,
  }),
);

it.effect(
  "recovers persisted sessions and preserves an isolated recovery failure before command readiness",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const firstRuntime = makePersistedRuntimeLayer(config.dbPath);
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);

      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("command-create-project"),
          projectId,
          title: "Startup orphan project",
          workspaceRoot: "/tmp/startup-orphan-project",
          defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command-create-thread"),
          threadId,
          projectId,
          title: "Startup orphan thread",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("command-start-pending-turn"),
          threadId,
          message: {
            messageId: MessageId.make("message-pending-before-restart"),
            role: "user",
            text: "Persist this queued turn before restart",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("command-mark-session-starting"),
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        yield* directory.upsert({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId,
          status: "running",
          resumeCursor,
          runtimePayload: { activeTurnId: null, unrelated: "preserve-me" },
          runtimeMode: "full-access",
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command-create-stopped-binding-thread"),
          threadId: stoppedBindingThreadId,
          projectId,
          title: "Startup orphan with stopped binding",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("command-mark-stopped-binding-session-starting"),
          threadId: stoppedBindingThreadId,
          session: {
            threadId: stoppedBindingThreadId,
            status: "starting",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "persisted session metadata",
            updatedAt: createdAt,
          },
          createdAt,
        });
        yield* directory.upsert({
          threadId: stoppedBindingThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId,
          status: "stopped",
          resumeCursor: stoppedBindingResumeCursor,
          runtimePayload: { activeTurnId: "stale", unrelated: "also-preserve-me" },
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstRuntime));

      const startupLayer = ServerRuntimeStartup.layer.pipe(
        Layer.provideMerge(
          makeProviderSessionStartupRecoveryLayer(config.dbPath, {
            failSessionDispatchFor: stoppedBindingThreadId,
          }),
        ),
        Layer.provideMerge(startupDependencies),
      );

      const result = yield* Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const sql = yield* SqlClient.SqlClient;

        yield* startup.markHttpListening;
        yield* startup.awaitCommandReady;

        const restartedThread = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
        const restartedStoppedBindingThread = Option.getOrThrow(
          yield* query.getThreadDetailById(stoppedBindingThreadId),
        );
        const pendingRows = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId"
          FROM projection_turns
          WHERE thread_id IN (${threadId}, ${stoppedBindingThreadId})
            AND turn_id IS NULL
            AND state = 'pending'
        `;
        const settleExit = yield* Effect.exit(
          engine.dispatch({
            type: "thread.settle",
            commandId: CommandId.make("command-settle-after-restart"),
            threadId,
          }),
        );
        const snoozeExit = yield* Effect.exit(
          engine.dispatch({
            type: "thread.snooze",
            commandId: CommandId.make("command-snooze-after-restart"),
            threadId,
            snoozedUntil: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
          }),
        );
        const newTurnExit = yield* Effect.exit(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("command-new-turn-after-restart"),
            threadId,
            message: {
              messageId: MessageId.make("message-new-turn-after-restart"),
              role: "user",
              text: "Continue immediately after restart",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt,
          }),
        );
        const binding = Option.getOrThrow(yield* directory.getBinding(threadId));
        const stoppedBinding = Option.getOrThrow(
          yield* directory.getBinding(stoppedBindingThreadId),
        );

        return {
          sessionStatus: restartedThread.session?.status,
          activeTurnId: restartedThread.session?.activeTurnId,
          latestTurn: restartedThread.latestTurn,
          pendingTurnCount: pendingRows.length,
          settleSucceeded: Exit.isSuccess(settleExit),
          snoozeSucceeded: Exit.isSuccess(snoozeExit),
          newTurnSucceeded: Exit.isSuccess(newTurnExit),
          bindingStatus: binding.status,
          resumeCursor: binding.resumeCursor,
          runtimePayload: {
            activeTurnId: readRuntimePayloadField(binding.runtimePayload, "activeTurnId"),
            unrelated: readRuntimePayloadField(binding.runtimePayload, "unrelated"),
            lastRuntimeEvent: readRuntimePayloadField(binding.runtimePayload, "lastRuntimeEvent"),
          },
          stoppedBindingSessionStatus: restartedStoppedBindingThread.session?.status,
          stoppedBindingSessionLastError: restartedStoppedBindingThread.session?.lastError,
          stoppedBindingSessionUpdatedAt: restartedStoppedBindingThread.session?.updatedAt,
          stoppedBindingStatus: stoppedBinding.status,
          stoppedBindingResumeCursor: stoppedBinding.resumeCursor,
          stoppedBindingRuntimePayload: {
            activeTurnId: readRuntimePayloadField(stoppedBinding.runtimePayload, "activeTurnId"),
            unrelated: readRuntimePayloadField(stoppedBinding.runtimePayload, "unrelated"),
          },
        };
      }).pipe(Effect.provide(startupLayer));

      assert.deepStrictEqual(result, {
        sessionStatus: "interrupted",
        activeTurnId: null,
        latestTurn: null,
        pendingTurnCount: 0,
        settleSucceeded: true,
        snoozeSucceeded: true,
        newTurnSucceeded: true,
        bindingStatus: "stopped",
        resumeCursor,
        runtimePayload: {
          activeTurnId: null,
          unrelated: "preserve-me",
          lastRuntimeEvent: "provider.startup-recovery",
        },
        stoppedBindingSessionStatus: "starting",
        stoppedBindingSessionLastError: "persisted session metadata",
        stoppedBindingSessionUpdatedAt: createdAt,
        stoppedBindingStatus: "stopped",
        stoppedBindingResumeCursor,
        stoppedBindingRuntimePayload: {
          activeTurnId: null,
          unrelated: "also-preserve-me",
        },
      });
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-orphaned-provider-session-startup-",
        }).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
