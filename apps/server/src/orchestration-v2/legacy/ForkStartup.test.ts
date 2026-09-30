import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ExecutionEnvironmentDescriptor, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as NetAddress from "effect/unstable/net/NetAddress";

import { ServerConfig, layerTest as configLayer } from "../../config.ts";
import { ServerRuntimeStartup, layerWithOptions } from "../../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerLifecycleEvents } from "../../serverLifecycleEvents.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ServiceLauncherClient } from "../../cloud/serviceLauncherClient.ts";
import { Keybindings } from "../../keybindings.ts";
import { AgentAwarenessRelay } from "../../relay/AgentAwarenessRelay.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { ExternalLauncher } from "../../process/externalLauncher.ts";
import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ThreadLaunchService } from "../ThreadLaunchService.ts";
import { ThreadManagementService } from "../ThreadManagementService.ts";
import { OrchestrationEffectWorkerV2 } from "../EffectWorker.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import { ProviderRuntimeRecoveryService } from "../ProviderRuntimeRecoveryService.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { TestLayer, seedThreads, seedUnpatchedImport, stamp } from "./ForkDataCarryOver.testkit.ts";

const summary = {
  terminalizedRuns: 0,
  stoppedSessions: 0,
  closedRequests: 0,
  retiredEffects: 0,
  requeuedEffects: 0,
};
const environment = Schema.decodeSync(ExecutionEnvironmentDescriptor)({
  environmentId: "test",
  label: "Test",
  platform: { os: "windows", arch: "x64" },
  serverVersion: "test",
  capabilities: {},
});

// Use the actual startup service, including command admission, project decoding
// and background hydration. Only unrelated host/provider side effects are mocked.
const hostLayer = Layer.mergeAll(
  Layer.mock(Keybindings)({ start: Effect.void }),
  ServerSettingsService.layerTest(),
  Layer.mock(ServerEnvironment)({ getDescriptor: Effect.succeed(environment) }),
  Layer.mock(ServiceLauncherClient)({ managed: false, prepareTrial: Effect.succeed(undefined) }),
  Layer.mock(AgentAwarenessRelay)({ start: () => Effect.void }),
  Layer.mock(ProviderSessionManagerV2)({ shutdown: Effect.void }),
  Layer.mock(OrchestrationEffectWorkerV2)({ runOnce: Effect.never }),
  Layer.mock(GitVcsDriver)({}),
  Layer.mock(ExternalLauncher)({}),
  Layer.mock(EnvironmentAuth)({}),
  Layer.mock(AnalyticsService)({}),
  Layer.mock(ProjectService)({}),
  Layer.mock(ThreadLaunchService)({}),
  Layer.mock(ThreadManagementService)({}),
  Layer.mock(HttpServer.HttpServer)({
    address: NetAddress.inetAddressUnsafe(NetAddress.ipv4Loopback, 0),
  }),
);

