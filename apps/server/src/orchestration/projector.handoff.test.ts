import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "./Services/ProjectionPipeline.ts";
import { ServerConfig } from "../config.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

// ── Pure projector replay surface ────────────────────────────────────
//
// `projectEvent` is the deterministic in-memory replay used to rebuild a
// thread read model from its event log. These tests pin the
// provider-thread-handoff projection: a handed-off thread reconstructs its
// `handoff` metadata and imported-message `source` values, while a plain
// thread replays with `handoff: null`. The historical source-fallback
// (message-sent without an explicit `source`) is also exercised here as it
// flows through the same projection path the migration backfills.

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  commandId: string | null;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.make(input.aggregateId)
        : ThreadId.make(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.make(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const replay = (events: ReadonlyArray<OrchestrationEvent>) =>
  Effect.gen(function* () {
    let state = createEmptyReadModel("2026-06-01T00:00:00.000Z");
    for (const event of events) {
      state = yield* projectEvent(state, event);
    }
    return state;
  });

const HANDOFF_METADATA = {
  schemaVersion: 1,
  sourceThreadId: "thread-source",
  sourceTitle: "Source",
  sourceProviderInstanceId: "codex",
  targetProviderInstanceId: "deepseek",
  importedMessageCount: 1,
  bootstrapStatus: "pending",
  bootstrapMessageId: null,
} as const;

it.effect(
  "projector replays a handed-off thread reconstructing handoff metadata and imported sources",
  () =>
    Effect.gen(function* () {
      const now = "2026-06-01T00:00:00.000Z";
      const later = "2026-06-01T00:00:01.000Z";

      const replayed = yield* replay([
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-target",
          occurredAt: now,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-target",
            projectId: "project-1",
            title: "Handoff: Source",
            modelSelection: { provider: "deepseek", model: "deepseek-v4-pro" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            handoff: HANDOFF_METADATA,
            createdAt: now,
            updatedAt: now,
          },
        }),
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-target",
          occurredAt: later,
          commandId: "cmd-imported",
          payload: {
            threadId: "thread-target",
            messageId: "msg-imported",
            role: "assistant",
            text: "prior response",
            turnId: null,
            streaming: false,
            source: "handoff-import",
            sourceThreadId: "thread-source",
            sourceMessageId: "msg-source",
            createdAt: later,
            updatedAt: later,
          },
        }),
      ]);

      const thread = replayed.threads[0];
      assert.isNotNull(thread?.handoff ?? null);
      assert.equal(thread?.handoff?.sourceThreadId, "thread-source");
      assert.equal(thread?.handoff?.sourceProviderInstanceId, "codex");
      assert.equal(thread?.handoff?.targetProviderInstanceId, "deepseek");
      assert.equal(thread?.handoff?.bootstrapStatus, "pending");

      const imported = thread?.messages[0];
      assert.equal(imported?.id, "msg-imported");
      assert.equal(imported?.source, "handoff-import");
      assert.equal(imported?.sourceThreadId, "thread-source");
      assert.equal(imported?.sourceMessageId, "msg-source");
    }),
);

it.effect(
  "projector replays handoff bootstrap completion onto reconstructed handoff metadata",
  () =>
    Effect.gen(function* () {
      const now = "2026-06-01T00:00:00.000Z";
      const completedAt = "2026-06-01T00:00:02.000Z";

      const replayed = yield* replay([
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-target",
          occurredAt: now,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-target",
            projectId: "project-1",
            title: "Handoff: Source",
            modelSelection: { provider: "deepseek", model: "deepseek-v4-pro" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            handoff: HANDOFF_METADATA,
            createdAt: now,
            updatedAt: now,
          },
        }),
        makeEvent({
          sequence: 2,
          type: "thread.handoff-bootstrap-completed",
          aggregateKind: "thread",
          aggregateId: "thread-target",
          occurredAt: completedAt,
          commandId: "cmd-bootstrap-complete",
          payload: {
            threadId: "thread-target",
            bootstrapMessageId: "msg-bootstrap",
            providerTurnId: "turn-provider-1",
            completedAt,
          },
        }),
      ]);

      const thread = replayed.threads[0];
      assert.equal(thread?.handoff?.bootstrapStatus, "completed");
      assert.equal(thread?.handoff?.bootstrapMessageId, "msg-bootstrap");
      assert.equal(thread?.handoff?.bootstrapCompletedAt, completedAt);
    }),
);

