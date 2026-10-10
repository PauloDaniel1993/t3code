import {
  type ApplicationProjectEvent,
  IsoDateTime,
  ModelSelection,
  type OrchestrationProjectShell,
  ProjectIconOverride,
  ProjectId,
  ProjectScript,
  ThreadEnvMode,
  WorkspaceFolderEntry,
} from "@t3tools/contracts";
import { allocateFolderLabels, isSamePath } from "@t3tools/shared/workspaceFolders";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export class ProjectStoreV2Error extends Schema.TaggedError<ProjectStoreV2Error>()(
  "ProjectStoreV2Error",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project store operation '${this.operation}' failed.`;
  }
}

/** One row of `projection_projects`, the durable project read model. */
export const ProjectRow = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  /** The linked workspace file; null for a plain project. */
  workspaceFile: Schema.NullOr(Schema.String),
  /** The linked file's folders as last read; null for a plain project. */
  folders: Schema.NullOr(Schema.Array(WorkspaceFolderEntry)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.NullOr(ThreadEnvMode),
  autoPull: Schema.Boolean,
  faviconPath: Schema.NullOr(Schema.String),
  projectIcon: Schema.NullOr(ProjectIconOverride),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectRow = typeof ProjectRow.Type;

const ProjectDbRow = Schema.Struct({
  ...ProjectRow.fields,
  folders: Schema.NullOr(Schema.fromJsonString(Schema.Array(WorkspaceFolderEntry))),
  defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  autoPull: Schema.BooleanFromBit,
  projectIcon: Schema.NullOr(Schema.fromJsonString(ProjectIconOverride)),
  scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
});

/**
 * A linked project's workspace file and labelled folders, without probed
 * facts. Plain projects carry neither on the wire.
 */
export function workspaceFileFields(
  row: ProjectRow,
): Pick<OrchestrationProjectShell, "workspaceFile" | "folders"> {
  if (row.workspaceFile === null) return {};
  return { workspaceFile: row.workspaceFile, folders: allocateFolderLabels(row.folders ?? []) };
}

/** Shell fields without workspace-derived enrichment such as repository identity. */
function toShell(row: ProjectRow): OrchestrationProjectShell {
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    ...workspaceFileFields(row),
    repositoryIdentity: null,
    defaultModelSelection: row.defaultModelSelection,
    defaultThreadEnvMode: row.defaultThreadEnvMode,
    autoPull: row.autoPull,
    faviconPath: row.faviconPath,
    projectIcon: row.projectIcon,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ProjectStoreV2 extends Context.Service<
  ProjectStoreV2,
  {
    /** Fold one committed project event into its row. Call inside the commit transaction. */
    readonly apply: (event: ApplicationProjectEvent) => Effect.Effect<void, ProjectStoreV2Error>;
    readonly get: (
      projectId: ProjectId,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<ProjectRow>, ProjectStoreV2Error>;
    readonly list: (options?: {
      readonly projectIds?: ReadonlyArray<ProjectId>;
      readonly includeDeleted?: boolean;
    }) => Effect.Effect<ReadonlyArray<ProjectRow>, ProjectStoreV2Error>;
    /**
     * The active plain project at a workspace root: linked projects never own
     * one. With `includeLinked`, a project linked to a workspace file whose
     * primary folder is the root answers when no plain project does. Roots
     * match by exact string; callers normalize before asking.
     */
    readonly findActiveByWorkspaceRoot: (
      workspaceRoot: string,
      options?: { readonly includeLinked?: boolean },
    ) => Effect.Effect<Option.Option<ProjectRow>, ProjectStoreV2Error>;
    /**
     * The active project linked to a workspace file. Windows paths match
     * case-insensitively, since they name one file in any case.
     */
    readonly findActiveByWorkspaceFile: (
      workspaceFile: string,
    ) => Effect.Effect<Option.Option<ProjectRow>, ProjectStoreV2Error>;
    /** An active project's shell without enrichment such as repository identity. */
    readonly getShell: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectStoreV2Error>;
    /** Active project shells in creation order, without enrichment. */
    readonly listShells: (options?: {
      readonly projectIds?: ReadonlyArray<ProjectId>;
    }) => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, ProjectStoreV2Error>;
  }
>()("t3/orchestration-v2/ProjectStore/ProjectStoreV2") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encodeRow = Schema.encodeEffect(ProjectDbRow);

  const selectRows = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: Schema.optional(ProjectId),
      projectIds: Schema.optional(Schema.Array(ProjectId)),
      workspaceRoot: Schema.optional(Schema.String),
      linkedOnly: Schema.optional(Schema.Boolean),
      includeDeleted: Schema.Boolean,
    }),
    Result: ProjectDbRow,
    execute: (request) => sql`
      SELECT
        project_id AS "projectId",
        title,
        workspace_root AS "workspaceRoot",
        workspace_file AS "workspaceFile",
        workspace_folders_json AS "folders",
        default_model_selection_json AS "defaultModelSelection",
        default_thread_env_mode AS "defaultThreadEnvMode",
        auto_pull AS "autoPull",
        favicon_path AS "faviconPath",
        project_icon_json AS "projectIcon",
        scripts_json AS "scripts",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_projects
      WHERE ${sql.and([
        ...(request.includeDeleted ? [] : [sql`deleted_at IS NULL`]),
        ...(request.projectId === undefined ? [] : [sql`project_id = ${request.projectId}`]),
        ...(request.projectIds === undefined ? [] : [sql.in("project_id", request.projectIds)]),
        ...(request.workspaceRoot === undefined
          ? []
          : [sql`workspace_root = ${request.workspaceRoot}`]),
        ...(request.linkedOnly === true ? [sql`workspace_file IS NOT NULL`] : []),
      ])}
      ORDER BY created_at ASC, project_id ASC
    `,
  });

  const upsertRow = (row: ProjectRow) =>
    encodeRow(row).pipe(
      Effect.flatMap(
        (encoded) => sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            workspace_file,
            workspace_folders_json,
            default_model_selection_json,
            default_thread_env_mode,
            auto_pull,
            favicon_path,
            project_icon_json,
            scripts_json,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            ${encoded.projectId},
            ${encoded.title},
            ${encoded.workspaceRoot},
            ${encoded.workspaceFile},
            ${encoded.folders},
            ${encoded.defaultModelSelection},
            ${encoded.defaultThreadEnvMode},
            ${encoded.autoPull},
            ${encoded.faviconPath},
            ${encoded.projectIcon},
            ${encoded.scripts},
            ${encoded.createdAt},
            ${encoded.updatedAt},
            ${encoded.deletedAt}
          )
          ON CONFLICT (project_id)
          DO UPDATE SET
            title = excluded.title,
            workspace_root = excluded.workspace_root,
            workspace_file = excluded.workspace_file,
            workspace_folders_json = excluded.workspace_folders_json,
            default_model_selection_json = excluded.default_model_selection_json,
            default_thread_env_mode = excluded.default_thread_env_mode,
            auto_pull = excluded.auto_pull,
            favicon_path = excluded.favicon_path,
            project_icon_json = excluded.project_icon_json,
            scripts_json = excluded.scripts_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at
        `,
      ),
    );

  const mapError =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new ProjectStoreV2Error({ operation, cause })));

  const get: ProjectStoreV2["Service"]["get"] = (projectId, options) =>
    selectRows({ projectId, includeDeleted: options?.includeDeleted === true }).pipe(
      Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
      mapError("get"),
    );

  const list: ProjectStoreV2["Service"]["list"] = (options) =>
    selectRows({
      ...(options?.projectIds === undefined ? {} : { projectIds: options.projectIds }),
      includeDeleted: options?.includeDeleted === true,
    }).pipe(mapError("list"));

  const findActiveByWorkspaceRoot: ProjectStoreV2["Service"]["findActiveByWorkspaceRoot"] = (
    workspaceRoot,
    options,
  ) =>
    selectRows({ workspaceRoot, includeDeleted: false }).pipe(
      Effect.map((rows) =>
        Option.fromUndefinedOr(
          rows.find((row) => row.workspaceFile === null) ??
            (options?.includeLinked === true ? rows[0] : undefined),
        ),
      ),
      mapError("findActiveByWorkspaceRoot"),
    );

  const findActiveByWorkspaceFile: ProjectStoreV2["Service"]["findActiveByWorkspaceFile"] = (
    workspaceFile,
  ) =>
    selectRows({ linkedOnly: true, includeDeleted: false }).pipe(
      Effect.map((rows) =>
        Option.fromUndefinedOr(
          rows.find(
            (row) => row.workspaceFile !== null && isSamePath(row.workspaceFile, workspaceFile),
          ),
        ),
      ),
      mapError("findActiveByWorkspaceFile"),
    );

  const apply: ProjectStoreV2["Service"]["apply"] = Effect.fn("ProjectStoreV2.apply")(
    function* (event) {
      if (event.type === "project.created") {
        const payload = event.payload;
        return yield* upsertRow({
          projectId: payload.projectId,
          title: payload.title,
          workspaceRoot: payload.workspaceRoot,
          workspaceFile: payload.workspaceFile ?? null,
          folders: payload.folders ?? null,
          defaultModelSelection: payload.defaultModelSelection,
          defaultThreadEnvMode: payload.defaultThreadEnvMode ?? null,
          autoPull: false,
          faviconPath: payload.faviconPath ?? null,
          projectIcon: payload.projectIcon ?? null,
          scripts: payload.scripts,
          createdAt: payload.createdAt,
          updatedAt: payload.updatedAt,
          deletedAt: null,
        }).pipe(mapError("apply"));
      }
      const existing = yield* get(event.payload.projectId, { includeDeleted: true });
      if (Option.isNone(existing)) return;
      const row = existing.value;
      if (event.type === "project.deleted") {
        return yield* upsertRow({
          ...row,
          deletedAt: event.payload.deletedAt,
          updatedAt: event.payload.deletedAt,
        }).pipe(mapError("apply"));
      }
      const payload = event.payload;
      yield* upsertRow({
        ...row,
        ...(payload.title === undefined ? {} : { title: payload.title }),
        ...(payload.workspaceRoot === undefined ? {} : { workspaceRoot: payload.workspaceRoot }),
        ...(payload.workspaceFile === undefined ? {} : { workspaceFile: payload.workspaceFile }),
        ...(payload.folders === undefined ? {} : { folders: payload.folders }),
        ...(payload.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: payload.defaultModelSelection }),
        ...(payload.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: payload.defaultThreadEnvMode }),
        ...(payload.autoPull === undefined ? {} : { autoPull: payload.autoPull }),
        ...(payload.faviconPath === undefined ? {} : { faviconPath: payload.faviconPath }),
        ...(payload.projectIcon === undefined ? {} : { projectIcon: payload.projectIcon }),
        ...(payload.scripts === undefined ? {} : { scripts: payload.scripts }),
        updatedAt: payload.updatedAt,
      }).pipe(mapError("apply"));
    },
  );

  return ProjectStoreV2.of({
    apply,
    get,
    list,
    findActiveByWorkspaceRoot,
    findActiveByWorkspaceFile,
    getShell: (projectId) => get(projectId).pipe(Effect.map(Option.map(toShell))),
    listShells: (options) =>
      list(options?.projectIds === undefined ? undefined : { projectIds: options.projectIds }).pipe(
        Effect.map((rows) => rows.map(toShell)),
      ),
  });
});

export const layer = Layer.effect(ProjectStoreV2, make);
