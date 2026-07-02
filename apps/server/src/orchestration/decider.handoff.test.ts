import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = asProjectId("project-handoff");
const SOURCE_THREAD_ID = asThreadId("thread-source");
const TARGET_THREAD_ID = asThreadId("thread-target");
// Mirrors the deterministic id builder in decider.ts.
const importedMessageId = (sourceMessageId: string): string =>
  `handoff:${TARGET_THREAD_ID}:${sourceMessageId}`;

// Distributive Omit preserves the discriminated union so narrowing on `type`
// continues to narrow `payload` (a plain `Omit<Union, K>` would collapse it).
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type PlannedEvent = DistributiveOmit<OrchestrationEvent, "sequence">;

type SeededMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming?: boolean;
  readonly source?: "handoff-import" | "user" | "provider" | "system";
  readonly sourceThreadId?: string;
  readonly sourceMessageId?: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
};

const imageAttachment: ChatAttachment = {
  type: "image",
  id: "att-1",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 1024,
};

type SeedOptions = {
  readonly messages?: ReadonlyArray<SeededMessage>;
  readonly handoff?: boolean;
  readonly archived?: boolean;
  readonly deleted?: boolean;
  readonly runningSession?: boolean;
};

/**
 * Builds a read model containing one project and one source thread. The source
 * thread can carry messages, prior-handoff metadata, an active session, or be
 * archived/deleted to exercise the rejection branches of `thread.handoff.create`.
 */
