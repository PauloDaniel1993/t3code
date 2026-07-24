// @effect-diagnostics nodeBuiltinImport:off - This opt-in regression exercises real 1 GB-class SQLite files.
// oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Physical replacement must run after the managed SQL runtime closes.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CorrelationId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { createEmptyReadModel, projectEvent } from "../orchestration/projector.ts";
import { stableLegacyToolActivityId } from "../orchestration/LegacyToolActivityIdentity.ts";
import {
  createDatabaseCompactCandidate,
  installValidatedDatabaseCandidate,
  markDatabaseReplacementReady,
  validateDatabaseCompactCandidate,
} from "./DatabasePhysicalMaintenance.ts";
import { DatabaseLogicalCompactionLive } from "./Layers/DatabaseLogicalCompaction.ts";
import { DatabaseLogicalCompactorLive } from "./Layers/DatabaseLogicalCompactor.ts";
import { DatabaseCompactionEstimatorLive } from "./Layers/DatabaseCompactionEstimator.ts";
import { DatabaseCompactionJournalRepositoryLive } from "./Layers/DatabaseCompactionJournal.ts";
import { OrchestrationEventStoreLive } from "./Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import { DatabaseLogicalCompaction } from "./Services/DatabaseLogicalCompaction.ts";
import { OrchestrationEventStore } from "./Services/OrchestrationEventStore.ts";

const decodeUnknownJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

