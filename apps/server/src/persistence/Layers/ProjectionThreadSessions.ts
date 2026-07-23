import { OrchestrationSessionRecovery } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionThreadSession,
  ProjectionThreadSessionRepository,
  type ProjectionThreadSessionRepositoryShape,
  DeleteProjectionThreadSessionInput,
  GetProjectionThreadSessionInput,
} from "../Services/ProjectionThreadSessions.ts";

const ProjectionThreadSessionDbRow = ProjectionThreadSession.mapFields(
  Struct.assign({
    recovery: Schema.NullOr(Schema.fromJsonString(OrchestrationSessionRecovery)),
  }),
);

const ProjectionThreadSessionRawDbRow = Schema.Struct({
  threadId: Schema.String,
  status: Schema.Unknown,
  providerName: Schema.Unknown,
  providerInstanceId: Schema.Unknown,
  runtimeMode: Schema.Unknown,
  activeTurnId: Schema.Unknown,
  lastError: Schema.Unknown,
  recovery: Schema.Unknown,
  updatedAt: Schema.Unknown,
});

const decodeProjectionThreadSessionRow = Schema.decodeUnknownEffect(ProjectionThreadSessionDbRow);

const makeProjectionThreadSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadSessionRow = SqlSchema.void({
    Request: ProjectionThreadSessionDbRow,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          runtime_mode,
          active_turn_id,
          last_error,
          recovery_json,
          updated_at
        )
        VALUES (
          ${row.threadId},
          ${row.status},
          ${row.providerName},
          ${row.providerInstanceId},
          ${row.runtimeMode},
          ${row.activeTurnId},
          ${row.lastError},
          ${row.recovery},
          ${row.updatedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          status = excluded.status,
          provider_name = excluded.provider_name,
          provider_instance_id = excluded.provider_instance_id,
          runtime_mode = excluded.runtime_mode,
          active_turn_id = excluded.active_turn_id,
          last_error = excluded.last_error,
          recovery_json = excluded.recovery_json,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionThreadSessionRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadSessionInput,
    Result: ProjectionThreadSessionDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          recovery_json AS recovery,
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const listActiveProjectionThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionRawDbRow,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          recovery_json AS recovery,
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE status IN ('starting', 'running')
           OR active_turn_id IS NOT NULL
        ORDER BY updated_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadSessionRow = SqlSchema.void({
    Request: DeleteProjectionThreadSessionInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadSessionRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadSessionRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadSessionRepository.upsert:query")),
    );

  const getByThreadId: ProjectionThreadSessionRepositoryShape["getByThreadId"] = (input) =>
    getProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.getByThreadId:query"),
      ),
    );

  const listActive: ProjectionThreadSessionRepositoryShape["listActive"] = () =>
    listActiveProjectionThreadSessionRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadSessionRepository.listActive:query")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeProjectionThreadSessionRow(row).pipe(
            Effect.map(Option.some),
            Effect.catch((cause) =>
              Effect.logWarning("projection.thread-session.row-skipped", {
                threadId: row.threadId,
                error: toPersistenceDecodeError(
                  "ProjectionThreadSessionRepository.listActive:decodeRows",
                )(cause).message,
              }).pipe(Effect.as(Option.none<ProjectionThreadSession>())),
            ),
          ),
        ),
      ),
      Effect.map((rows) => rows.flatMap((row) => (Option.isSome(row) ? [row.value] : []))),
    );

  const deleteByThreadId: ProjectionThreadSessionRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByThreadId,
    listActive,
    deleteByThreadId,
  } satisfies ProjectionThreadSessionRepositoryShape;
});

export const ProjectionThreadSessionRepositoryLive = Layer.effect(
  ProjectionThreadSessionRepository,
  makeProjectionThreadSessionRepository,
);