const databaseLayer = Layer.mergeAll(
  TestLayer,
  configLayer(process.cwd(), { prefix: "t3-fork-startup-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

/** The real startup service; `hydration` resolves when background import completes. */
const startupLayer = (
  config: ServerConfig["Service"],
  recover: ProviderRuntimeRecoveryService["Service"]["recover"],
  hydration: Deferred.Deferred<void>,
) =>
  layerWithOptions().pipe(
    Layer.provide(hostLayer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ServerConfig, { ...config, mode: "desktop", noBrowser: true }),
        Layer.mock(ProviderRuntimeRecoveryService)({
          recover,
          prepareForShutdown: Effect.void,
          reconcile: () => Effect.succeed(summary),
        }),
        Layer.mock(ServerLifecycleEvents)({
          publish: (event) =>
            Effect.gen(function* () {
              if (event.type === "legacyThreadMigration" && event.payload.status === "complete")
                yield* Deferred.succeed(hydration, undefined);
              return { ...event, sequence: 1 };
            }),
        }),
      ),
    ),
  );

for (const failure of [
  "none",
  "orphan",
  "cycle",
  "bad-message",
  "shell-unpatched",
  "partial-unpatched",
  "complete-unpatched",
] as const) {
  it.effect(`real startup ${failure}: repair precedes recovery and command admission`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStoreV2;
      const hydration = yield* Deferred.make<void>();
      let recovered = false;
      if (failure === "shell-unpatched") yield* seedUnpatchedImport("shell");
      else if (failure === "partial-unpatched") yield* seedUnpatchedImport("partial");
      else if (failure === "complete-unpatched") yield* seedUnpatchedImport("complete");
      else {
        yield* seedThreads([
          ["root", null],
          ["valid", "root"],
          ...(failure === "orphan"
            ? [["broken", "missing"] as const]
            : failure === "cycle"
              ? [["broken", "other"] as const, ["other", "broken"] as const]
              : []),
        ]);
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, source, is_streaming, created_at, updated_at)
        VALUES ('reasoning', 'valid', 'reasoning', 'thinking', 'provider', 0, ${stamp}, ${stamp})`;
        if (failure === "bad-message")
          yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, source, attachments_json, is_streaming, created_at, updated_at)
          VALUES ('bad-message', 'valid', 'user', 'still readable', 'future-source', '{broken', 0, ${stamp}, ${stamp})`;
      }
      const recover = Effect.gen(function* () {
        assert.equal(
          (yield* projections.getThread(ThreadId.make("valid"))).lineage.parentThreadId,
          "root",
        );
        const parent = yield* projections.getThreadProjection(ThreadId.make("root"));
        assert.equal(parent.subagents[0]?.childThreadId, "valid");
        recovered = true;
        return summary;
      }).pipe(Effect.orDie);
      const config = yield* ServerConfig;
      yield* Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup;
        yield* startup.markHttpListening;
        if (failure.endsWith("unpatched")) {
          const failed = yield* Effect.flip(startup.awaitCommandReady);
          assert.include(String(failed.cause), "statev2.sqlite");
          assert.isFalse(recovered);
          return;
        }
        yield* startup.awaitCommandReady;
        yield* Deferred.await(hydration);
        assert.isTrue(recovered);
        const projection = yield* projections.getThreadProjection(ThreadId.make("valid"));
        assert.equal(
          projection.turnItems.find((item) => item.type === "reasoning")?.legacyMessageSource,
          "provider",
        );
        assert.deepEqual(
          yield* sql`SELECT thread_id FROM orchestration_v2_legacy_imports WHERE transcript_imported_at IS NULL`,
          [],
        );
        if (failure === "bad-message") {
          assert.equal(projection.messages[0]?.text, "still readable");
          assert.equal(projection.messages[0]?.createdBy, "user");
          assert.deepEqual(projection.messages[0]?.attachments, []);
          assert.deepEqual(
            yield* sql`SELECT field, original_value FROM fork_v1_import_warnings WHERE entity_id = 'bad-message' ORDER BY field`,
            [
              { field: "attachments_json", original_value: "{broken" },
              { field: "source", original_value: "future-source" },
            ],
          );
        }
        if (failure === "orphan" || failure === "cycle") {
          assert.equal(
            (yield* projections.getThread(ThreadId.make("broken"))).lineage.parentThreadId,
            null,
          );
          assert.lengthOf(
            yield* sql`SELECT * FROM fork_v1_import_warnings WHERE entity_id = 'broken' AND field = 'parent_thread_id'`,
            1,
          );
        }
      }).pipe(Effect.provide(startupLayer(config, recover, hydration)));
    }).pipe(Effect.provide(databaseLayer), Effect.scoped),
  );
}

it.effect("a background import records the pass, so the second start skips the check", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig;
    yield* seedThreads([["root", null]]);
    yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, source, is_streaming, created_at, updated_at)
      VALUES ('reasoning', 'root', 'reasoning', 'thinking', 'provider', 0, ${stamp}, ${stamp})`;
    const start = (awaitHydration: boolean) =>
      Effect.gen(function* () {
        const hydration = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const startup = yield* ServerRuntimeStartup;
          yield* startup.markHttpListening;
          yield* startup.awaitCommandReady;
          if (awaitHydration) yield* Deferred.await(hydration);
        }).pipe(Effect.provide(startupLayer(config, Effect.succeed(summary), hydration)));
      });
    // First start: nothing is imported when the check runs; hydration finishes in the background.
    yield* start(true);
    assert.lengthOf(yield* sql`SELECT 1 FROM fork_v1_import_state`, 1);
    // A scan would now warn about this event; the second start reads the marker instead.
    yield* sql`DELETE FROM orchestration_events WHERE event_id = 'migration:v1:turn-item:reasoning'`;
    yield* start(false);
    assert.lengthOf(yield* sql`SELECT 1 FROM fork_v1_import_warnings`, 0);
  }).pipe(Effect.provide(databaseLayer), Effect.scoped),
);
