import {
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  ChatAttachment,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { drainAttachmentCleanupQueue } from "../../attachmentStaging.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { AttachmentCleanupQueueRepository } from "../../persistence/Services/AttachmentCleanupQueue.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";

const makeProjectionPipelinePrefixedTestLayer = (prefix: string) =>
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* Effect.result(fileSystem.stat(filePath));
    return fileInfo._tag === "Success";
  });

const drainProjectedAttachmentCleanup = Effect.fn("drainProjectedAttachmentCleanup")(function* (
  fileSystem?: FileSystem.FileSystem,
) {
  const queue = yield* AttachmentCleanupQueueRepository;
  const { attachmentsDir } = yield* ServerConfig;
  const drain = drainAttachmentCleanupQueue({ attachmentsDir, queue });
  yield* fileSystem ? drain.pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)) : drain;
});

const AttachmentArrayJson = Schema.fromJsonString(Schema.Array(ChatAttachment));
const encodeAttachmentsJson = Schema.encodeSync(AttachmentArrayJson);
const decodeAttachmentsJson = Schema.decodeUnknownSync(AttachmentArrayJson);

const BaseTestLayer = makeProjectionPipelinePrefixedTestLayer("t3-projection-pipeline-test-");

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("bootstraps all projection states and writes projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: now,
        commandId: CommandId.make("cmd-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly title: string;
        readonly scriptsJson: string;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
      `;
      assert.deepEqual(projectRows, [
        { projectId: "project-1", title: "Project 1", scriptsJson: "[]" },
      ]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_thread_messages
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-1", text: "hello" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, 3);
      }

      // Settled lifecycle through the DB pipeline: thread.settled writes the
      // override + timestamp, thread.unsettled(user) flips to the active pin.
      yield* eventStore.append({
        type: "thread.settled",
        eventId: EventId.make("evt-settle-1"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: CommandId.make("cmd-settle-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-settle-1"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          settledAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      });
      yield* projectionPipeline.bootstrap;

      const settledRows = yield* sql<{
        readonly settledOverride: string | null;
        readonly settledAt: string | null;
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(settledRows, [
        { settledOverride: "settled", settledAt: "2026-01-01T00:00:01.000Z" },
      ]);

      yield* eventStore.append({
        type: "thread.unsettled",
        eventId: EventId.make("evt-unsettle-1"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        occurredAt: "2026-01-01T00:00:02.000Z",
        commandId: CommandId.make("cmd-unsettle-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-unsettle-1"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          reason: "user",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      });
      yield* projectionPipeline.bootstrap;

      const unsettledRows = yield* sql<{
        readonly settledOverride: string | null;
        readonly settledAt: string | null;
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(unsettledRows, [{ settledOverride: "active", settledAt: null }]);
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-activity-committed-sequence-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect(
      "stores rich activity payloads in committed event order across bootstrap replay",
      () =>
        Effect.gen(function* () {
          const projectionPipeline = yield* OrchestrationProjectionPipeline;
          const eventStore = yield* OrchestrationEventStore;
          const sql = yield* SqlClient.SqlClient;
          const threadId = ThreadId.make("thread-rich-activities");
          const createdAt = "2026-01-01T00:00:00.000Z";
          const inputs = [
            {
              id: "task-started",
              kind: "task.started",
              payload: { taskId: "task-1", toolUseId: "tool-use-1", skipTranscript: false },
            },
            {
              id: "task-progress",
              kind: "task.progress",
              payload: {
                taskId: "task-1",
                toolUseId: "tool-use-1",
                usage: { totalTokens: 0, toolUses: 2 },
              },
            },
            {
              id: "task-completed",
              kind: "task.completed",
              payload: {
                taskId: "task-1",
                toolUseId: "tool-use-1",
                skipTranscript: true,
                outputFile: "/tmp/task-1.txt",
                usage: { durationMs: 0 },
              },
            },
            {
              id: "tool-progress",
              kind: "tool.progress",
              payload: {
                taskId: "task-1",
                toolUseId: "tool-use-2",
                parentToolUseId: null,
              },
            },
            {
              id: "reasoning-summary",
              kind: "turn.reasoning.summary",
              payload: { reasoningSummary: "Compared the replay paths." },
            },
          ] as const;

          const committedEvents = yield* Effect.forEach(
            inputs,
            (input) =>
              eventStore.append({
                type: "thread.activity-appended",
                eventId: EventId.make(`event-${input.id}`),
                aggregateKind: "thread",
                aggregateId: threadId,
                occurredAt: createdAt,
                commandId: CommandId.make(`cmd-${input.id}`),
                causationEventId: null,
                correlationId: CorrelationId.make(`cmd-${input.id}`),
                metadata: {},
                payload: {
                  threadId,
                  activity: {
                    id: EventId.make(input.id),
                    tone: input.kind === "tool.progress" ? "tool" : "info",
                    kind: input.kind,
                    summary: input.kind,
                    payload: input.payload,
                    turnId: TurnId.make("turn-1"),
                    sequence: 999,
                    createdAt,
                  },
                },
              }),
            { concurrency: 1 },
          );

          yield* projectionPipeline.bootstrap;

          const readRows = () =>
            sql<{
              readonly activityId: string;
              readonly payloadJson: string;
              readonly sequence: number | null;
            }>`
          SELECT
            activity_id AS "activityId",
            payload_json AS "payloadJson",
            sequence
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
          ORDER BY sequence ASC, activity_id ASC
        `;
          const firstRows = yield* readRows();
          yield* projectionPipeline.bootstrap;
          const replayedRows = yield* readRows();

          assert.deepEqual(replayedRows, firstRows);
          assert.deepEqual(
            firstRows.map((row) => ({
              activityId: row.activityId,
              sequence: row.sequence,
              payload: JSON.parse(row.payloadJson),
            })),
            inputs.map((input, index) => ({
              activityId: input.id,
              sequence: committedEvents[index]!.sequence,
              payload: input.payload,
            })),
          );
        }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-base-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("stores message attachment references without mutating payloads", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments"),
            messageId: MessageId.make("message-attachments"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-att-1",
                name: "example.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments'
          `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-safe-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("preserves mixed image attachment metadata as-is", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-attachments-safe"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-attachments-safe"),
          occurredAt: now,
          commandId: CommandId.make("cmd-attachments-safe"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-attachments-safe"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-attachments-safe"),
            messageId: MessageId.make("message-attachments-safe"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-safe-att-1",
                name: "untrusted.exe",
                mimeType: "image/x-unknown",
                sizeBytes: 5,
              },
              {
                type: "image",
                id: "thread-attachments-safe-att-2",
                name: "not-image.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments-safe'
          `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-safe-att-1",
            name: "untrusted.exe",
            mimeType: "image/x-unknown",
            sizeBytes: 5,
          },
          {
            type: "image",
            id: "thread-attachments-safe-att-2",
            name: "not-image.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "passes explicit empty attachment arrays through the projection pipeline to clear attachments",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const later = "2026-01-01T00:00:01.000Z";

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-clear-attachments-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-1"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-clear-attachments"),
            title: "Project Clear Attachments",
            workspaceRoot: "/tmp/project-clear-attachments",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-clear-attachments-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-2"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            projectId: ProjectId.make("project-clear-attachments"),
            title: "Thread Clear Attachments",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-clear-attachments-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.make("cmd-clear-attachments-3"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            messageId: MessageId.make("message-clear-attachments"),
            role: "user",
            text: "Has attachments",
            attachments: [
              {
                type: "image",
                id: "thread-clear-attachments-att-1",
                name: "clear.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-clear-attachments-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-clear-attachments"),
          occurredAt: later,
          commandId: CommandId.make("cmd-clear-attachments-4"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-clear-attachments-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-clear-attachments"),
            messageId: MessageId.make("message-clear-attachments"),
            role: "user",
            text: "",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: later,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
          SELECT
            attachments_json AS "attachmentsJson"
          FROM projection_thread_messages
          WHERE message_id = 'message-clear-attachments'
        `;
        assert.equal(rows.length, 1);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), []);
      }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("overwrites stored attachment references when a message updates attachments", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const later = "2026-01-01T00:00:01.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-overwrite-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-1"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-overwrite"),
          title: "Project Overwrite",
          workspaceRoot: "/tmp/project-overwrite",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-overwrite-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-2"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          projectId: ProjectId.make("project-overwrite"),
          title: "Thread Overwrite",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-overwrite-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.make("cmd-overwrite-3"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          messageId: MessageId.make("message-overwrite"),
          role: "user",
          text: "first image",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-1",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-overwrite-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-overwrite"),
        occurredAt: later,
        commandId: CommandId.make("cmd-overwrite-4"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-overwrite-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-overwrite"),
          messageId: MessageId.make("message-overwrite"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-2",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: later,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
              SELECT attachments_json AS "attachmentsJson"
              FROM projection_thread_messages
              WHERE message_id = 'message-overwrite'
            `;
      assert.equal(rows.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-overwrite-att-2",
          name: "file.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-replacement-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("attachment replacement removes only paths no longer referenced by the thread", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const { attachmentsDir } = yield* ServerConfig;
      const threadId = ThreadId.make("Thread Replace.Mixed");
      const oldDocument: ChatAttachment = {
        type: "document",
        id: "thread-replace-mixed-00000000-0000-4000-8000-000000000001",
        name: "old.pdf",
        mimeType: "application/pdf",
        sizeBytes: 5,
      };
      const sharedFile: ChatAttachment = {
        type: "file",
        id: "thread-replace-mixed-00000000-0000-4000-8000-000000000002",
        name: "shared.ts",
        mimeType: "text/plain",
        sizeBytes: 5,
      };
      const newFile: ChatAttachment = {
        type: "file",
        id: "thread-replace-mixed-00000000-0000-4000-8000-000000000003",
        name: "new.json",
        mimeType: "application/json",
        sizeBytes: 5,
      };
      const otherThreadDocument: ChatAttachment = {
        type: "document",
        id: "thread-replace-mixed-other-00000000-0000-4000-8000-000000000004",
        name: "other.pdf",
        mimeType: "application/pdf",
        sizeBytes: 5,
      };
      const now = "2026-01-01T00:00:00.000Z";

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-replace-mixed',
            ${threadId},
            NULL,
            'user',
            'old',
            ${encodeAttachmentsJson([oldDocument, sharedFile])},
            0,
            ${now},
            ${now}
          ),
          (
            'message-retain-shared',
            ${threadId},
            NULL,
            'user',
            'shared',
            ${encodeAttachmentsJson([sharedFile])},
            0,
            '2026-01-01T00:00:00.500Z',
            '2026-01-01T00:00:00.500Z'
          )
      `;

      const oldDocumentPath = path.join(attachmentsDir, attachmentRelativePath(oldDocument));
      const sharedFilePath = path.join(attachmentsDir, attachmentRelativePath(sharedFile));
      const newFilePath = path.join(attachmentsDir, attachmentRelativePath(newFile));
      const otherThreadDocumentPath = path.join(
        attachmentsDir,
        attachmentRelativePath(otherThreadDocument),
      );
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      for (const attachmentPath of [
        oldDocumentPath,
        sharedFilePath,
        newFilePath,
        otherThreadDocumentPath,
      ]) {
        yield* fileSystem.writeFileString(attachmentPath, "attachment");
      }

      const savedEvent = yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-replace-mixed"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: CommandId.make("cmd-replace-mixed"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-replace-mixed"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-replace-mixed"),
          role: "user",
          text: "new",
          attachments: [newFile],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      });
      yield* projectionPipeline.projectEvent(savedEvent);

      assert.isTrue(yield* exists(oldDocumentPath));
      yield* drainProjectedAttachmentCleanup();
      assert.isFalse(yield* exists(oldDocumentPath));
      assert.isTrue(yield* exists(sharedFilePath));
      assert.isTrue(yield* exists(newFilePath));
      assert.isTrue(yield* exists(otherThreadDocumentPath));
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-rollback-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("does not persist attachment files when projector transaction rolls back", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-rollback-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-rollback"),
          title: "Project Rollback",
          workspaceRoot: "/tmp/project-rollback",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-rollback-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-rollback"),
        occurredAt: now,
        commandId: CommandId.make("cmd-rollback-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-rollback-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-rollback"),
          projectId: ProjectId.make("project-rollback"),
          title: "Thread Rollback",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* sql`
        CREATE TRIGGER fail_thread_messages_projection_state_update
        BEFORE UPDATE ON projection_state
        WHEN NEW.projector = 'projection.thread-messages'
        BEGIN
          SELECT RAISE(ABORT, 'forced-projection-state-failure');
        END;
      `;

      const result = yield* Effect.result(
        appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-rollback-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-rollback"),
          occurredAt: now,
          commandId: CommandId.make("cmd-rollback-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-rollback-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-rollback"),
            messageId: MessageId.make("message-rollback"),
            role: "user",
            text: "Rollback me",
            attachments: [
              {
                type: "image",
                id: "thread-rollback-att-1",
                name: "rollback.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      assert.equal(result._tag, "Failure");

      const rows = yield* sql<{
        readonly count: number;
      }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages
        WHERE message_id = 'message-rollback'
      `;
      assert.equal(rows[0]?.count ?? 0, 0);

      const { attachmentsDir } = yield* ServerConfig;
      const attachmentPath = path.join(attachmentsDir, "thread-rollback-att-1.png");
      assert.isFalse(yield* exists(attachmentPath));
      yield* sql`DROP TRIGGER IF EXISTS fail_thread_messages_projection_state_update`;
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-cleanup-rollback-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect(
      "projection rollback does not prune attachments from the retained message state",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const projectionPipeline = yield* OrchestrationProjectionPipeline;
          const eventStore = yield* OrchestrationEventStore;
          const sql = yield* SqlClient.SqlClient;
          const { attachmentsDir } = yield* ServerConfig;
          const threadId = ThreadId.make("Thread Cleanup.Rollback");
          const retainedDocument: ChatAttachment = {
            type: "document",
            id: "thread-cleanup-rollback-00000000-0000-4000-8000-000000000001",
            name: "retained.pdf",
            mimeType: "application/pdf",
            sizeBytes: 5,
          };
          const retainedFile: ChatAttachment = {
            type: "file",
            id: "thread-cleanup-rollback-00000000-0000-4000-8000-000000000002",
            name: "retained.ts",
            mimeType: "text/plain",
            sizeBytes: 5,
          };
          const replacementFile: ChatAttachment = {
            type: "file",
            id: "thread-cleanup-rollback-00000000-0000-4000-8000-000000000003",
            name: "replacement.json",
            mimeType: "application/json",
            sizeBytes: 5,
          };
          const now = "2026-01-01T00:00:00.000Z";

          yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-cleanup-rollback',
          ${threadId},
          NULL,
          'user',
          'retained',
          ${encodeAttachmentsJson([retainedDocument, retainedFile])},
          0,
          ${now},
          ${now}
        )
      `;
          const retainedDocumentPath = path.join(
            attachmentsDir,
            attachmentRelativePath(retainedDocument),
          );
          const retainedFilePath = path.join(attachmentsDir, attachmentRelativePath(retainedFile));
          yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
          yield* fileSystem.writeFileString(retainedDocumentPath, "document");
          yield* fileSystem.writeFileString(retainedFilePath, "file");

          yield* sql`
        CREATE TRIGGER fail_cleanup_projection_state_update
        BEFORE INSERT ON projection_state
        WHEN NEW.projector = 'projection.thread-messages'
        BEGIN
          SELECT RAISE(ABORT, 'forced-cleanup-projection-state-failure');
        END;
      `;

          const savedEvent = yield* eventStore.append({
            type: "thread.message-sent",
            eventId: EventId.make("evt-cleanup-rollback"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-01-01T00:00:01.000Z",
            commandId: CommandId.make("cmd-cleanup-rollback"),
            causationEventId: null,
            correlationId: CorrelationId.make("cmd-cleanup-rollback"),
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.make("message-cleanup-rollback"),
              role: "user",
              text: "replacement",
              attachments: [replacementFile],
              turnId: null,
              streaming: false,
              createdAt: now,
              updatedAt: "2026-01-01T00:00:01.000Z",
            },
          });
          const result = yield* Effect.result(projectionPipeline.projectEvent(savedEvent));
          assert.equal(result._tag, "Failure");

          assert.isTrue(yield* exists(retainedDocumentPath));
          assert.isTrue(yield* exists(retainedFilePath));
          const rows = yield* sql<{ readonly attachmentsJson: string }>`
        SELECT attachments_json AS "attachmentsJson"
        FROM projection_thread_messages
        WHERE message_id = 'message-cleanup-rollback'
      `;
          assert.deepEqual(decodeAttachmentsJson(rows[0]?.attachmentsJson ?? "[]"), [
            retainedDocument,
            retainedFile,
          ]);
          yield* sql`DROP TRIGGER IF EXISTS fail_cleanup_projection_state_update`;
        }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-cleanup-retry-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("retains failed cleanup intents and removes the file on retry", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const queue = yield* AttachmentCleanupQueueRepository;
        const { attachmentsDir } = yield* ServerConfig;
        const threadId = ThreadId.make("thread-cleanup-retry");
        const relativePath = "thread-cleanup-retry-00000000-0000-4000-8000-000000000001.txt";
        const attachmentPath = path.join(attachmentsDir, relativePath);
        yield* fileSystem.writeFileString(attachmentPath, "retry");
        yield* queue.enqueue({
          operation: "delete-path",
          threadId,
          relativePath,
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        let failFirstRemove = true;
        const failingFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          remove: (candidate, options) => {
            if (failFirstRemove && String(candidate) === attachmentPath) {
              failFirstRemove = false;
              return Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "remove",
                  pathOrDescriptor: String(candidate),
                  description: "injected cleanup lock",
                }),
              );
            }
            return fileSystem.remove(candidate, options);
          },
        });

        yield* drainProjectedAttachmentCleanup(failingFileSystem);
        assert.isTrue(yield* exists(attachmentPath));
        const pendingAfterFailure = yield* queue.listPending({ limit: 10 });
        assert.equal(pendingAfterFailure.length, 1);
        assert.equal(pendingAfterFailure[0]?.attemptCount, 1);

        yield* drainProjectedAttachmentCleanup();
        assert.isFalse(yield* exists(attachmentPath));
        assert.deepEqual(yield* queue.listPending({ limit: 10 }), []);
      }),
    );
  },
);

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("removes unreferenced attachment files when a thread is reverted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("Thread Revert.Files");
      const keepAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000001";
      const removeAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000002";
      const otherThreadAttachmentId =
        "thread-revert-files-extra-00000000-0000-4000-8000-000000000003";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-revert-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-revert-files"),
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-revert-files"),
          title: "Project Revert Files",
          workspaceRoot: "/tmp/project-revert-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-revert-files-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-revert-files"),
          title: "Thread Revert Files",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-files-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-3"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make("turn-keep"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert-files/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("message-keep"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-4"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-keep"),
          role: "assistant",
          text: "Keep",
          attachments: [
            {
              type: "image",
              id: keepAttachmentId,
              name: "keep.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make("turn-keep"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-files-5"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-5"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make("turn-remove"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert-files/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("message-remove"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-files-6"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-6"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-remove"),
          role: "assistant",
          text: "Remove",
          attachments: [
            {
              type: "image",
              id: removeAttachmentId,
              name: "remove.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make("turn-remove"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const keepPath = path.join(attachmentsDir, `${keepAttachmentId}.png`);
      const removePath = path.join(attachmentsDir, `${removeAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(keepPath, "keep");
      yield* fileSystem.writeFileString(removePath, "remove");
      const otherThreadPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.writeFileString(otherThreadPath, "other");
      assert.isTrue(yield* exists(keepPath));
      assert.isTrue(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.make("evt-revert-files-7"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-revert-files-7"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-files-7"),
        metadata: {},
        payload: {
          threadId,
          turnCount: 1,
        },
      });

      assert.isTrue(yield* exists(removePath));
      yield* drainProjectedAttachmentCleanup();
      assert.isTrue(yield* exists(keepPath));
      assert.isFalse(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-mixed-revert-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("revert prunes only unreferenced mixed attachments owned by the thread", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const { attachmentsDir } = yield* ServerConfig;
      const threadId = ThreadId.make("Thread Cleanup.Mixed");
      const now = "2026-01-01T00:00:00.000Z";
      const keepDocument: ChatAttachment = {
        type: "document",
        id: "thread-cleanup-mixed-00000000-0000-4000-8000-000000000001",
        name: "keep.pdf",
        mimeType: "application/pdf",
        sizeBytes: 5,
      };
      const sharedFile: ChatAttachment = {
        type: "file",
        id: "thread-cleanup-mixed-00000000-0000-4000-8000-000000000002",
        name: "shared.ts",
        mimeType: "text/plain",
        sizeBytes: 5,
      };
      const keepLegacyImage: ChatAttachment = {
        type: "image",
        id: "thread-cleanup-mixed-00000000-0000-4000-8000-000000000003",
        name: "legacy-image",
        mimeType: "image/x-legacy",
        sizeBytes: 5,
      };
      const removeDocument: ChatAttachment = {
        type: "document",
        id: "thread-cleanup-mixed-00000000-0000-4000-8000-000000000004",
        name: "remove.pdf",
        mimeType: "application/pdf",
        sizeBytes: 5,
      };
      const removeFile: ChatAttachment = {
        type: "file",
        id: "thread-cleanup-mixed-00000000-0000-4000-8000-000000000005",
        name: "remove.json",
        mimeType: "application/json",
        sizeBytes: 5,
      };
      const removeLegacyImage: ChatAttachment = {
        type: "image",
        id: "thread-cleanup-mixed-00000000-0000-4000-8000-000000000006",
        name: "legacy-image",
        mimeType: "image/x-legacy",
        sizeBytes: 5,
      };
      const otherThreadFile: ChatAttachment = {
        type: "file",
        id: "thread-cleanup-mixed-other-00000000-0000-4000-8000-000000000007",
        name: "other.md",
        mimeType: "text/markdown",
        sizeBytes: 5,
      };

      yield* sql`
          INSERT INTO projection_turns (
            thread_id,
            turn_id,
            pending_message_id,
            source_proposed_plan_thread_id,
            source_proposed_plan_id,
            assistant_message_id,
            state,
            requested_at,
            started_at,
            completed_at,
            checkpoint_turn_count,
            checkpoint_ref,
            checkpoint_status,
            checkpoint_files_json
          )
          VALUES
            (
              ${threadId},
              'turn-keep-mixed',
              NULL,
              NULL,
              NULL,
              'message-keep-mixed',
              'completed',
              ${now},
              ${now},
              ${now},
              1,
              'refs/t3/checkpoints/thread-cleanup-mixed/turn/1',
              'ready',
              '[]'
            ),
            (
              ${threadId},
              'turn-remove-mixed',
              NULL,
              NULL,
              NULL,
              'message-remove-mixed',
              'completed',
              ${now},
              ${now},
              ${now},
              2,
              'refs/t3/checkpoints/thread-cleanup-mixed/turn/2',
              'ready',
              '[]'
            )
        `;
      yield* sql`
          INSERT INTO projection_thread_messages (
            message_id,
            thread_id,
            turn_id,
            role,
            text,
            attachments_json,
            is_streaming,
            created_at,
            updated_at
          )
          VALUES
            (
              'message-keep-mixed',
              ${threadId},
              'turn-keep-mixed',
              'assistant',
              'keep',
              ${encodeAttachmentsJson([keepDocument, sharedFile, keepLegacyImage])},
              0,
              ${now},
              ${now}
            ),
            (
              'message-remove-mixed',
              ${threadId},
              'turn-remove-mixed',
              'assistant',
              'remove',
              ${encodeAttachmentsJson([removeDocument, removeFile, sharedFile, removeLegacyImage])},
              0,
              '2026-01-01T00:00:01.000Z',
              '2026-01-01T00:00:01.000Z'
            )
        `;

      const attachmentPaths = new Map(
        [
          keepDocument,
          sharedFile,
          keepLegacyImage,
          removeDocument,
          removeFile,
          removeLegacyImage,
          otherThreadFile,
        ].map(
          (attachment) =>
            [attachment.id, path.join(attachmentsDir, attachmentRelativePath(attachment))] as const,
        ),
      );
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      for (const attachmentPath of attachmentPaths.values()) {
        yield* fileSystem.writeFileString(attachmentPath, "attachment");
      }

      const savedEvent = yield* eventStore.append({
        type: "thread.reverted",
        eventId: EventId.make("evt-mixed-revert"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:02.000Z",
        commandId: CommandId.make("cmd-mixed-revert"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-mixed-revert"),
        metadata: {},
        payload: {
          threadId,
          turnCount: 1,
        },
      });
      yield* projectionPipeline.projectEvent(savedEvent);

      assert.isTrue(yield* exists(attachmentPaths.get(removeDocument.id)!));
      yield* drainProjectedAttachmentCleanup();
      assert.isTrue(yield* exists(attachmentPaths.get(keepDocument.id)!));
      assert.isTrue(yield* exists(attachmentPaths.get(sharedFile.id)!));
      assert.isTrue(yield* exists(attachmentPaths.get(keepLegacyImage.id)!));
      assert.isFalse(yield* exists(attachmentPaths.get(removeDocument.id)!));
      assert.isFalse(yield* exists(attachmentPaths.get(removeFile.id)!));
      assert.isFalse(yield* exists(attachmentPaths.get(removeLegacyImage.id)!));
      assert.isTrue(yield* exists(attachmentPaths.get(otherThreadFile.id)!));
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-revert-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("removes thread attachment directory when thread is deleted", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const { attachmentsDir } = yield* ServerConfig;
        const now = "2026-01-01T00:00:00.000Z";
        const threadId = ThreadId.make("Thread Delete.Files");
        const attachmentId = "thread-delete-files-00000000-0000-4000-8000-000000000001";
        const otherThreadAttachmentId =
          "thread-delete-files-extra-00000000-0000-4000-8000-000000000002";

        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-delete-files-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-delete-files"),
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-delete-files"),
            title: "Project Delete Files",
            workspaceRoot: "/tmp/project-delete-files",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-delete-files-2"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-2"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make("project-delete-files"),
            title: "Thread Delete Files",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-delete-files-3"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-3"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("message-delete-files"),
            role: "user",
            text: "Delete",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "delete.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        const threadAttachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
        const otherThreadAttachmentPath = path.join(
          attachmentsDir,
          `${otherThreadAttachmentId}.png`,
        );
        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(threadAttachmentPath, "delete");
        yield* fileSystem.writeFileString(otherThreadAttachmentPath, "other-thread");
        assert.isTrue(yield* exists(threadAttachmentPath));
        assert.isTrue(yield* exists(otherThreadAttachmentPath));

        yield* appendAndProject({
          type: "thread.deleted",
          eventId: EventId.make("evt-delete-files-4"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make("cmd-delete-files-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-delete-files-4"),
          metadata: {},
          payload: {
            threadId,
            deletedAt: now,
          },
        });

        assert.isTrue(yield* exists(threadAttachmentPath));
        yield* drainProjectedAttachmentCleanup();
        assert.isFalse(yield* exists(threadAttachmentPath));
        assert.isTrue(yield* exists(otherThreadAttachmentPath));
      }),
    );
  },
);

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-mixed-delete-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("thread deletion removes every attachment kind for only the owning thread", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const threadId = ThreadId.make("Thread Delete.Mixed");
      const attachments: ReadonlyArray<ChatAttachment> = [
        {
          type: "image",
          id: "thread-delete-mixed-00000000-0000-4000-8000-000000000001",
          name: "legacy-image",
          mimeType: "image/x-legacy",
          sizeBytes: 5,
        },
        {
          type: "document",
          id: "thread-delete-mixed-00000000-0000-4000-8000-000000000002",
          name: "delete.pdf",
          mimeType: "application/pdf",
          sizeBytes: 5,
        },
        {
          type: "file",
          id: "thread-delete-mixed-00000000-0000-4000-8000-000000000003",
          name: "delete.ts",
          mimeType: "text/plain",
          sizeBytes: 5,
        },
      ];
      const otherThreadAttachments: ReadonlyArray<ChatAttachment> = [
        {
          type: "document",
          id: "thread-delete-mixed-other-00000000-0000-4000-8000-000000000004",
          name: "keep.pdf",
          mimeType: "application/pdf",
          sizeBytes: 5,
        },
        {
          type: "file",
          id: "thread-delete-mixed-other-00000000-0000-4000-8000-000000000005",
          name: "keep.json",
          mimeType: "application/json",
          sizeBytes: 5,
        },
      ];
      const attachmentPaths = [...attachments, ...otherThreadAttachments].map((attachment) =>
        path.join(attachmentsDir, attachmentRelativePath(attachment)),
      );

      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      for (const attachmentPath of attachmentPaths) {
        yield* fileSystem.writeFileString(attachmentPath, "attachment");
      }

      const savedEvent = yield* eventStore.append({
        type: "thread.deleted",
        eventId: EventId.make("evt-delete-mixed"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:00.000Z",
        commandId: CommandId.make("cmd-delete-mixed"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-delete-mixed"),
        metadata: {},
        payload: {
          threadId,
          deletedAt: "2026-01-01T00:00:00.000Z",
        },
      });
      yield* projectionPipeline.projectEvent(savedEvent);

      for (const attachmentPath of attachmentPaths.slice(0, attachments.length)) {
        assert.isTrue(yield* exists(attachmentPath));
      }
      yield* drainProjectedAttachmentCleanup();
      for (const attachmentPath of attachmentPaths.slice(0, attachments.length)) {
        assert.isFalse(yield* exists(attachmentPath));
      }
      for (const attachmentPath of attachmentPaths.slice(attachments.length)) {
        assert.isTrue(yield* exists(attachmentPath));
      }
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-delete-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("ignores unsafe thread ids for attachment cleanup paths", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const now = "2026-01-01T00:00:00.000Z";
        const { attachmentsDir: attachmentsRootDir, stateDir } = yield* ServerConfig;
        const attachmentsSentinelPath = path.join(attachmentsRootDir, "sentinel.txt");
        const stateDirSentinelPath = path.join(stateDir, "state-sentinel.txt");
        yield* fileSystem.makeDirectory(attachmentsRootDir, { recursive: true });
        yield* fileSystem.writeFileString(attachmentsSentinelPath, "keep-attachments-root");
        yield* fileSystem.writeFileString(stateDirSentinelPath, "keep-state-dir");

        yield* eventStore.append({
          type: "thread.deleted",
          eventId: EventId.make("evt-unsafe-thread-delete"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make(".."),
          occurredAt: now,
          commandId: CommandId.make("cmd-unsafe-thread-delete"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-unsafe-thread-delete"),
          metadata: {},
          payload: {
            threadId: ThreadId.make(".."),
            deletedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        assert.isTrue(yield* exists(attachmentsRootDir));
        assert.isTrue(yield* exists(attachmentsSentinelPath));
        assert.isTrue(yield* exists(stateDirSentinelPath));
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("resumes from projector last_applied_sequence without replaying older events", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-a1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-a"),
          title: "Project A",
          workspaceRoot: "/tmp/project-a",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-a2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          projectId: ProjectId.make("project-a"),
          title: "Thread A",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-a4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-a"),
        occurredAt: now,
        commandId: CommandId.make("cmd-a4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-a4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE message_id = 'message-a'
      `;
      assert.deepEqual(messageRows, [{ text: "hello world" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `;
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const maxSequence = maxSequenceRows[0]?.maxSequence ?? 0;
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, maxSequence);
      }
    }),
  );

  it.effect("keeps the turn running across interim assistant messages until the session ends", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-turn-lifecycle");
      const turnId = TurnId.make("turn-lifecycle-1");

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-tl1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-tl1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl1"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-turn-lifecycle"),
          title: "Turn lifecycle",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude"),
            model: "claude-opus",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-tl2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: CommandId.make("cmd-tl2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
        },
      });

      // Interim assistant message completes mid-turn (commentary between
      // tool calls) — the turn must stay running and unsettled.
      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-tl3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:05.000Z",
        commandId: CommandId.make("cmd-tl3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl3"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-tl-interim"),
          role: "assistant",
          text: "interim commentary",
          turnId,
          streaming: false,
          createdAt: "2026-01-01T00:00:05.000Z",
          updatedAt: "2026-01-01T00:00:05.000Z",
        },
      });

      yield* projectionPipeline.bootstrap;

      const runningRows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;
      assert.deepEqual(runningRows, [{ state: "running", completedAt: null }]);

      // The session leaving "running" is the turn-end signal.
      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-tl4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:01:00.000Z",
        commandId: CommandId.make("cmd-tl4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tl4"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:01:00.000Z",
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const settledRows = yield* sql<{
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;
      assert.deepEqual(settledRows, [
        { state: "completed", completedAt: "2026-01-01T00:01:00.000Z" },
      ]);
    }),
  );

  it.effect("keeps the thread pointing at the turn that just ended", () =>
    Effect.gen(function* () {
      // A session going idle reports `activeTurnId: null`, which used to clear
      // `latest_turn_id` and leave the thread unable to name its own last turn.
      // The turn diff normally restored the pointer a moment later, but a
      // provider that reports its diff mid-turn (codex does) never sends one at
      // turn end, so the thread stayed pointerless — and the thread task
      // reactor, which reads "no latest turn" as "still working", never
      // recorded the task's result.
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-turn-pointer");
      const turnId = TurnId.make("turn-pointer-1");

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-tp1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-tp1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tp1"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-turn-pointer"),
          title: "Turn pointer",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-tp2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: CommandId.make("cmd-tp2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tp2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
        },
      });

      // The provider reports its diff as soon as it edits files — well before
      // the turn ends — so nothing restores the pointer afterwards.
      yield* eventStore.append({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-tp3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:00:10.000Z",
        commandId: CommandId.make("cmd-tp3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tp3"),
        metadata: {},
        payload: {
          threadId,
          turnId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("provider-diff:evt-tp3"),
          status: "missing",
          files: [],
          assistantMessageId: MessageId.make("message-tp-1"),
          completedAt: "2026-01-01T00:00:10.000Z",
        },
      });

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-tp4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-01-01T00:01:00.000Z",
        commandId: CommandId.make("cmd-tp4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-tp4"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:01:00.000Z",
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(rows, [{ latestTurnId: turnId }]);
    }),
  );

  it.effect("settles a superseded running turn when a new turn becomes active", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-turn-supersede");
      const oldTurnId = TurnId.make("turn-superseded");
      const newTurnId = TurnId.make("turn-steer");

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-ts1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("cmd-ts1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-ts1"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-turn-supersede"),
          title: "Turn supersede",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "big-pickle",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      const appendRunningSessionSet = (eventId: string, turnId: TurnId, updatedAt: string) =>
        eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make(eventId),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: updatedAt,
          commandId: CommandId.make(`cmd-${eventId}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-${eventId}`),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "opencode",
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt,
            },
          },
        });

      yield* appendRunningSessionSet("evt-ts2", oldTurnId, "2026-01-01T00:00:01.000Z");
      // A steer: a new turn becomes active without the provider ever
      // completing the previous one.
      yield* appendRunningSessionSet("evt-ts3", newTurnId, "2026-01-01T00:00:30.000Z");

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly turnId: string;
        readonly state: string;
        readonly completedAt: string | null;
      }>`
        SELECT turn_id AS "turnId", state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
        ORDER BY requested_at
      `;
      assert.deepEqual(rows, [
        { turnId: oldTurnId, state: "completed", completedAt: "2026-01-01T00:00:30.000Z" },
        { turnId: newTurnId, state: "running", completedAt: null },
      ]);
    }),
  );

  it.effect("keeps accumulated assistant text when completion payload text is empty", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-empty-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-empty"),
          title: "Project Empty",
          workspaceRoot: "/tmp/project-empty",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-empty-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          projectId: ProjectId.make("project-empty"),
          title: "Thread Empty",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: "Hello",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-empty-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-empty"),
        occurredAt: now,
        commandId: CommandId.make("cmd-empty-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-empty-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-empty"),
          messageId: MessageId.make("assistant-empty"),
          role: "assistant",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string; readonly isStreaming: unknown }>`
        SELECT
          text,
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE message_id = 'assistant-empty'
      `;
      assert.equal(messageRows.length, 1);
      assert.equal(messageRows[0]?.text, "Hello world");
      assert.isFalse(Boolean(messageRows[0]?.isStreaming));
    }),
  );

  it.effect(
    "resolves turn-count conflicts when checkpoint completion rewrites provisional turns",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-conflict-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-conflict"),
          occurredAt: "2026-02-26T13:00:00.000Z",
          commandId: CommandId.make("cmd-conflict-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-conflict"),
            title: "Project Conflict",
            workspaceRoot: "/tmp/project-conflict",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-02-26T13:00:00.000Z",
            updatedAt: "2026-02-26T13:00:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-conflict-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:01.000Z",
          commandId: CommandId.make("cmd-conflict-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            projectId: ProjectId.make("project-conflict"),
            title: "Thread Conflict",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-02-26T13:00:01.000Z",
            updatedAt: "2026-02-26T13:00:01.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-interrupt-requested",
          eventId: EventId.make("evt-conflict-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:02.000Z",
          commandId: CommandId.make("cmd-conflict-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            turnId: TurnId.make("turn-interrupted"),
            createdAt: "2026-02-26T13:00:02.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-conflict-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:03.000Z",
          commandId: CommandId.make("cmd-conflict-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            messageId: MessageId.make("assistant-conflict"),
            role: "assistant",
            text: "done",
            turnId: TurnId.make("turn-completed"),
            streaming: false,
            createdAt: "2026-02-26T13:00:03.000Z",
            updatedAt: "2026-02-26T13:00:03.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.make("evt-conflict-5"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-conflict"),
          occurredAt: "2026-02-26T13:00:04.000Z",
          commandId: CommandId.make("cmd-conflict-5"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-conflict-5"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-conflict"),
            turnId: TurnId.make("turn-completed"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-conflict/turn/1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-conflict"),
            completedAt: "2026-02-26T13:00:04.000Z",
          },
        });

        const turnRows = yield* sql<{
          readonly turnId: string;
          readonly checkpointTurnCount: number | null;
          readonly status: string;
        }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          state AS "status"
        FROM projection_turns
        WHERE thread_id = 'thread-conflict'
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC
      `;
        assert.deepEqual(turnRows, [
          { turnId: "turn-completed", checkpointTurnCount: 1, status: "completed" },
          { turnId: "turn-interrupted", checkpointTurnCount: null, status: "interrupted" },
        ]);
      }),
  );

  it.effect("folds in-session agent activities onto the spawning thread", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-native-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-native"),
        occurredAt: "2026-07-29T10:00:00.000Z",
        commandId: CommandId.make("cmd-native-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-native-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-native"),
          title: "Project Native",
          workspaceRoot: "/tmp/project-native",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-07-29T10:00:00.000Z",
          updatedAt: "2026-07-29T10:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-native-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-native"),
        occurredAt: "2026-07-29T10:00:01.000Z",
        commandId: CommandId.make("cmd-native-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-native-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-native"),
          projectId: ProjectId.make("project-native"),
          title: "Thread Native",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-07-29T10:00:01.000Z",
          updatedAt: "2026-07-29T10:00:01.000Z",
        },
      });

      const nativeActivity = (
        suffix: string,
        kind: string,
        payload: Record<string, unknown>,
        at: string,
      ) =>
        appendAndProject({
          type: "thread.activity-appended",
          eventId: EventId.make(`evt-native-${suffix}`),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-native"),
          occurredAt: at,
          commandId: CommandId.make(`cmd-native-${suffix}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-native-${suffix}`),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-native"),
            activity: {
              id: EventId.make(`activity-native-${suffix}`),
              tone: "info",
              kind,
              summary: kind,
              payload,
              turnId: null,
              createdAt: at,
            },
          },
        });

      yield* nativeActivity(
        "3",
        "task.started",
        { taskId: "w1", description: "Map handlers", subagentType: "Explore" },
        "2026-07-29T10:00:02.000Z",
      );
      yield* nativeActivity(
        "4",
        "task.progress",
        { taskId: "w1", description: "scanning session/*", summary: "7 of 12 checked" },
        "2026-07-29T10:00:03.000Z",
      );

      const readAgents = Effect.map(
        sql<{ readonly nativeAgents: string | null }>`
          SELECT native_agents_json AS "nativeAgents"
          FROM projection_threads
          WHERE thread_id = 'thread-native'
        `,
        (rows) =>
          rows[0]?.nativeAgents === null || rows[0]?.nativeAgents === undefined
            ? []
            : (JSON.parse(rows[0].nativeAgents) as ReadonlyArray<Record<string, unknown>>),
      );

      const running = yield* readAgents;
      assert.equal(running.length, 1);
      assert.deepInclude(running[0], {
        taskId: "w1",
        status: "running",
        // The label survives `task.progress`, whose `description` is rolling
        // progress text rather than a name.
        description: "Map handlers",
        subagentType: "Explore",
        progressSummary: "7 of 12 checked",
      });

      yield* nativeActivity(
        "5",
        "task.completed",
        { taskId: "w1", status: "completed", summary: "3 gaps found" },
        "2026-07-29T10:00:04.000Z",
      );

      const finished = yield* readAgents;
      assert.equal(finished.length, 1);
      assert.deepInclude(finished[0], {
        taskId: "w1",
        status: "finished",
        description: "Map handlers",
        resultSummary: "3 gaps found",
      });
    }),
  );

  it.effect("persists Codex in-session agents, which label no subagent type", () =>
    Effect.gen(function* () {
      // The reproduction, at the projection layer: three Codex collab agents,
      // identified only by the canonical `nativeAgent` marker. Before this
      // change none of them reached `native_agents_json` at all.
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-codex-native-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-codex-native"),
        occurredAt: "2026-07-30T10:00:00.000Z",
        commandId: CommandId.make("cmd-codex-native-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-codex-native-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-codex-native"),
          title: "Project Codex Native",
          workspaceRoot: "/tmp/project-codex-native",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-07-30T10:00:00.000Z",
          updatedAt: "2026-07-30T10:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-codex-native-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-codex-native"),
        occurredAt: "2026-07-30T10:00:01.000Z",
        commandId: CommandId.make("cmd-codex-native-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-codex-native-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-codex-native"),
          projectId: ProjectId.make("project-codex-native"),
          title: "Thread Codex Native",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-07-30T10:00:01.000Z",
          updatedAt: "2026-07-30T10:00:01.000Z",
        },
      });

      let sequence = 2;
      const codexActivity = (kind: string, payload: Record<string, unknown>, at: string) => {
        sequence += 1;
        const suffix = String(sequence);
        return appendAndProject({
          type: "thread.activity-appended",
          eventId: EventId.make(`evt-codex-native-${suffix}`),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-codex-native"),
          occurredAt: at,
          commandId: CommandId.make(`cmd-codex-native-${suffix}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-codex-native-${suffix}`),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-codex-native"),
            activity: {
              id: EventId.make(`activity-codex-native-${suffix}`),
              tone: "info",
              kind,
              summary: kind,
              payload,
              turnId: null,
              createdAt: at,
            },
          },
        });
      };

      const readAgents = Effect.map(
        sql<{ readonly nativeAgents: string | null }>`
          SELECT native_agents_json AS "nativeAgents"
          FROM projection_threads
          WHERE thread_id = 'thread-codex-native'
        `,
        (rows) =>
          rows[0]?.nativeAgents === null || rows[0]?.nativeAgents === undefined
            ? []
            : (JSON.parse(rows[0].nativeAgents) as ReadonlyArray<Record<string, unknown>>),
      );

      const children = ["child-a", "child-b", "child-c"] as const;
      let at = 2;
      for (const child of children) {
        at += 1;
        yield* codexActivity(
          "task.started",
          {
            taskId: child,
            taskType: "subagent",
            nativeAgent: true,
            description: `Inspect ${child}`,
          },
          `2026-07-30T10:00:0${at}.000Z`,
        );
      }

      // The parent thread shows three agents while they run.
      const running = yield* readAgents;
      assert.equal(running.length, 3);
      assert.deepEqual(
        running.map((agent) => agent.taskId),
        [...children],
      );
      assert.isTrue(running.every((agent) => agent.status === "running"));

      // A backgrounded shell on the same channel must not become a fourth row.
      yield* codexActivity(
        "task.started",
        { taskId: "shell-1", taskType: "local_bash", description: "Serve the mockups" },
        "2026-07-30T10:00:07.000Z",
      );
      assert.equal((yield* readAgents).length, 3);

      yield* codexActivity(
        "task.progress",
        {
          taskId: "child-a",
          description: "reading files",
          summary: "reading files",
          nativeAgent: true,
        },
        "2026-07-30T10:00:08.000Z",
      );
      yield* codexActivity(
        "task.completed",
        { taskId: "child-a", status: "completed", nativeAgent: true, summary: "summarized" },
        "2026-07-30T10:00:09.000Z",
      );
      yield* codexActivity(
        "task.completed",
        { taskId: "child-b", status: "failed", nativeAgent: true, error: "worker died" },
        "2026-07-30T10:00:10.000Z",
      );
      // Cancelled with the turn rather than reporting its own outcome.
      yield* codexActivity(
        "task.completed",
        { taskId: "child-c", status: "stopped", nativeAgent: true },
        "2026-07-30T10:00:11.000Z",
      );

      const settled = yield* readAgents;
      assert.equal(settled.length, 3);
      // Every agent reaches a terminal state, and all three stay visible after
      // the parent response finishes.
      assert.deepEqual(
        settled.map((agent) => [agent.taskId, agent.status]),
        [
          ["child-a", "finished"],
          ["child-b", "failed"],
          ["child-c", "finished"],
        ],
      );
      assert.deepInclude(settled[0], {
        description: "Inspect child-a",
        progressSummary: "reading files",
        resultSummary: "summarized",
      });
      assert.deepInclude(settled[1], { errorMessage: "worker died" });
      // Codex reported no counters, so none are invented.
      assert.isUndefined(settled[2]?.usage);
      assert.isUndefined(settled[2]?.subagentType);
    }),
  );

  it.effect("clears stale pending approvals from projected shell summaries", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-stale-approval-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-stale-approval"),
        occurredAt: "2026-02-26T12:30:00.000Z",
        commandId: CommandId.make("cmd-stale-approval-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-stale-approval"),
          title: "Project Stale Approval",
          workspaceRoot: "/tmp/project-stale-approval",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:30:00.000Z",
          updatedAt: "2026-02-26T12:30:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-stale-approval-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:01.000Z",
        commandId: CommandId.make("cmd-stale-approval-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          projectId: ProjectId.make("project-stale-approval"),
          title: "Thread Stale Approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:30:01.000Z",
          updatedAt: "2026-02-26T12:30:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-approval-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:02.000Z",
        commandId: CommandId.make("cmd-stale-approval-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          activity: {
            id: EventId.make("activity-stale-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-stale-1",
              requestKind: "command",
            },
            turnId: null,
            createdAt: "2026-02-26T12:30:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-approval-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-approval"),
        occurredAt: "2026-02-26T12:30:03.000Z",
        commandId: CommandId.make("cmd-stale-approval-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-approval-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-approval"),
          activity: {
            id: EventId.make("activity-stale-approval-failed"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-stale-1",
              detail: "Unknown pending permission request: approval-request-stale-1",
            },
            turnId: null,
            createdAt: "2026-02-26T12:30:03.000Z",
          },
        },
      });

      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id = 'approval-request-stale-1'
      `;
      assert.deepEqual(approvalRows, [
        {
          requestId: "approval-request-stale-1",
          status: "resolved",
          resolvedAt: "2026-02-26T12:30:03.000Z",
        },
      ]);

      const threadRows = yield* sql<{
        readonly pendingApprovalCount: number;
      }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = 'thread-stale-approval'
      `;
      assert.deepEqual(threadRows, [{ pendingApprovalCount: 0 }]);
    }),
  );

  it.effect("clears stale pending user input from projected shell summaries", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-stale-user-input-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-stale-user-input"),
        occurredAt: "2026-02-26T12:35:00.000Z",
        commandId: CommandId.make("cmd-stale-user-input-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-stale-user-input"),
          title: "Project Stale User Input",
          workspaceRoot: "/tmp/project-stale-user-input",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:35:00.000Z",
          updatedAt: "2026-02-26T12:35:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-stale-user-input-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-user-input"),
        occurredAt: "2026-02-26T12:35:01.000Z",
        commandId: CommandId.make("cmd-stale-user-input-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-user-input"),
          projectId: ProjectId.make("project-stale-user-input"),
          title: "Thread Stale User Input",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:35:01.000Z",
          updatedAt: "2026-02-26T12:35:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-user-input-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-user-input"),
        occurredAt: "2026-02-26T12:35:02.000Z",
        commandId: CommandId.make("cmd-stale-user-input-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-user-input"),
          activity: {
            id: EventId.make("activity-stale-user-input-requested"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId: "user-input-request-stale-1",
              questions: [
                {
                  id: "sandbox_mode",
                  header: "Sandbox",
                  question: "Which mode should be used?",
                  options: [
                    {
                      label: "workspace-write",
                      description: "Allow workspace writes only",
                    },
                  ],
                },
              ],
            },
            turnId: null,
            createdAt: "2026-02-26T12:35:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-stale-user-input-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-stale-user-input"),
        occurredAt: "2026-02-26T12:35:03.000Z",
        commandId: CommandId.make("cmd-stale-user-input-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-stale-user-input-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-stale-user-input"),
          activity: {
            id: EventId.make("activity-stale-user-input-failed"),
            tone: "error",
            kind: "provider.user-input.respond.failed",
            summary: "Provider user input response failed",
            payload: {
              requestId: "user-input-request-stale-1",
              detail:
                "Provider adapter request failed (codex) for item/tool/requestUserInput: Unknown pending Codex user input request: user-input-request-stale-1",
            },
            turnId: null,
            createdAt: "2026-02-26T12:35:03.000Z",
          },
        },
      });

      const threadRows = yield* sql<{
        readonly pendingUserInputCount: number;
      }>`
        SELECT pending_user_input_count AS "pendingUserInputCount"
        FROM projection_threads
        WHERE thread_id = 'thread-stale-user-input'
      `;
      assert.deepEqual(threadRows, [{ pendingUserInputCount: 0 }]);
    }),
  );

  it.effect("ignores non-stale provider approval response failures", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-nonstale-approval-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:00.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-nonstale-approval"),
          title: "Project Non-Stale Approval",
          workspaceRoot: "/tmp/project-nonstale-approval",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:45:00.000Z",
          updatedAt: "2026-02-26T12:45:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-nonstale-approval-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:01.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          projectId: ProjectId.make("project-nonstale-approval"),
          title: "Thread Non-Stale Approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:45:01.000Z",
          updatedAt: "2026-02-26T12:45:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:02.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-requested"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-nonstale-existing",
              requestKind: "command",
            },
            turnId: null,
            createdAt: "2026-02-26T12:45:02.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:03.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-failed-existing"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-nonstale-existing",
              detail: "Provider timed out while responding to approval request",
            },
            turnId: TurnId.make("turn-nonstale-failure"),
            createdAt: "2026-02-26T12:45:03.000Z",
          },
        },
      });

      yield* appendAndProject({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-nonstale-approval-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-nonstale-approval"),
        occurredAt: "2026-02-26T12:45:04.000Z",
        commandId: CommandId.make("cmd-nonstale-approval-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-nonstale-approval-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-nonstale-approval"),
          activity: {
            id: EventId.make("activity-nonstale-approval-failed-missing"),
            tone: "error",
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            payload: {
              requestId: "approval-request-nonstale-missing",
              detail: "Provider timed out while responding to approval request",
            },
            turnId: null,
            createdAt: "2026-02-26T12:45:04.000Z",
          },
        },
      });

      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly turnId: string | null;
        readonly createdAt: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          turn_id AS "turnId",
          created_at AS "createdAt",
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id IN (
          'approval-request-nonstale-existing',
          'approval-request-nonstale-missing'
        )
        ORDER BY request_id
      `;
      assert.deepEqual(approvalRows, [
        {
          requestId: "approval-request-nonstale-existing",
          status: "pending",
          turnId: null,
          createdAt: "2026-02-26T12:45:02.000Z",
          resolvedAt: null,
        },
      ]);

      const threadRows = yield* sql<{
        readonly pendingApprovalCount: number;
      }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = 'thread-nonstale-approval'
      `;
      assert.deepEqual(threadRows, [{ pendingApprovalCount: 1 }]);
    }),
  );

  it.effect("does not fallback-retain messages whose turnId is removed by revert", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-revert-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-revert"),
        occurredAt: "2026-02-26T12:00:00.000Z",
        commandId: CommandId.make("cmd-revert-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.make("project-revert"),
          title: "Project Revert",
          workspaceRoot: "/tmp/project-revert",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:00:00.000Z",
          updatedAt: "2026-02-26T12:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-revert-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: CommandId.make("cmd-revert-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          projectId: ProjectId.make("project-revert"),
          title: "Thread Revert",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:00:01.000Z",
          updatedAt: "2026-02-26T12:00:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: CommandId.make("cmd-revert-3"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-keep"),
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: CommandId.make("cmd-revert-4"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("assistant-keep"),
          role: "assistant",
          text: "kept",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.make("evt-revert-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: CommandId.make("cmd-revert-5"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnId: TurnId.make("turn-2"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-revert/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("assistant-remove"),
          completedAt: "2026-02-26T12:00:03.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-6"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.050Z",
        commandId: CommandId.make("cmd-revert-6"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-6"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("user-remove"),
          role: "user",
          text: "removed",
          turnId: TurnId.make("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.050Z",
          updatedAt: "2026-02-26T12:00:03.050Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-revert-7"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.100Z",
        commandId: CommandId.make("cmd-revert-7"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-7"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          messageId: MessageId.make("assistant-remove"),
          role: "assistant",
          text: "removed",
          turnId: TurnId.make("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.100Z",
          updatedAt: "2026-02-26T12:00:03.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.make("evt-revert-8"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-revert"),
        occurredAt: "2026-02-26T12:00:04.000Z",
        commandId: CommandId.make("cmd-revert-8"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-revert-8"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-revert"),
          turnCount: 1,
        },
      });

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
        readonly role: string;
      }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          role
        FROM projection_thread_messages
        WHERE thread_id = 'thread-revert'
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messageRows, [
        {
          messageId: "assistant-keep",
          turnId: "turn-1",
          role: "assistant",
        },
      ]);
    }),
  );
});

