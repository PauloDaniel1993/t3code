import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import * as Settings from "../serverSettings.ts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Runtime from "./FlowRuntime.ts";

it.effect(
  "finds continuations only for the current step message and tolerates a never-launched thread",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const threadId = ThreadId.make("thread");
      const shell = liveThreadShell(threadId);
      const now = DateTime.makeUnsafe("2026-10-31T00:00:00Z");
      const run = (id: string, messageId: string, parent?: string): OrchestrationV2Run => ({
        id: RunId.make(id),
        threadId,
        ordinal: 1,
        userMessageId: MessageId.make(messageId),
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: shell.modelSelection,
        providerThreadId: null,
        rootNodeId: null,
        activeAttemptId: null,
        status: "cancelled",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
        ...(parent ? { restartContinuationOfRunId: RunId.make(parent) } : {}),
      });
      const runs = [
        run("old", "old-message"),
        run("old-continuation", "old-continuation-message", "old"),
        run("current", "current-message"),
      ];
      const program = Effect.gen(function* () {
        const runtime = yield* Runtime.FlowRuntime;
        expect(yield* runtime.continuing(threadId, "current-message")).toBeNull();
        expect(yield* runtime.continuing(ThreadId.make("missing"), "message")).toBeNull();
        expect(yield* runtime.settled(ThreadId.make("missing"), "message")).toBeNull();
        yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, attempt_count, available_at, created_at, updated_at) VALUES ('continue', 'continue', ${threadId}, 'provider-runtime.continue', '{"type":"provider-runtime.continue","sourceRunId":"current"}', 'pending', 0, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z')`;
        expect(yield* runtime.continuing(threadId, "current-message")).toBe(
          "message:restart-continuation:current",
        );
        expect(
          yield* runtime.settled(threadId, "message:restart-continuation:current", true),
        ).toMatchObject({ failed: true, interrupted: true });
        runs.push(run("current-continuation", "new-message", "current"));
        expect(yield* runtime.continuing(threadId, "current-message")).toBe("new-message");
      });
      yield* program.pipe(
        Effect.provide(
          Runtime.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(Launch.ThreadLaunchService)({}),
                Outbox.layer,
                Layer.mock(Settings.ServerSettingsService)({
                  getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
                }),
                Layer.mock(Projects.ProjectService)({}),
                Layer.mock(Registry.ProviderInstanceRegistry)({}),
                Layer.mock(Threads.ThreadManagementService)({
                  getThreadShell: (id) => Effect.succeed(id === threadId ? shell : null),
                  getThreadRecords: () => Effect.succeed({ ...idleThreadProjection(shell), runs }),
                }),
                Layer.mock(Sink.EventSinkV2)({
                  latestSequence: () => Effect.succeed(0),
                  stream: () => Stream.empty,
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);
