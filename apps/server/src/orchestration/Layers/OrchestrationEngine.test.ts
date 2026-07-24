import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type OrchestrationEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import { describe, expect, it } from "vite-plus/test";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

function makeFailingTransactionSqlLayer(consumeFailure: () => boolean) {
  return Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return new Proxy(sql, {
        get(target, property, receiver) {
          if (property !== "withTransaction") {
            return Reflect.get(target, property, receiver) as unknown;
          }
          return <R, E, A>(effect: Effect.Effect<A, E, R>) => {
            if (!consumeFailure()) {
              return sql.withTransaction(effect);
            }
            return sql.withTransaction(
              effect.pipe(
                Effect.flatMap(() =>
                  Effect.fail(
                    new SqlError.SqlError({
                      reason: new SqlError.UnknownError({
                        cause: "injected outer transaction failure",
                        message: "injected outer transaction failure",
                        operation: "COMMIT",
                      }),
                    }),
                  ),
                ),
              ),
            );
          };
        },
      });
    }),
  ).pipe(Layer.provide(SqlitePersistenceMemory));
}

async function createOrchestrationSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
  });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  return {
    engine,
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return "2026-01-01T00:00:00.000Z";
}

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

describe("OrchestrationEngine", () => {
  it("bootstraps command handling from persisted projections without reading the full snapshot", async () => {
    let nextSequence = 8;
    const eventStore: OrchestrationEventStoreShape = {
      append: (event) =>
        Effect.sync(() => {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as OrchestrationEvent;
          nextSequence += 1;
          return savedEvent;
        }),
      readFromSequence: () => Stream.empty,
      readAll: () =>
        Stream.fail(
          new PersistenceSqlError({
            operation: "test.readAll",
            detail: "historical replay should not be used during bootstrap",
          }),
        ),
    };

    const projectionSnapshot = {
      snapshotSequence: 7,
      updatedAt: "2026-03-03T00:00:04.000Z",
      projects: [
        {
          id: asProjectId("project-bootstrap"),
          title: "Bootstrap Project",
          workspaceRoot: "/tmp/project-bootstrap",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [],
          createdAt: "2026-03-03T00:00:00.000Z",
          updatedAt: "2026-03-03T00:00:01.000Z",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: ThreadId.make("thread-bootstrap"),
          projectId: asProjectId("project-bootstrap"),
          title: "Bootstrap Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access" as const,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-03-03T00:00:02.000Z",
          updatedAt: "2026-03-03T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
    };
    const commandReadModel = {
      ...projectionSnapshot,
      threads: projectionSnapshot.threads.map((thread) => ({
        ...thread,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      })),
    };
    let fullSnapshotReadCount = 0;
    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-orchestration-engine-bootstrap-test-",
    });

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(commandReadModel),
          getSnapshot: () =>
            Effect.sync(() => {
              fullSnapshotReadCount += 1;
              return projectionSnapshot;
            }),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: projectionSnapshot.snapshotSequence,
              projects: [],
              threads: [],
              updatedAt: projectionSnapshot.updatedAt,
            }),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: projectionSnapshot.snapshotSequence }),
          getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
          searchThreads: () => Effect.succeed({ matches: [] }),
          getActivityHistory: () => Effect.die("unused"),
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationProjectionPipeline, {
          bootstrap: Effect.void,
          projectEvent: () => Effect.void,
        } satisfies OrchestrationProjectionPipelineShape),
      ),
      Layer.provide(Layer.succeed(OrchestrationEventStore, eventStore)),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    expect(await runtime.runPromise(engine.latestSequence)).toBe(7);
    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-bootstrap-thread-update"),
        threadId: ThreadId.make("thread-bootstrap"),
        title: "Updated Bootstrap Thread",
      }),
    );

    expect(result.sequence).toBe(8);
    expect(await runtime.runPromise(engine.latestSequence)).toBe(8);
    expect(fullSnapshotReadCount).toBe(0);

    await runtime.dispose();
  });

  it("persists deterministic read models for repeated snapshot reads", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-1-create"),
        projectId: asProjectId("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-1-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("msg-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    const readModelA = await system.readModel();
    const readModelB = await system.readModel();
    expect(readModelB).toEqual(readModelA);
    await system.dispose();
  });

  it("upserts stable tool activities without growing projection rows or changing original order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const projectId = asProjectId("project-activity-upsert");
    const threadId = ThreadId.make("thread-activity-upsert");
    const activityId = EventId.make("tool-activity-stable");

    try {
      await system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-activity-upsert-create"),
          projectId,
          title: "Activity Upsert Project",
          workspaceRoot: "/tmp/project-activity-upsert",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      );
      await system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-activity-upsert-create"),
          threadId,
          projectId,
          title: "Activity Upsert Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );

      const first = await system.run(
        engine.dispatch({
          type: "thread.activity.upsert",
          commandId: CommandId.make("cmd-tool-activity-0"),
          threadId,
          activity: {
            id: activityId,
            tone: "tool",
            kind: "tool.started",
            summary: "Tool started",
            payload: { toolUseId: "tool-1", status: "inProgress", detail: "progress-0" },
            turnId: asTurnId("turn-activity-upsert"),
            createdAt,
          },
          createdAt,
        }),
      );

      let finalResult = first;
      for (let index = 1; index < 100; index += 1) {
        const occurredAt = DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe(createdAt), { seconds: index }),
        );
        finalResult = await system.run(
          engine.dispatch({
            type: "thread.activity.upsert",
            commandId: CommandId.make(`cmd-tool-activity-${index}`),
            threadId,
            activity: {
              id: activityId,
              tone: "tool",
              kind: index === 99 ? "tool.completed" : "tool.updated",
              summary: index === 99 ? "Tool completed" : "Tool updated",
              payload: {
                toolUseId: "tool-1",
                status: index === 99 ? "completed" : "inProgress",
                detail: `progress-${index}`,
              },
              turnId: asTurnId("turn-activity-upsert"),
              createdAt: occurredAt,
            },
            createdAt: occurredAt,
          }),
        );
      }

      const retriedFinal = await system.run(
        engine.dispatch({
          type: "thread.activity.upsert",
          commandId: CommandId.make("cmd-tool-activity-99"),
          threadId,
          activity: {
            id: activityId,
            tone: "tool",
            kind: "tool.completed",
            summary: "Tool completed",
            payload: {
              toolUseId: "tool-1",
              status: "completed",
              detail: "progress-99",
            },
            turnId: asTurnId("turn-activity-upsert"),
            createdAt: DateTime.formatIso(
              DateTime.add(DateTime.makeUnsafe(createdAt), { seconds: 99 }),
            ),
          },
          createdAt: DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(createdAt), { seconds: 99 }),
          ),
        }),
      );
      expect(retriedFinal.sequence).toBe(finalResult.sequence);

      await system.run(
        engine.dispatch({
          type: "thread.activity.upsert",
          commandId: CommandId.make("cmd-tool-activity-stale-after-terminal"),
          threadId,
          activity: {
            id: activityId,
            tone: "tool",
            kind: "tool.updated",
            summary: "Stale tool progress",
            payload: {
              toolUseId: "tool-1",
              status: "inProgress",
              detail: "stale-progress",
            },
            turnId: asTurnId("turn-activity-upsert"),
            createdAt: DateTime.formatIso(
              DateTime.add(DateTime.makeUnsafe(createdAt), { seconds: 100 }),
            ),
          },
          createdAt: DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(createdAt), { seconds: 100 }),
          ),
        }),
      );

      await system.run(
        engine.dispatch({
          type: "thread.activity.upsert",
          commandId: CommandId.make("cmd-tool-activity-distinct"),
          threadId,
          activity: {
            id: EventId.make("tool-activity-distinct"),
            tone: "tool",
            kind: "tool.completed",
            summary: "Second tool completed",
            payload: { toolUseId: "tool-2", status: "completed" },
            turnId: asTurnId("turn-activity-upsert"),
            createdAt: DateTime.formatIso(
              DateTime.add(DateTime.makeUnsafe(createdAt), { seconds: 101 }),
            ),
          },
          createdAt: DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(createdAt), { seconds: 101 }),
          ),
        }),
      );

      const thread = (await system.readModel()).threads.find((entry) => entry.id === threadId);
      expect(thread?.activities).toHaveLength(2);
      expect(thread?.activities[0]).toMatchObject({
        id: activityId,
        kind: "tool.completed",
        sequence: first.sequence,
        createdAt,
        payload: {
          toolUseId: "tool-1",
          status: "completed",
          detail: "progress-99",
        },
      });
      expect(JSON.stringify(thread?.activities[0]?.payload).length).toBeLessThan(200);
      expect(thread?.activities[1]?.id).toBe("tool-activity-distinct");
    } finally {
      await system.dispose();
    }
  });

  it("archives and unarchives threads through orchestration commands", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-archive-create"),
        projectId: asProjectId("project-archive"),
        title: "Project Archive",
        workspaceRoot: "/tmp/project-archive",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-archive-create"),
        threadId: ThreadId.make("thread-archive"),
        projectId: asProjectId("project-archive"),
        title: "Archive me",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-archive-title-regeneration"),
        threadId: ThreadId.make("thread-archive"),
        regenerateTitle: true,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-thread-archive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).not.toBeNull();
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.titleRegeneration,
    ).toBeNull();

    await system.run(
      engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("cmd-thread-unarchive"),
        threadId: ThreadId.make("thread-archive"),
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.archivedAt,
    ).toBeNull();
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")
        ?.titleRegeneration,
    ).toBeNull();
    await system.run(
      engine.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("cmd-thread-archive-stale-title-completion"),
        threadId: ThreadId.make("thread-archive"),
        requestId: CommandId.make("cmd-thread-archive-title-regeneration"),
        title: "Stale generated title",
      }),
    );
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === "thread-archive")?.title,
    ).toBe("Archive me");

    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-replay-create"),
        projectId: asProjectId("project-replay"),
        title: "Replay Project",
        workspaceRoot: "/tmp/project-replay",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-replay-create"),
        threadId: ThreadId.make("thread-replay"),
        projectId: asProjectId("project-replay"),
        title: "replay",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-thread-replay-delete"),
        threadId: ThreadId.make("thread-replay"),
      }),
    );

    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.deleted",
    ]);
    await system.dispose();
  });

  it("rolls back thread-delete and revert cleanup intents before filesystem execution", async () => {
    let failNextTransaction = false;
    const sqlLayer = makeFailingTransactionSqlLayer(() => {
      if (!failNextTransaction) return false;
      failNextTransaction = false;
      return true;
    });
    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-orchestration-cleanup-rollback-test-",
    });
    const orchestrationLayer = Layer.mergeAll(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
      ),
      OrchestrationProjectionSnapshotQueryLive,
    ).pipe(
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(sqlLayer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtime = ManagedRuntime.make(orchestrationLayer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const config = await runtime.runPromise(Effect.service(ServerConfig));
    const fileSystem = await runtime.runPromise(Effect.service(FileSystem.FileSystem));
    const path = await runtime.runPromise(Effect.service(Path.Path));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const createdAt = now();
    const projectId = asProjectId("project-cleanup-rollback");

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-cleanup-rollback-project"),
        projectId,
        title: "Cleanup rollback",
        workspaceRoot: "/tmp/cleanup-rollback",
        defaultModelSelection: null,
        createdAt,
      }),
    );

    const deleteThreadId = ThreadId.make("thread-rollback-delete");
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-cleanup-rollback-delete-thread"),
        threadId: deleteThreadId,
        projectId,
        title: "Delete rollback",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    const deleteAttachment: ChatAttachment = {
      type: "file",
      id: "thread-rollback-delete-00000000-0000-4000-8000-000000000001",
      name: "delete.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
    };
    const deleteAttachmentPath = path.join(
      config.attachmentsDir,
      attachmentRelativePath(deleteAttachment),
    );
    await runtime.runPromise(fileSystem.writeFileString(deleteAttachmentPath, "delete"));

    failNextTransaction = true;
    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("cmd-cleanup-rollback-delete"),
          threadId: deleteThreadId,
        }),
      ),
    ).rejects.toThrow("OrchestrationEngine.processEnvelope:transaction");
    expect(await runtime.runPromise(fileSystem.exists(deleteAttachmentPath))).toBe(true);

    const deleteThreadRows = await runtime.runPromise(
      sql<{ readonly deletedAt: string | null }>`
        SELECT deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${deleteThreadId}
      `,
    );
    expect(deleteThreadRows).toEqual([{ deletedAt: null }]);
    const queueAfterDeleteRollback = await runtime.runPromise(
      sql<{ readonly count: number }>`SELECT COUNT(*) AS "count" FROM attachment_cleanup_queue`,
    );
    expect(queueAfterDeleteRollback[0]?.count).toBe(0);

    const revertThreadId = ThreadId.make("thread-rollback-revert");
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-cleanup-rollback-revert-thread"),
        threadId: revertThreadId,
        projectId,
        title: "Revert rollback",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    const revertAttachment: ChatAttachment = {
      type: "file",
      id: "thread-rollback-revert-00000000-0000-4000-8000-000000000002",
      name: "revert.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
    };
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-cleanup-rollback-revert-turn"),
        threadId: revertThreadId,
        message: {
          messageId: MessageId.make("message-cleanup-rollback-revert"),
          role: "user",
          text: "revert",
          attachments: [revertAttachment],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-cleanup-rollback-revert-checkpoint"),
        threadId: revertThreadId,
        turnId: TurnId.make("turn-cleanup-rollback-revert"),
        completedAt: "2026-01-01T00:00:02.000Z",
        checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-rollback-revert/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    const revertAttachmentPath = path.join(
      config.attachmentsDir,
      attachmentRelativePath(revertAttachment),
    );
    await runtime.runPromise(fileSystem.writeFileString(revertAttachmentPath, "revert"));

    failNextTransaction = true;
    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.revert.complete",
          commandId: CommandId.make("cmd-cleanup-rollback-revert"),
          threadId: revertThreadId,
          turnCount: 0,
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
      ),
    ).rejects.toThrow("OrchestrationEngine.processEnvelope:transaction");
    expect(await runtime.runPromise(fileSystem.exists(revertAttachmentPath))).toBe(true);

    const revertMessageRows = await runtime.runPromise(
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages
        WHERE thread_id = ${revertThreadId}
      `,
    );
    expect(revertMessageRows[0]?.count).toBe(1);
    const queueAfterRevertRollback = await runtime.runPromise(
      sql<{ readonly count: number }>`SELECT COUNT(*) AS "count" FROM attachment_cleanup_queue`,
    );
    expect(queueAfterRevertRollback[0]?.count).toBe(0);

    await runtime.dispose();
  });

  effectIt.effect("drains committed cleanup intents during startup after a crash window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-attachment-cleanup-startup-test-",
        });
        const dbPath = path.join(baseDir, "userdata", "state.sqlite");
        const configLayer = ServerConfig.layerTest(process.cwd(), baseDir);
        const attachment: ChatAttachment = {
          type: "file",
          id: "thread-startup-cleanup-00000000-0000-4000-8000-000000000001",
          name: "startup.txt",
          mimeType: "text/plain",
          sizeBytes: 7,
        };
        const attachmentPath = path.join(
          baseDir,
          "userdata",
          "attachments",
          attachmentRelativePath(attachment),
        );

        const seedLayer = Layer.mergeAll(
          OrchestrationProjectionPipelineLive.pipe(Layer.provide(OrchestrationEventStoreLive)),
          OrchestrationEventStoreLive,
        ).pipe(
          Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
          Layer.provideMerge(configLayer),
          Layer.provideMerge(NodeServices.layer),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const projectionPipeline = yield* OrchestrationProjectionPipeline;
            const eventStore = yield* OrchestrationEventStore;
            const sql = yield* SqlClient.SqlClient;
            yield* fileSystem.writeFileString(attachmentPath, "startup");
            const savedEvent = yield* eventStore.append({
              type: "thread.deleted",
              eventId: EventId.make("evt-startup-cleanup"),
              aggregateKind: "thread",
              aggregateId: ThreadId.make("thread-startup-cleanup"),
              occurredAt: "2026-01-01T00:00:00.000Z",
              commandId: CommandId.make("cmd-startup-cleanup"),
              causationEventId: null,
              correlationId: CommandId.make("cmd-startup-cleanup"),
              metadata: {},
              payload: {
                threadId: ThreadId.make("thread-startup-cleanup"),
                deletedAt: "2026-01-01T00:00:00.000Z",
              },
            });
            yield* projectionPipeline.projectEvent(savedEvent);
            const queued = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS "count" FROM attachment_cleanup_queue
              `;
            expect(queued[0]?.count).toBe(1);
            expect(yield* fileSystem.exists(attachmentPath)).toBe(true);
          }).pipe(Effect.provide(seedLayer)),
        );

        const recoveryLayer = Layer.mergeAll(
          OrchestrationEngineLive.pipe(
            Layer.provide(OrchestrationProjectionSnapshotQueryLive),
            Layer.provide(OrchestrationProjectionPipelineLive),
          ),
          OrchestrationProjectionSnapshotQueryLive,
        ).pipe(
          Layer.provide(OrchestrationEventStoreLive),
          Layer.provide(OrchestrationCommandReceiptRepositoryLive),
          Layer.provide(RepositoryIdentityResolver.layer),
          Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
          Layer.provideMerge(configLayer),
          Layer.provideMerge(NodeServices.layer),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* OrchestrationEngineService;
            const sql = yield* SqlClient.SqlClient;
            expect(yield* fileSystem.exists(attachmentPath)).toBe(false);
            const queued = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS "count" FROM attachment_cleanup_queue
              `;
            expect(queued[0]?.count).toBe(0);
          }).pipe(Effect.provide(recoveryLayer)),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-stream-create"),
        projectId: asProjectId("project-stream"),
        title: "Stream Project",
        workspaceRoot: "/tmp/project-stream",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-stream-thread-create"),
          threadId: ThreadId.make("thread-stream"),
          projectId: asProjectId("project-stream"),
          title: "domain-stream",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-stream-thread-update"),
          threadId: ThreadId.make("thread-stream"),
          title: "domain-stream-updated",
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );

    expect(eventTypes).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("does not regress a generated branch to a stale temporary worktree branch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-branch-race-project-create"),
        projectId: asProjectId("project-branch-race"),
        title: "Branch Race Project",
        workspaceRoot: "/tmp/project-branch-race",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-branch-race-thread-create"),
        threadId: ThreadId.make("thread-branch-race"),
        projectId: asProjectId("project-branch-race"),
        title: "Branch Race Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "t3code/generated-branch-name",
        worktreePath: "/tmp/project-branch-race-worktree",
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-stale-temporary-branch-sync"),
        threadId: ThreadId.make("thread-branch-race"),
        branch: "t3code/1234abcd",
        expectedBranch: "t3code/1234abcd",
      }),
    );

    const snapshot = await system.readModel();
    expect(snapshot.threads[0]?.branch).toBe("t3code/generated-branch-name");
    await system.dispose();
  });

  it("allows authoritative worktree bootstrap to assign a temporary branch", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-worktree-bootstrap-project-create"),
        projectId: asProjectId("project-worktree-bootstrap"),
        title: "Worktree Bootstrap Project",
        workspaceRoot: "/tmp/project-worktree-bootstrap",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-worktree-bootstrap-thread-create"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        projectId: asProjectId("project-worktree-bootstrap"),
        title: "Worktree Bootstrap Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "main",
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-authoritative-worktree-bootstrap"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/project-worktree-bootstrap-worktree",
      }),
    );

    const snapshot = await system.readModel();
    expect(snapshot.threads[0]?.branch).toBe("t3code/1234abcd");
    expect(snapshot.threads[0]?.worktreePath).toBe("/tmp/project-worktree-bootstrap-worktree");
    await system.dispose();
  });

  it("records command ack duration using the first committed event type", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-ack-create"),
        projectId: asProjectId("project-ack"),
        title: "Ack Project",
        workspaceRoot: "/tmp/project-ack",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-ack-create"),
        threadId: ThreadId.make("thread-ack"),
        projectId: asProjectId("project-ack"),
        title: "Ack Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_command_ack_duration", {
        commandType: "thread.create",
        aggregateKind: "thread",
        ackEventType: "thread.created",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("records failed command dispatches as metric failures", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-missing-project"),
          threadId: ThreadId.make("thread-missing-project"),
          projectId: asProjectId("project-missing"),
          title: "Missing Project Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("does not exist");

    const snapshots = await system.run(Metric.snapshot);
    expect(
      hasMetricSnapshot(snapshots, "t3_orchestration_commands_total", {
        commandType: "thread.create",
        aggregateKind: "thread",
        outcome: "failure",
      }),
    ).toBe(true);

    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-turn-diff-create"),
        threadId: ThreadId.make("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-turn-diff-complete"),
        threadId: ThreadId.make("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.readModel()).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/t3/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  effectIt.effect("keeps processing queued commands after a storage failure", () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.make("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-orchestration-engine-test-",
    });

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const createdAt = now();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      const failure = yield* engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-flaky-1"),
          threadId: ThreadId.make("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        })
        .pipe(Effect.flip);
      expect(failure.message).toContain("append failed");

      const result = yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-flaky-2"),
        threadId: ThreadId.make("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      });

      expect(result.sequence).toBe(2);
      const eventsAfterRetry = yield* Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      );
      expect(eventsAfterRetry.map((event) => event.type)).toEqual([
        "project.created",
        "thread.created",
      ]);
    }).pipe(Effect.provide(layer));
  });

  effectIt.effect(
    "rolls back all events for a multi-event command when projection fails mid-dispatch",
    () => {
      let shouldFailRequestedProjection = true;
      const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
        bootstrap: Effect.void,
        projectEvent: (event) => {
          if (
            shouldFailRequestedProjection &&
            event.commandId === CommandId.make("cmd-turn-start-atomic") &&
            event.type === "thread.turn-start-requested"
          ) {
            shouldFailRequestedProjection = false;
            return Effect.fail(
              new PersistenceSqlError({
                operation: "test.projection",
                detail: "projection failed",
              }),
            );
          }
          return Effect.void;
        },
      };
      const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-orchestration-engine-projection-failure-test-",
      });

      const layer = OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const createdAt = now();

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-atomic-create"),
          projectId: asProjectId("project-atomic"),
          title: "Atomic Project",
          workspaceRoot: "/tmp/project-atomic",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-atomic-create"),
          threadId: ThreadId.make("thread-atomic"),
          projectId: asProjectId("project-atomic"),
          title: "atomic",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });

        const turnStartCommand = {
          type: "thread.turn.start" as const,
          commandId: CommandId.make("cmd-turn-start-atomic"),
          threadId: ThreadId.make("thread-atomic"),
          message: {
            messageId: asMessageId("msg-atomic-1"),
            role: "user" as const,
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required" as const,
          createdAt,
        };

        const failure = yield* engine.dispatch(turnStartCommand).pipe(Effect.flip);
        expect(failure.message).toContain("projection failed");

        const eventsAfterFailure = yield* Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
        );
        expect(eventsAfterFailure.map((event) => event.type)).toEqual([
          "project.created",
          "thread.created",
        ]);

        const retryResult = yield* engine.dispatch(turnStartCommand);
        expect(retryResult.sequence).toBe(4);

        const eventsAfterRetry = yield* Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
        );
        expect(eventsAfterRetry.map((event) => event.type)).toEqual([
          "project.created",
          "thread.created",
          "thread.message-sent",
          "thread.turn-start-requested",
        ]);
        expect(
          eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
        ).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    },
  );

  effectIt.effect("reconciles command state when append persists but projection fails", () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectEvent: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.make("cmd-thread-archive-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };
    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-orchestration-engine-reconcile-failure-test-",
    });

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
      Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const createdAt = now();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-sync-create"),
        threadId: ThreadId.make("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      });

      const projectionFailure = yield* engine
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-fail"),
          threadId: ThreadId.make("thread-sync"),
        })
        .pipe(Effect.flip);
      expect(projectionFailure.message).toContain("projection failed");

      const invariantFailure = yield* engine
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-sync-retry"),
          threadId: ThreadId.make("thread-sync"),
        })
        .pipe(Effect.flip);
      expect(invariantFailure.message).toContain("already archived");
    }).pipe(Effect.provide(layer));
  });

  it("fails command dispatch when command invariants are violated", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-invariant-missing-thread"),
          threadId: ThreadId.make("thread-missing"),
          message: {
            messageId: asMessageId("msg-missing"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now(),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-missing' does not exist");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-duplicate-1"),
        threadId: ThreadId.make("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-duplicate-2"),
          threadId: ThreadId.make("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });
});