it.effect("projector replays a non-handoff thread with handoff null", () =>
  Effect.gen(function* () {
    const now = "2026-06-01T00:00:00.000Z";

    const replayed = yield* replay([
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: "thread-plain",
        occurredAt: now,
        commandId: "cmd-create-plain",
        payload: {
          threadId: "thread-plain",
          projectId: "project-1",
          title: "Plain thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    ]);

    assert.isNull(replayed.threads[0]?.handoff ?? null);
  }),
);

it.effect("projector derives historical message source from role when source is absent", () =>
  Effect.gen(function* () {
    const now = "2026-06-01T00:00:00.000Z";

    const replayed = yield* replay([
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: "thread-historical",
        occurredAt: now,
        commandId: "cmd-create",
        payload: {
          threadId: "thread-historical",
          projectId: "project-1",
          title: "Historical thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
      makeEvent({
        sequence: 2,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-historical",
        occurredAt: "2026-06-01T00:00:01.000Z",
        commandId: "cmd-user",
        payload: {
          threadId: "thread-historical",
          messageId: "msg-user",
          role: "user",
          text: "hello",
          turnId: null,
          streaming: false,
          // No `source` — emulates a row written before the handoff migration.
          createdAt: "2026-06-01T00:00:01.000Z",
          updatedAt: "2026-06-01T00:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-historical",
        occurredAt: "2026-06-01T00:00:02.000Z",
        commandId: "cmd-assistant",
        payload: {
          threadId: "thread-historical",
          messageId: "msg-assistant",
          role: "assistant",
          text: "hi there",
          turnId: null,
          streaming: false,
          createdAt: "2026-06-01T00:00:02.000Z",
          updatedAt: "2026-06-01T00:00:02.000Z",
        },
      }),
    ]);

    const messages = replayed.threads[0]?.messages ?? [];
    const user = messages.find((message) => message.id === "msg-user");
    const assistant = messages.find((message) => message.id === "msg-assistant");

    // assistant -> provider; otherwise the role is used as the source.
    assert.equal(user?.source, "user");
    assert.equal(assistant?.source, "provider");
  }),
);

// ── Shell/summary projection surface (SQL pipeline) ──────────────────
//
// The shell "latest user message" summary is the signal the inbox uses to
// surface threads awaiting a human reply. Imported (`handoff-import`)
// messages are seeded copies of the source thread's history, not a fresh
// human turn on the target thread, so they must NOT advance
// `latest_user_message_at`. This is enforced in the threads-summary
// projector, observable through the persisted projection row.

const projectionPipelineLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-handoff-summary-test-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(Layer.fresh(projectionPipelineLayer))(
  "orchestration projector handoff shell summary",
  (it) => {
    it.effect("shell summary ignores imported user messages for latest_user_message_at", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-06-01T00:00:00.000Z";
        const importedAt = "2026-06-01T00:00:05.000Z";
        const nativeAt = "2026-06-01T00:00:10.000Z";
        const threadId = ThreadId.make("thread-summary-handoff");

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-summary-1"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-summary-1"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-summary-1"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-summary-handoff"),
            title: "Handoff: Source",
            modelSelection: {
              instanceId: ProviderInstanceId.make("deepseek"),
              model: "deepseek-v4-pro",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            handoff: {
              schemaVersion: 1,
              sourceThreadId: ThreadId.make("thread-source"),
              sourceTitle: "Source",
              sourceProviderInstanceId: ProviderInstanceId.make("codex"),
              targetProviderInstanceId: ProviderInstanceId.make("deepseek"),
              importedMessageCount: 1,
              bootstrapStatus: "pending",
              bootstrapMessageId: null,
            },
            createdAt: now,
            updatedAt: now,
          },
        });

        // Imported user turn copied from the source thread — must not count.
        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-summary-2"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: importedAt,
          commandId: CommandId.make("cmd-summary-2"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-summary-2"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("msg-imported-user"),
            role: "user",
            text: "prior question",
            turnId: null,
            streaming: false,
            source: "handoff-import",
            sourceThreadId: ThreadId.make("thread-source"),
            sourceMessageId: MessageId.make("msg-source-user"),
            createdAt: importedAt,
            updatedAt: importedAt,
          },
        });

        yield* projectionPipeline.bootstrap;

        const importedOnlyRows = yield* sql<{
          readonly latestUserMessageAt: string | null;
        }>`
          SELECT latest_user_message_at AS "latestUserMessageAt"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        assert.equal(importedOnlyRows[0]?.latestUserMessageAt ?? null, null);

        // A genuine native user turn does advance the summary.
        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-summary-3"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: nativeAt,
          commandId: CommandId.make("cmd-summary-3"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-summary-3"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("msg-native-user"),
            role: "user",
            text: "new question",
            turnId: null,
            streaming: false,
            createdAt: nativeAt,
            updatedAt: nativeAt,
          },
        });

        yield* projectionPipeline.bootstrap;

        const nativeRows = yield* sql<{
          readonly latestUserMessageAt: string | null;
        }>`
          SELECT latest_user_message_at AS "latestUserMessageAt"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        assert.equal(nativeRows[0]?.latestUserMessageAt, nativeAt);
      }),
    );
  },
);