it.layer(makeProjectionPipelinePrefixedTestLayer("t3-pending-turn-terminal-test-"))(
  "OrchestrationProjectionPipeline pending turn cleanup",
  (it) => {
    it.effect("clears pending turn starts when startup reaches a terminal session state", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;

        for (const [index, status] of (["error", "interrupted", "stopped"] as const).entries()) {
          const threadId = ThreadId.make(`thread-terminal-${status}`);
          const requestedAt = `2026-02-26T14:00:0${index}.000Z`;
          yield* eventStore.append({
            type: "thread.turn-start-requested",
            eventId: EventId.make(`evt-terminal-pending-${status}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: requestedAt,
            commandId: CommandId.make(`cmd-terminal-pending-${status}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-terminal-pending-${status}`),
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.make(`message-terminal-${status}`),
              runtimeMode: "approval-required",
              createdAt: requestedAt,
            },
          });
          yield* eventStore.append({
            type: "thread.session-set",
            eventId: EventId.make(`evt-terminal-session-${status}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: requestedAt,
            commandId: CommandId.make(`cmd-terminal-session-${status}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-terminal-session-${status}`),
            metadata: {},
            payload: {
              threadId,
              session: {
                threadId,
                status,
                providerName: "codex",
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: status === "error" ? "startup failed" : null,
                updatedAt: requestedAt,
              },
            },
          });
        }

        yield* projectionPipeline.bootstrap;

        const pendingRows = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId"
          FROM projection_turns
          WHERE turn_id IS NULL
            AND state = 'pending'
        `;
        assert.deepEqual(pendingRows, []);
      }),
    );
  },
);

it.effect("restores pending turn-start metadata across projection pipeline restart", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const firstProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );
    const secondProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );

    const threadId = ThreadId.make("thread-restart");
    const turnId = TurnId.make("turn-restart");
    const messageId = MessageId.make("message-restart");
    const sourcePlanThreadId = ThreadId.make("thread-plan-source");
    const sourcePlanId = "plan-source";
    const turnStartedAt = "2026-02-26T14:00:00.000Z";
    const sessionSetAt = "2026-02-26T14:00:05.000Z";

    yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;

      yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.make("evt-restart-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: turnStartedAt,
        commandId: CommandId.make("cmd-restart-1"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-restart-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          sourceProposedPlan: {
            threadId: sourcePlanThreadId,
            planId: sourcePlanId,
          },
          runtimeMode: "approval-required",
          createdAt: turnStartedAt,
        },
      });

      yield* projectionPipeline.bootstrap;
    }).pipe(Effect.provide(firstProjectionLayer));

    const turnRows = yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.make("evt-restart-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: sessionSetAt,
        commandId: CommandId.make("cmd-restart-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-restart-2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: sessionSetAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const pendingRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
      `;
      assert.deepEqual(pendingRows, []);

      return yield* sql<{
        readonly turnId: string;
        readonly userMessageId: string | null;
        readonly sourceProposedPlanThreadId: string | null;
        readonly sourceProposedPlanId: string | null;
        readonly startedAt: string;
      }>`
        SELECT
          turn_id AS "turnId",
          pending_message_id AS "userMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          started_at AS "startedAt"
        FROM projection_turns
        WHERE turn_id = ${turnId}
      `;
    }).pipe(Effect.provide(secondProjectionLayer));

    assert.deepEqual(turnRows, [
      {
        turnId: "turn-restart",
        userMessageId: "message-restart",
        sourceProposedPlanThreadId: "thread-plan-source",
        sourceProposedPlanId: "plan-source",
        startedAt: turnStartedAt,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-projection-pipeline-restart-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-projection-pipeline-engine-dispatch-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("OrchestrationProjectionPipeline via engine dispatch", (it) => {
  it.effect("round-trips mixed attachments through projection-backed thread history", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const createdAt = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-mixed-history");
      const attachments: ReadonlyArray<ChatAttachment> = [
        {
          type: "image",
          id: "thread-mixed-history-image",
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
        {
          type: "document",
          id: "thread-mixed-history-document",
          name: "reference.pdf",
          mimeType: "application/pdf",
          sizeBytes: 7,
        },
        {
          type: "file",
          id: "thread-mixed-history-file",
          name: "notes.ts",
          mimeType: "text/plain",
          sizeBytes: 9,
        },
      ];

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-mixed-history-project"),
        projectId: ProjectId.make("project-mixed-history"),
        title: "Mixed History Project",
        workspaceRoot: "/tmp/project-mixed-history",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-mixed-history-thread"),
        threadId,
        projectId: ProjectId.make("project-mixed-history"),
        title: "Mixed History Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-mixed-history-turn"),
        threadId,
        message: {
          messageId: MessageId.make("message-mixed-history"),
          role: "user",
          text: "Inspect these attachments",
          attachments,
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      });

      const history = yield* snapshotQuery.getThreadDetailSnapshot(threadId);
      assert.equal(history._tag, "Some");
      if (history._tag === "Some") {
        assert.deepEqual(history.value.thread.messages[0]?.attachments, attachments);
      }
    }),
  );

  it.effect("projects dispatched engine events immediately", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-01-01T00:00:00.000Z";

      const dispatched = yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-live-project"),
        projectId: ProjectId.make("project-live"),
        title: "Live Project",
        workspaceRoot: "/tmp/project-live",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      const projectRows = yield* sql<{ readonly title: string; readonly scriptsJson: string }>`
        SELECT
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
        WHERE project_id = 'project-live'
      `;
      assert.deepEqual(projectRows, [{ title: "Live Project", scriptsJson: "[]" }]);

      const projectorRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.projects'
      `;
      assert.deepEqual(projectorRows, [{ lastAppliedSequence: dispatched.sequence }]);
    }),
  );

  it.effect("projects persist updated scripts from project.meta.update", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-scripts-project-create"),
        projectId: ProjectId.make("project-scripts"),
        title: "Scripts Project",
        workspaceRoot: "/tmp/project-scripts",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make("cmd-scripts-project-update"),
        projectId: ProjectId.make("project-scripts"),
        scripts: [
          {
            id: "script-1",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ],
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        },
      });

      const projectRows = yield* sql<{
        readonly scriptsJson: string;
        readonly defaultModelSelection: string;
      }>`
        SELECT
          scripts_json AS "scriptsJson",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-scripts'
      `;
      assert.deepEqual(projectRows, [
        {
          scriptsJson:
            '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          defaultModelSelection: '{"instanceId":"codex","model":"gpt-5"}',
        },
      ]);
    }),
  );
});