describe.runIf(process.env.T3_RUN_INCIDENT_COMPACTION === "1")(
  "incident-shaped database compaction",
  () => {
    it("preserves replay equivalence and physically reclaims a 1 GB-class database", async () => {
      const directory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-incident-compaction-"),
      );
      const resolvedDirectory = NodePath.resolve(directory);
      const resolvedTempRoot = NodePath.resolve(NodeOS.tmpdir());
      if (!resolvedDirectory.startsWith(`${resolvedTempRoot}${NodePath.sep}`)) {
        throw new Error("Incident compaction directory escaped the operating-system temp root.");
      }
      const databasePath = NodePath.join(resolvedDirectory, "state.sqlite");
      const threadId = ThreadId.make("thread-incident-compaction");
      const turnId = TurnId.make("turn-incident-compaction");
      const occurredAt = "2026-07-23T12:00:00.000Z";
      const toolId = "kimi-tool-incident";
      const activityEventCount = 1_024;

      try {
        const persistence = makeSqlitePersistenceLive(databasePath).pipe(
          Layer.provide(NodeServices.layer),
        );
        const dependencies = Layer.mergeAll(
          DatabaseCompactionJournalRepositoryLive,
          DatabaseCompactionEstimatorLive,
          DatabaseLogicalCompactorLive,
          OrchestrationEventStoreLive,
        ).pipe(Layer.provideMerge(persistence));
        const runtime = ManagedRuntime.make(
          Layer.mergeAll(
            DatabaseLogicalCompactionLive.pipe(Layer.provideMerge(dependencies)),
            dependencies,
          ),
        );

        let replayActivityId: string | undefined;
        let logicalBytesReclaimed = 0;
        try {
          const logicalResult = await runtime.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const eventStore = yield* OrchestrationEventStore;
              const maintenance = yield* DatabaseLogicalCompaction;

              yield* eventStore.append({
                type: "thread.created",
                eventId: EventId.make("event-incident-thread-created"),
                aggregateKind: "thread",
                aggregateId: threadId,
                occurredAt,
                commandId: CommandId.make("command-incident-thread-created"),
                causationEventId: null,
                correlationId: CorrelationId.make("command-incident-thread-created"),
                metadata: {},
                payload: {
                  threadId,
                  projectId: ProjectId.make("project-incident-compaction"),
                  title: "Incident compaction",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("kimi"),
                    model: "kimi-for-coding",
                  },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  createdAt: occurredAt,
                  updatedAt: occurredAt,
                },
              });

              yield* sql`
                  WITH RECURSIVE activity_values(value) AS (
                    SELECT 0
                    UNION ALL
                    SELECT value + 1
                    FROM activity_values
                    WHERE value < ${activityEventCount - 1}
                  )
                  INSERT INTO orchestration_events (
                    event_id,
                    aggregate_kind,
                    stream_id,
                    stream_version,
                    event_type,
                    occurred_at,
                    command_id,
                    causation_event_id,
                    correlation_id,
                    actor_kind,
                    payload_json,
                    metadata_json
                  )
                  SELECT
                    printf('event-incident-activity-%04d', value),
                    'thread',
                    ${threadId},
                    value + 1,
                    'thread.activity-appended',
                    ${occurredAt},
                    printf('command-incident-activity-%04d', value),
                    CASE
                      WHEN value = 0 THEN 'event-incident-thread-created'
                      ELSE printf('event-incident-activity-%04d', value - 1)
                    END,
                    'command-incident-thread-created',
                    'provider',
                    json_object(
                      'threadId', ${threadId},
                      'activity', json_object(
                        'id', printf('activity-incident-%04d', value),
                        'tone', 'tool',
                        'kind', 'tool.updated',
                        'summary', 'Kimi cumulative tool update',
                        'payload', json_object(
                          'toolUseId', ${toolId},
                          'status', CASE
                            WHEN value = ${activityEventCount - 1} THEN 'completed'
                            ELSE 'in_progress'
                          END,
                          'detail', printf('progress-%04d', value),
                          'data', printf('%032768d', value)
                        ),
                        'turnId', ${turnId},
                        'createdAt', ${occurredAt}
                      )
                    ),
                    '{"adapterKey":"kimi"}'
                  FROM activity_values
                `;

              yield* sql`
                  WITH RECURSIVE projection_values(value) AS (
                    SELECT ${activityEventCount - 128}
                    UNION ALL
                    SELECT value + 1
                    FROM projection_values
                    WHERE value < ${activityEventCount - 1}
                  )
                  INSERT INTO projection_thread_activities (
                    activity_id,
                    thread_id,
                    turn_id,
                    tone,
                    kind,
                    summary,
                    payload_json,
                    sequence,
                    created_at
                  )
                  SELECT
                    printf('activity-incident-%04d', value),
                    ${threadId},
                    ${turnId},
                    'tool',
                    'tool.updated',
                    'Kimi cumulative tool update',
                    json_object(
                      'toolUseId', ${toolId},
                      'status', CASE
                        WHEN value = ${activityEventCount - 1} THEN 'completed'
                        ELSE 'in_progress'
                      END,
                      'detail', printf('progress-%04d', value),
                      'data', printf('%032768d', value)
                    ),
                    value + 2,
                    ${occurredAt}
                  FROM projection_values
                `;
              yield* sql`
                  INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
                  VALUES ('thread-activities', ${activityEventCount + 1}, ${occurredAt})
                `;

              yield* sql`
                  CREATE TABLE incident_deleted_bloat (
                    chunk_id INTEGER PRIMARY KEY,
                    content BLOB NOT NULL
                  )
                `;
              yield* sql`
                  WITH RECURSIVE chunks(value) AS (
                    SELECT 0
                    UNION ALL
                    SELECT value + 1
                    FROM chunks
                    WHERE value < 1023
                  )
                  INSERT INTO incident_deleted_bloat (chunk_id, content)
                  SELECT value, zeroblob(1048576)
                  FROM chunks
                `;
              yield* sql`DELETE FROM incident_deleted_bloat`;

              const journal = yield* maintenance.run();
              expect(journal.phase).toBe("awaiting-restart");
              expect(journal.processedEventCount).toBe(activityEventCount);
              expect(journal.logicalBytesReclaimed).toBeGreaterThan(30 * 1024 * 1024);

              const replayEvents = Array.from(yield* Stream.runCollect(eventStore.readAll()));
              let replay = createEmptyReadModel(occurredAt);
              for (const event of replayEvents) {
                replay = yield* projectEvent(replay, event);
              }
              const replayToolActivities =
                replay.threads[0]?.activities.filter(
                  (activity) => activity.kind === "tool.updated",
                ) ?? [];
              const projectedRows = yield* sql<{
                readonly activityId: string;
                readonly payloadJson: string;
              }>`
                  SELECT
                    activity_id AS "activityId",
                    payload_json AS "payloadJson"
                  FROM projection_thread_activities
                  WHERE thread_id = ${threadId}
                    AND kind = 'tool.updated'
                `;
              const expectedStableId = stableLegacyToolActivityId(threadId, turnId, toolId);
              expect(replayToolActivities).toHaveLength(1);
              expect(projectedRows).toHaveLength(1);
              expect(replayToolActivities[0]?.id).toBe(expectedStableId);
              expect(projectedRows[0]?.activityId).toBe(expectedStableId);
              expect(projectedRows[0]).toBeDefined();
              const projectedPayload = decodeUnknownJson(projectedRows[0]!.payloadJson) as {
                readonly status?: unknown;
              };
              expect(projectedPayload.status).toBe("completed");
              expect(replayToolActivities[0]?.payload).toEqual(projectedPayload);

              yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
              return {
                logicalBytesReclaimed: journal.logicalBytesReclaimed,
                replayActivityId: replayToolActivities[0]?.id,
              };
            }),
          );
          logicalBytesReclaimed = logicalResult.logicalBytesReclaimed;
          replayActivityId = logicalResult.replayActivityId;
        } finally {
          await runtime.dispose();
        }

        const beforeBytes = NodeFS.statSync(databasePath).size;
        expect(beforeBytes).toBeGreaterThanOrEqual(1_000_000_000);

        const candidate = createDatabaseCompactCandidate({ databasePath });
        const validation = validateDatabaseCompactCandidate({
          databasePath,
          candidatePath: candidate.paths.candidatePath,
        });
        expect(validation.source).toEqual(validation.candidate);
        const replacement = installValidatedDatabaseCandidate({ databasePath });
        expect(replacement.beforeBytes).toBe(beforeBytes);
        expect(replacement.afterBytes).toBeLessThan(beforeBytes / 10);

        const active = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
        const retained = active
          .prepare(
            `
                SELECT activity_id AS "activityId"
                FROM projection_thread_activities
                WHERE thread_id = ? AND kind = 'tool.updated'
              `,
          )
          .all(threadId) as unknown as ReadonlyArray<{ readonly activityId: string }>;
        active.close();
        expect(retained).toEqual([{ activityId: replayActivityId }]);

        markDatabaseReplacementReady(databasePath);
        process.stdout.write(
          `[incident-compaction] before=${replacement.beforeBytes} after=${replacement.afterBytes} logical=${logicalBytesReclaimed}\n`,
        );
      } finally {
        NodeFS.rmSync(resolvedDirectory, { recursive: true, force: true });
      }
    }, 600_000);
  },
);