const seedReadModel = (options: SeedOptions = {}) =>
  Effect.gen(function* () {
    let model = createEmptyReadModel(NOW);
    let sequence = 0;
    const nextSequence = () => (sequence += 1);

    model = yield* projectEvent(model, {
      sequence: nextSequence(),
      eventId: asEventId("evt-project-create"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: NOW,
      commandId: asCommandId("cmd-project-create"),
      causationEventId: null,
      correlationId: asCommandId("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        title: "Project Handoff",
        workspaceRoot: "/tmp/project-handoff",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    model = yield* projectEvent(model, {
      sequence: nextSequence(),
      eventId: asEventId("evt-thread-create-source"),
      aggregateKind: "thread",
      aggregateId: SOURCE_THREAD_ID,
      type: "thread.created",
      occurredAt: NOW,
      commandId: asCommandId("cmd-thread-create-source"),
      causationEventId: null,
      correlationId: asCommandId("cmd-thread-create-source"),
      metadata: {},
      payload: {
        threadId: SOURCE_THREAD_ID,
        projectId: PROJECT_ID,
        title: "Source Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        handoff: options.handoff
          ? {
              schemaVersion: 1,
              sourceThreadId: asThreadId("thread-ancestor"),
              sourceTitle: "Ancestor Thread",
              sourceProviderInstanceId: ProviderInstanceId.make("codex"),
              targetProviderInstanceId: ProviderInstanceId.make("codex"),
              importedMessageCount: 1,
              bootstrapStatus: "completed",
              bootstrapMessageId: null,
            }
          : null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    for (const message of options.messages ?? []) {
      const messageEvent: OrchestrationEvent = {
        sequence: nextSequence(),
        eventId: asEventId(`evt-msg-${message.id}`),
        aggregateKind: "thread",
        aggregateId: SOURCE_THREAD_ID,
        type: "thread.message-sent",
        occurredAt: NOW,
        commandId: asCommandId(`cmd-msg-${message.id}`),
        causationEventId: null,
        correlationId: asCommandId(`cmd-msg-${message.id}`),
        metadata: {},
        payload: {
          threadId: SOURCE_THREAD_ID,
          messageId: asMessageId(message.id),
          role: message.role,
          text: message.text,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          turnId: null,
          streaming: message.streaming ?? false,
          source: message.source ?? (message.role === "assistant" ? "provider" : "user"),
          ...(message.sourceThreadId !== undefined
            ? { sourceThreadId: asThreadId(message.sourceThreadId) }
            : {}),
          ...(message.sourceMessageId !== undefined
            ? { sourceMessageId: asMessageId(message.sourceMessageId) }
            : {}),
          createdAt: NOW,
          updatedAt: NOW,
        },
      };
      model = yield* projectEvent(model, messageEvent);
    }

    if (options.runningSession) {
      const sessionEvent: OrchestrationEvent = {
        sequence: nextSequence(),
        eventId: asEventId("evt-session-running"),
        aggregateKind: "thread",
        aggregateId: SOURCE_THREAD_ID,
        type: "thread.session-set",
        occurredAt: NOW,
        commandId: asCommandId("cmd-session-running"),
        causationEventId: null,
        correlationId: asCommandId("cmd-session-running"),
        metadata: {},
        payload: {
          threadId: SOURCE_THREAD_ID,
          session: {
            threadId: SOURCE_THREAD_ID,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            updatedAt: NOW,
          },
        },
      };
      model = yield* projectEvent(model, sessionEvent);
    }

    if (options.archived) {
      model = yield* projectEvent(model, {
        sequence: nextSequence(),
        eventId: asEventId("evt-archive"),
        aggregateKind: "thread",
        aggregateId: SOURCE_THREAD_ID,
        type: "thread.archived",
        occurredAt: NOW,
        commandId: asCommandId("cmd-archive"),
        causationEventId: null,
        correlationId: asCommandId("cmd-archive"),
        metadata: {},
        payload: {
          threadId: SOURCE_THREAD_ID,
          archivedAt: NOW,
          updatedAt: NOW,
        },
      });
    }

    if (options.deleted) {
      model = yield* projectEvent(model, {
        sequence: nextSequence(),
        eventId: asEventId("evt-delete"),
        aggregateKind: "thread",
        aggregateId: SOURCE_THREAD_ID,
        type: "thread.deleted",
        occurredAt: NOW,
        commandId: asCommandId("cmd-delete"),
        causationEventId: null,
        correlationId: asCommandId("cmd-delete"),
        metadata: {},
        payload: {
          threadId: SOURCE_THREAD_ID,
          deletedAt: NOW,
        },
      });
    }

    return model;
  });

const handoffCommand = (
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.handoff.create" }>> = {},
): Extract<OrchestrationCommand, { type: "thread.handoff.create" }> => ({
  type: "thread.handoff.create",
  commandId: asCommandId("cmd-handoff"),
  sourceThreadId: SOURCE_THREAD_ID,
  targetThreadId: TARGET_THREAD_ID,
  targetModelSelection: {
    instanceId: ProviderInstanceId.make("deepseek"),
    model: "deepseek-chat",
  },
  createdAt: NOW,
  ...overrides,
});

const decide = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  decideOrchestrationCommand({ command, readModel });

const asArray = (
  result:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
): ReadonlyArray<PlannedEvent> =>
  (Array.isArray(result) ? result : [result]) as ReadonlyArray<PlannedEvent>;

const eventAt = (events: ReadonlyArray<PlannedEvent>, index: number): PlannedEvent => {
  const event = events[index];
  if (event === undefined) {
    throw new Error(`Expected an event at index ${index}, but found none.`);
  }
  return event;
};

it.layer(NodeServices.layer)("decider thread.handoff.create flows", (it) => {
  it.effect("emits target thread.created, imported messages, and import activity in order", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        messages: [
          { id: "user-1", role: "user", text: "First request" },
          { id: "assistant-1", role: "assistant", text: "First response" },
        ],
      });

      const events = asArray(yield* decide(readModel, handoffCommand()));

      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.message-sent",
        "thread.activity-appended",
      ]);

      const created = eventAt(events, 0);
      const firstMessage = eventAt(events, 1);
      const secondMessage = eventAt(events, 2);
      const activity = eventAt(events, 3);

      // Target thread.created carries handoff metadata copied from the source.
      expect(created.type).toBe("thread.created");
      if (created.type === "thread.created") {
        expect(created.aggregateId).toBe(TARGET_THREAD_ID);
        expect(created.payload.threadId).toBe(TARGET_THREAD_ID);
        expect(created.payload.projectId).toBe(PROJECT_ID);
        expect(created.payload.title).toBe("Handoff: Source Thread");
        expect(created.payload.modelSelection.instanceId).toBe("deepseek");
        expect(created.payload.handoff).not.toBeNull();
        expect(created.payload.handoff?.sourceThreadId).toBe(SOURCE_THREAD_ID);
        expect(created.payload.handoff?.importedMessageCount).toBe(2);
        expect(created.payload.handoff?.bootstrapStatus).toBe("pending");
        expect(created.payload.handoff).not.toHaveProperty("visibleImportCapped");
      }

      // Imported messages are deterministic and reference the source.
      expect(firstMessage.type).toBe("thread.message-sent");
      if (firstMessage.type === "thread.message-sent") {
        expect(firstMessage.aggregateId).toBe(TARGET_THREAD_ID);
        expect(firstMessage.causationEventId).toBe(created.eventId);
        expect(firstMessage.payload.messageId).toBe(importedMessageId("user-1"));
        expect(firstMessage.payload.role).toBe("user");
        expect(firstMessage.payload.text).toBe("First request");
        expect(firstMessage.payload.source).toBe("handoff-import");
        expect(firstMessage.payload.sourceThreadId).toBe(SOURCE_THREAD_ID);
        expect(firstMessage.payload.sourceMessageId).toBe("user-1");
        expect(firstMessage.payload.streaming).toBe(false);
        expect(firstMessage.payload.turnId).toBeNull();
      }

      if (secondMessage.type === "thread.message-sent") {
        expect(secondMessage.payload.messageId).toBe(importedMessageId("assistant-1"));
        expect(secondMessage.payload.role).toBe("assistant");
        expect(secondMessage.causationEventId).toBe(created.eventId);
      }

      // Import activity caused by thread.created summarizes the import.
      expect(activity.type).toBe("thread.activity-appended");
      if (activity.type === "thread.activity-appended") {
        expect(activity.aggregateId).toBe(TARGET_THREAD_ID);
        expect(activity.causationEventId).toBe(created.eventId);
        expect(activity.payload.activity.kind).toBe("thread.handoff.imported");
        expect(activity.payload.activity.payload).toMatchObject({
          sourceThreadId: SOURCE_THREAD_ID,
          importedMessageCount: 2,
          visibleImportCapped: false,
        });
      }
    }),
  );

  it.effect("leaves the source thread unchanged (source immutability)", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        messages: [{ id: "user-1", role: "user", text: "First request" }],
      });

      const events = asArray(yield* decide(readModel, handoffCommand()));

      // No emitted event targets the source thread aggregate.
      for (const event of events) {
        expect(event.aggregateId).toBe(TARGET_THREAD_ID);
      }
    }),
  );

  it.effect("imports attachment-only messages", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        messages: [{ id: "user-1", role: "user", text: "", attachments: [imageAttachment] }],
      });

      const events = asArray(yield* decide(readModel, handoffCommand()));

      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.activity-appended",
      ]);

      const imported = eventAt(events, 1);
      if (imported.type === "thread.message-sent") {
        expect(imported.payload.messageId).toBe(importedMessageId("user-1"));
        expect(imported.payload.text).toBe("");
        expect(imported.payload.attachments).toEqual([imageAttachment]);
      }
    }),
  );

  it.effect("skips streaming and empty messages when selecting importable transcript", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        messages: [
          { id: "user-1", role: "user", text: "Keep me" },
          { id: "assistant-streaming", role: "assistant", text: "partial", streaming: true },
          { id: "assistant-empty", role: "assistant", text: "   " },
          { id: "assistant-2", role: "assistant", text: "Keep me too" },
        ],
      });

      const events = asArray(yield* decide(readModel, handoffCommand()));
      const importedIds = events
        .filter((event) => event.type === "thread.message-sent")
        .map((event) =>
          event.type === "thread.message-sent" ? event.payload.sourceMessageId : null,
        );

      expect(importedIds).toEqual(["user-1", "assistant-2"]);
    }),
  );

  it.effect("caps imported messages at VISIBLE_HANDOFF_IMPORT_MESSAGE_LIMIT", () =>
    Effect.gen(function* () {
      const LIMIT = 2_000;
      const total = LIMIT + 5;
      // The projector caps a thread at MAX_THREAD_MESSAGES (= LIMIT) per applied
      // event, so the cap branch (importable > LIMIT) is unreachable through the
      // event stream. Seed the over-cap transcript directly onto the thread.
      const baseReadModel = yield* seedReadModel();
      const readModel: OrchestrationReadModel = {
        ...baseReadModel,
        threads: baseReadModel.threads.map((thread) =>
          thread.id === SOURCE_THREAD_ID
            ? {
                ...thread,
                messages: Array.from({ length: total }, (_, index) => ({
                  id: asMessageId(`user-${index}`),
                  role: "user" as const,
                  text: `message ${index}`,
                  turnId: null,
                  streaming: false,
                  source: "user" as const,
                  createdAt: NOW,
                  updatedAt: NOW,
                })),
              }
            : thread,
        ),
      };
      const events = asArray(yield* decide(readModel, handoffCommand()));

      const importedEvents = events.filter((event) => event.type === "thread.message-sent");
      expect(importedEvents.length).toBe(LIMIT);

      // Only the most recent LIMIT messages are imported.
      const firstImported = eventAt(importedEvents, 0);
      const lastImported = eventAt(importedEvents, importedEvents.length - 1);
      if (firstImported.type === "thread.message-sent") {
        expect(firstImported.payload.sourceMessageId).toBe(`user-${total - LIMIT}`);
      }
      if (lastImported.type === "thread.message-sent") {
        expect(lastImported.payload.sourceMessageId).toBe(`user-${total - 1}`);
      }

      const created = eventAt(events, 0);
      if (created.type === "thread.created") {
        expect(created.payload.handoff?.importedMessageCount).toBe(LIMIT);
        expect(created.payload.handoff?.visibleImportCapped).toBe(true);
      }

      const activity = eventAt(events, events.length - 1);
      if (activity.type === "thread.activity-appended") {
        expect(activity.payload.activity.payload).toMatchObject({
          importedMessageCount: LIMIT,
          visibleImportCapped: true,
        });
      }
    }),
  );

  it.effect("allows a chain handoff once a native message follows prior imports", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        handoff: true,
        messages: [
          {
            id: "imported-1",
            role: "user",
            text: "Imported turn",
            source: "handoff-import",
            sourceThreadId: "thread-ancestor",
            sourceMessageId: "ancestor-1",
          },
          { id: "native-1", role: "user", text: "Native follow-up", source: "user" },
        ],
      });

      const events = asArray(yield* decide(readModel, handoffCommand()));
      expect(events.map((event) => event.type)).toContain("thread.created");
      // Both the imported and native messages are importable for the next handoff.
      const importedIds = events
        .filter((event) => event.type === "thread.message-sent")
        .map((event) =>
          event.type === "thread.message-sent" ? event.payload.sourceMessageId : null,
        );
      expect(importedIds).toEqual(["imported-1", "native-1"]);
    }),
  );

  // Rejection cases ---------------------------------------------------------

  it.effect("rejects when the source thread is missing", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        messages: [{ id: "user-1", role: "user", text: "hi" }],
      });
      const error = yield* Effect.flip(
        decide(readModel, handoffCommand({ sourceThreadId: asThreadId("thread-missing") })),
      );
      expect(error.message).toContain("thread-missing");
    }),
  );

  it.effect("rejects when the source thread is deleted", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        deleted: true,
        messages: [{ id: "user-1", role: "user", text: "hi" }],
      });
      const error = yield* Effect.flip(decide(readModel, handoffCommand()));
      expect(error.message).toContain("is deleted and cannot be handed off");
    }),
  );

  it.effect("rejects when the source thread is archived", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        archived: true,
        messages: [{ id: "user-1", role: "user", text: "hi" }],
      });
      const error = yield* Effect.flip(decide(readModel, handoffCommand()));
      expect(error.message).toContain("is archived and cannot be handed off");
    }),
  );

  it.effect("rejects when the source thread has an active running turn", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        runningSession: true,
        messages: [{ id: "user-1", role: "user", text: "hi" }],
      });
      const error = yield* Effect.flip(decide(readModel, handoffCommand()));
      expect(error.message).toContain("has an active turn and cannot be handed off");
    }),
  );

  it.effect("rejects a chain handoff without a native message since the last import", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        handoff: true,
        messages: [
          {
            id: "imported-1",
            role: "user",
            text: "Imported turn",
            source: "handoff-import",
            sourceThreadId: "thread-ancestor",
            sourceMessageId: "ancestor-1",
          },
        ],
      });
      const error = yield* Effect.flip(decide(readModel, handoffCommand()));
      expect(error.message).toContain("needs a native message before another handoff");
    }),
  );

  it.effect("rejects when the importable transcript is empty", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        messages: [{ id: "assistant-empty", role: "assistant", text: "   " }],
      });
      const error = yield* Effect.flip(decide(readModel, handoffCommand()));
      expect(error.message).toContain("has no importable messages for handoff");
    }),
  );

  it.effect("rejects when the target thread id already exists", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        messages: [{ id: "user-1", role: "user", text: "hi" }],
      });
      // The source thread id is already present in the read model.
      const error = yield* Effect.flip(
        decide(readModel, handoffCommand({ targetThreadId: SOURCE_THREAD_ID })),
      );
      expect(error.message).toContain(SOURCE_THREAD_ID);
    }),
  );

  // Atomicity / ordering -----------------------------------------------------

  it.effect("projects emitted events into a coherent target thread (atomic, ordered)", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        messages: [
          { id: "user-1", role: "user", text: "First request" },
          { id: "assistant-1", role: "assistant", text: "First response" },
        ],
      });

      const events = asArray(yield* decide(readModel, handoffCommand()));

      // Apply the planned events in order; the projector must accept them as a
      // valid sequence that yields the target thread with imported messages.
      let projected = readModel;
      let sequence = readModel.snapshotSequence;
      for (const event of events) {
        sequence += 1;
        projected = yield* projectEvent(projected, { ...event, sequence });
      }

      const targetThread = projected.threads.find((thread) => thread.id === TARGET_THREAD_ID);
      expect(targetThread).toBeDefined();
      expect(targetThread?.handoff?.bootstrapStatus).toBe("pending");
      expect(targetThread?.messages.map((message) => message.id)).toEqual([
        importedMessageId("user-1"),
        importedMessageId("assistant-1"),
      ]);

      // Source thread is untouched by the projection.
      const sourceThread = projected.threads.find((thread) => thread.id === SOURCE_THREAD_ID);
      expect(sourceThread?.handoff).toBeNull();
      expect(sourceThread?.messages.map((message) => message.id)).toEqual([
        "user-1",
        "assistant-1",
      ]);
    }),
  );

  // Bootstrap complete / skip ------------------------------------------------

  it.effect("completes a pending handoff bootstrap", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        messages: [{ id: "user-1", role: "user", text: "First request" }],
      });
      const handoffEvents = asArray(yield* decide(readModel, handoffCommand()));
      let projected = readModel;
      let sequence = readModel.snapshotSequence;
      for (const event of handoffEvents) {
        sequence += 1;
        projected = yield* projectEvent(projected, { ...event, sequence });
      }

      const result = asArray(
        yield* decide(projected, {
          type: "thread.handoff.bootstrap.complete",
          commandId: asCommandId("cmd-bootstrap-complete"),
          threadId: TARGET_THREAD_ID,
          bootstrapMessageId: asMessageId("assistant:bootstrap-1"),
          providerTurnId: "provider-turn-1",
          completedAt: NOW,
        }),
      );

      expect(result.map((event) => event.type)).toEqual(["thread.handoff-bootstrap-completed"]);
      const completed = eventAt(result, 0);
      if (completed.type === "thread.handoff-bootstrap-completed") {
        expect(completed.payload.threadId).toBe(TARGET_THREAD_ID);
        expect(completed.payload.bootstrapMessageId).toBe("assistant:bootstrap-1");
        expect(completed.payload.providerTurnId).toBe("provider-turn-1");
        expect(completed.metadata.providerTurnId).toBe("provider-turn-1");
      }
    }),
  );

  it.effect("skips a pending handoff bootstrap", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        messages: [{ id: "user-1", role: "user", text: "First request" }],
      });
      const handoffEvents = asArray(yield* decide(readModel, handoffCommand()));
      let projected = readModel;
      let sequence = readModel.snapshotSequence;
      for (const event of handoffEvents) {
        sequence += 1;
        projected = yield* projectEvent(projected, { ...event, sequence });
      }

      const result = asArray(
        yield* decide(projected, {
          type: "thread.handoff.bootstrap.skip",
          commandId: asCommandId("cmd-bootstrap-skip"),
          threadId: TARGET_THREAD_ID,
          reason: "provider declined bootstrap",
          skippedAt: NOW,
        }),
      );

      expect(result.map((event) => event.type)).toEqual(["thread.handoff-bootstrap-skipped"]);
      const skipped = eventAt(result, 0);
      if (skipped.type === "thread.handoff-bootstrap-skipped") {
        expect(skipped.payload.threadId).toBe(TARGET_THREAD_ID);
        expect(skipped.payload.reason).toBe("provider declined bootstrap");
      }
    }),
  );

  it.effect("rejects bootstrap complete when there is no pending handoff", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        messages: [{ id: "user-1", role: "user", text: "First request" }],
      });
      // The source thread has no handoff bootstrap pending.
      const error = yield* Effect.flip(
        decide(readModel, {
          type: "thread.handoff.bootstrap.complete",
          commandId: asCommandId("cmd-bootstrap-complete-invalid"),
          threadId: SOURCE_THREAD_ID,
          bootstrapMessageId: asMessageId("assistant:bootstrap-1"),
          providerTurnId: "provider-turn-1",
          completedAt: NOW,
        }),
      );
      expect(error.message).toContain("has no pending handoff bootstrap to complete");
    }),
  );

  it.effect("rejects bootstrap skip when there is no pending handoff", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel({
        messages: [{ id: "user-1", role: "user", text: "First request" }],
      });
      const error = yield* Effect.flip(
        decide(readModel, {
          type: "thread.handoff.bootstrap.skip",
          commandId: asCommandId("cmd-bootstrap-skip-invalid"),
          threadId: SOURCE_THREAD_ID,
          reason: "no pending bootstrap",
          skippedAt: NOW,
        }),
      );
      expect(error.message).toContain("has no pending handoff bootstrap to skip");
    }),
  );
});
