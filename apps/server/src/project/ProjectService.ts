import {
  CommandId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadWorkspaceFolder,
  type OrchestrationV2ThreadWorktree,
  ProjectId,
  type Project,
  type ProjectCreatePayload,
  type ProjectImportWorkspaceFilePayload,
  type ProjectUpdatePayload,
  type ProjectSnapshot,
  type ThreadId,
  type WorkspaceFolderEntry,
  WorkspaceFileProjectsDisabledError,
  WorkspaceFileUnavailableError,
  WorkspacePrimaryFolderUnavailableError,
} from "@t3tools/contracts";
import { allocateFolderLabels, isSamePath } from "@t3tools/shared/workspaceFolders";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  decodeProjectCommandRejection,
  encodeProjectCommandRejection,
  planProjectCommand,
  type ProjectCommand,
  type ProjectCommandIdentities,
  projectCommandIdentities,
} from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { planThreadDeletion } from "../orchestration-v2/ThreadDeletion.ts";
import { planThreadWorkspaceUpdate } from "../orchestration-v2/ThreadWorkspaceBinding.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as WorkspaceFiles from "./WorkspaceFiles.ts";
import type * as WorkspaceFolderResolver from "./WorkspaceFolderResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export interface ProjectCreateInput extends ProjectCreatePayload {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectUpdateInput extends ProjectUpdatePayload {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectBootstrapInput extends ProjectCreateInput {}

export interface ProjectImportWorkspaceFileInput extends ProjectImportWorkspaceFilePayload {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectLinkWorkspaceFileInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly workspaceFilePath: string;
}

export interface ProjectUnlinkWorkspaceFileInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectDeleteInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly force?: boolean;
}

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found.`;
  }
}

export class ProjectConflictError extends Schema.TaggedError<ProjectConflictError>()(
  "ProjectConflictError",
  {
    projectId: ProjectId,
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Workspace ${this.workspaceRoot} already belongs to project ${this.conflictingProjectId}.`;
  }
}

export class ProjectFileConflictError extends Schema.TaggedError<ProjectFileConflictError>()(
  "ProjectFileConflictError",
  {
    projectId: ProjectId,
    workspaceFile: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Workspace file ${this.workspaceFile} is already linked to project ${this.conflictingProjectId}.`;
  }
}

/** A request the service can't carry out as asked, such as a workspace-file change mixed with other edits. */
export class ProjectInvalidRequestError extends Schema.TaggedError<ProjectInvalidRequestError>()(
  "ProjectInvalidRequestError",
  {
    projectId: ProjectId,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ProjectNotEmptyError extends Schema.TaggedError<ProjectNotEmptyError>()(
  "ProjectNotEmptyError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} is not empty.`;
  }
}

export class ProjectOperationError extends Schema.TaggedError<ProjectOperationError>()(
  "ProjectOperationError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "read-project",
      "list-projects",
      "list-threads",
      "delete-thread",
      "bind-threads",
      "dispatch-project-command",
    ]),
    projectId: Schema.optional(ProjectId),
    workspaceRoot: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project operation '${this.operation}' failed${this.projectId === undefined ? "" : ` for ${this.projectId}`}.`;
  }
}

export type ProjectServiceError =
  | ProjectNotFoundError
  | ProjectConflictError
  | ProjectFileConflictError
  | ProjectInvalidRequestError
  | ProjectNotEmptyError
  | ProjectOperationError
  | WorkspaceFileUnavailableError
  | WorkspaceFileProjectsDisabledError;

export class ProjectService extends Context.Service<
  ProjectService,
  {
    readonly create: (input: ProjectCreateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly bootstrap: (
      input: ProjectBootstrapInput,
    ) => Effect.Effect<
      { readonly project: Project; readonly created: boolean },
      ProjectServiceError
    >;
    /** A `workspaceFilePath` links or unlinks, and must come without other edits. */
    readonly update: (input: ProjectUpdateInput) => Effect.Effect<Project, ProjectServiceError>;
    /**
     * Create a project linked to a VS Code workspace file, at its first folder.
     * The file and that folder must be usable; nothing is created on disk.
     */
    readonly importWorkspaceFile: (
      input: ProjectImportWorkspaceFileInput,
    ) => Effect.Effect<Project, ProjectServiceError>;
    /**
     * Link a plain project to a workspace file whose first folder is the
     * project's own, relink a linked project to another file, or re-read its
     * file. Threads bound before keep their folders.
     */
    readonly linkWorkspaceFile: (
      input: ProjectLinkWorkspaceFileInput,
    ) => Effect.Effect<Project, ProjectServiceError>;
    /**
     * Return a linked project to one folder at its primary, even when the file
     * is gone. Threads keep their folders; worktrees and history stay.
     */
    readonly unlinkWorkspaceFile: (
      input: ProjectUnlinkWorkspaceFileInput,
    ) => Effect.Effect<Project, ProjectServiceError>;
    /**
     * The folder snapshot a new thread of a linked project binds, probed now;
     * undefined for a plain project, whose threads bind none.
     */
    readonly snapshotWorkspaceFolders: (
      projectId: ProjectId,
    ) => Effect.Effect<
      ReadonlyArray<OrchestrationV2ThreadWorkspaceFolder> | undefined,
      ProjectNotFoundError | ProjectOperationError | WorkspacePrimaryFolderUnavailableError
    >;
    readonly delete: (input: ProjectDeleteInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly getById: (
      projectId: ProjectId,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly getByWorkspaceRoot: (
      workspaceRoot: string,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly snapshot: Effect.Effect<ProjectSnapshot, ProjectOperationError>;
    /**
     * An active project's shell with its immediately available repository
     * identity; missing identity resolves in the background.
     */
    readonly getShell: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectOperationError>;
    /** Active project shells, enriched like `getShell`, in creation order. */
    readonly listShells: (options?: {
      readonly projectIds?: ReadonlyArray<ProjectId>;
    }) => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, ProjectOperationError>;
  }
>()("t3/project/ProjectService") {}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const threadProjections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const workspaceFiles = yield* WorkspaceFiles.WorkspaceFiles;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  // Commands for one project run in order. A command also holds every root and
  // workspace file it claims or releases, roots before files, so two projects
  // can never both own one.
  const projectLocks = yield* makeKeyedSerialExecutor<ProjectId>();
  const workspaceLocks = yield* makeKeyedSerialExecutor<string>();
  const workspaceFileLocks = yield* makeKeyedSerialExecutor<string>();

  const toProject = (
    row: ProjectStore.ProjectRow,
    enrichment: ProjectEnrichmentService.ProjectEnrichment | null,
    workspaceFileFields: ReturnType<typeof ProjectStore.workspaceFileFields>,
  ): Project => ({
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    ...workspaceFileFields,
    repositoryIdentity: enrichment?.repositoryIdentity ?? null,
    faviconPath: row.faviconPath ?? enrichment?.faviconPath ?? null,
    defaultModelSelection: row.defaultModelSelection,
    defaultThreadEnvMode: row.defaultThreadEnvMode,
    autoPull: row.autoPull,
    projectIcon: row.projectIcon,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });

  const hydrate = Effect.fn("ProjectService.hydrate")(function* (row: ProjectStore.ProjectRow) {
    const enrichment =
      row.deletedAt === null
        ? yield* projectEnrichment.getAvailable(row.workspaceRoot)
        : yield* projectEnrichment.peek(row.workspaceRoot);
    const { folders, ...workspaceFile } = ProjectStore.workspaceFileFields(row);
    return toProject(row, enrichment, {
      ...workspaceFile,
      ...(folders === undefined
        ? {}
        : {
            folders:
              row.deletedAt === null
                ? yield* projectEnrichment.getAvailableFolders(folders)
                : folders,
          }),
    });
  });

  const readRow = (projectId: ProjectId, options?: { readonly includeDeleted?: boolean }) =>
    projects
      .get(projectId, options)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
        ),
      );

  const normalizeWorkspaceRoot = (input: {
    readonly projectId?: ProjectId;
    readonly workspaceRoot: string;
    readonly createIfMissing?: boolean;
  }) =>
    workspacePaths
      .normalizeWorkspaceRoot(input.workspaceRoot, {
        createIfMissing: input.createIfMissing ?? false,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectOperationError({
              operation: "normalize-workspace",
              ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
              workspaceRoot: input.workspaceRoot,
              cause,
            }),
        ),
      );

  /**
   * Plan one command against rows read under its locks, then commit its event or
   * its rejection. A reused command id resolves to the receipt it already has.
   */
  const commit = Effect.fn("ProjectService.commit")(function* (command: ProjectCommand) {
    const { projectId } = command;
    const dispatchError = (cause: unknown) =>
      new ProjectOperationError({ operation: "dispatch-project-command", projectId, cause });
    const planAndCommit = Effect.fn("ProjectService.planAndCommit")(function* (
      project: ProjectStore.ProjectRow | undefined,
      identities: ProjectCommandIdentities,
    ) {
      const workspaceOwner =
        identities.claimedRoot === undefined
          ? undefined
          : Option.getOrUndefined(
              yield* projects
                .findActiveByWorkspaceRoot(identities.claimedRoot)
                .pipe(Effect.mapError(dispatchError)),
            );
      const workspaceFileOwner =
        identities.claimedFile === undefined
          ? undefined
          : Option.getOrUndefined(
              yield* projects
                .findActiveByWorkspaceFile(identities.claimedFile)
                .pipe(Effect.mapError(dispatchError)),
            );
      const now = yield* DateTime.now;
      const eventId = yield* idAllocator.allocate
        .event({ commandId: command.commandId })
        .pipe(Effect.mapError(dispatchError));
      const planned = planProjectCommand({
        command,
        state: { project, workspaceOwner, workspaceFileOwner },
        eventId,
        now,
      });
      if (Result.isSuccess(planned)) {
        const { receipt } = yield* eventSink.commitProjectCommand({
          commandId: command.commandId,
          projectId,
          commandType: command.type,
          acceptedAt: now,
          event: planned.success,
        });
        return receipt;
      }
      return yield* eventSink.commitRejectedProjectCommand({
        commandId: command.commandId,
        projectId,
        commandType: command.type,
        rejectedAt: now,
        error: encodeProjectCommandRejection(planned.failure),
      });
    });
    const receipt = yield* projectLocks
      .withLock(
        projectId,
        Effect.gen(function* () {
          const project = Option.getOrUndefined(
            yield* readRow(projectId, { includeDeleted: true }),
          );
          const identities = projectCommandIdentities(command, project);
          const locks = [
            ...identities.roots.map((root) => [workspaceLocks, root] as const),
            ...identities.files.map((file) => [workspaceFileLocks, file] as const),
          ];
          // The first lock is outermost, so every command takes them in one order.
          return yield* locks.reduceRight(
            (effect, [executor, key]) => executor.withLock(key, effect),
            planAndCommit(project, identities),
          );
        }),
      )
      .pipe(Effect.mapError(dispatchError));
    if (receipt.projectId !== projectId || receipt.commandType !== command.type) {
      return yield* dispatchError(
        `Command ${command.commandId} was already used by ${receipt.commandType} for ${receipt.projectId}.`,
      );
    }
    // A retried command re-plans against the state it already produced, so its
    // first receipt, not the new plan, decides the outcome.
    if (receipt.status === "accepted") return;
    const rejection = Option.getOrUndefined(decodeProjectCommandRejection(receipt.error));
    switch (rejection?._tag) {
      case "ProjectWorkspaceConflictError":
        return yield* new ProjectConflictError({
          projectId,
          workspaceRoot: rejection.workspaceRoot,
          conflictingProjectId: rejection.conflictingProjectId,
        });
      case "ProjectWorkspaceFileConflictError":
        return yield* new ProjectFileConflictError({
          projectId,
          workspaceFile: rejection.workspaceFile,
          conflictingProjectId: rejection.conflictingProjectId,
        });
      case "ProjectCommandMissingProjectError":
        return yield* new ProjectNotFoundError({ projectId });
      default:
        return yield* dispatchError(
          rejection ?? receipt.error ?? "The command was previously rejected.",
        );
    }
  });

  const readCommitted = Effect.fn("ProjectService.readCommitted")(function* (projectId: ProjectId) {
    const row = yield* readRow(projectId, { includeDeleted: true });
    if (Option.isNone(row)) {
      return yield* new ProjectOperationError({
        operation: "read-project",
        projectId,
        cause: "The accepted project command did not produce a project row.",
      });
    }
    return yield* hydrate(row.value);
  });

  const getById: ProjectService["Service"]["getById"] = Effect.fn("ProjectService.getById")(
    function* (projectId, options) {
      const row = yield* readRow(projectId, options);
      return Option.isNone(row) ? Option.none() : Option.some(yield* hydrate(row.value));
    },
  );

  const getByWorkspaceRoot: ProjectService["Service"]["getByWorkspaceRoot"] = Effect.fn(
    "ProjectService.getByWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalized = yield* normalizeWorkspaceRoot({ workspaceRoot });
    const row = yield* (
      options?.includeDeleted === true
        ? projects
            .list({ includeDeleted: true })
            .pipe(
              Effect.map((rows) =>
                Option.fromUndefinedOr(
                  rows.find(
                    (row) => row.workspaceRoot === normalized && row.workspaceFile === null,
                  ),
                ),
              ),
            )
        : projects.findActiveByWorkspaceRoot(normalized)
    ).pipe(
      Effect.mapError((cause) => new ProjectOperationError({ operation: "list-projects", cause })),
    );
    return Option.isNone(row) ? Option.none() : Option.some(yield* hydrate(row.value));
  });

  const create: ProjectService["Service"]["create"] = Effect.fn("ProjectService.create")(
    function* (input) {
      const workspaceRoot = yield* normalizeWorkspaceRoot({
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
        createIfMissing: input.createWorkspaceRootIfMissing ?? false,
      });
      yield* commit({
        type: "project.create",
        commandId: input.commandId,
        projectId: input.projectId,
        title: input.title,
        workspaceRoot,
        ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
      });
      yield* projectEnrichment.invalidate([workspaceRoot]);
      return yield* readCommitted(input.projectId);
    },
  );

  const update: ProjectService["Service"]["update"] = Effect.fn("ProjectService.update")(
    function* (input) {
      if (input.workspaceFilePath !== undefined) {
        const { commandId, projectId, workspaceFilePath, ...edits } = input;
        if (Object.values(edits).some((value) => value !== undefined)) {
          return yield* new ProjectInvalidRequestError({
            projectId,
            detail: "Change a project's workspace file on its own, without other edits.",
          });
        }
        return yield* workspaceFilePath === null
          ? unlinkWorkspaceFile({ commandId, projectId })
          : linkWorkspaceFile({ commandId, projectId, workspaceFilePath });
      }
      const existing = yield* readRow(input.projectId);
      if (Option.isNone(existing)) {
        return yield* new ProjectNotFoundError({ projectId: input.projectId });
      }
      const previousRoot = existing.value.workspaceRoot;
      const workspaceRoot =
        input.workspaceRoot === undefined
          ? previousRoot
          : yield* normalizeWorkspaceRoot({
              projectId: input.projectId,
              workspaceRoot: input.workspaceRoot,
            });
      if (existing.value.workspaceFile !== null && workspaceRoot !== previousRoot) {
        return yield* new ProjectInvalidRequestError({
          projectId: input.projectId,
          detail:
            "A linked project's folders come from its workspace file. Relink or unlink the file to change them.",
        });
      }
      yield* commit({
        type: "project.meta.update",
        commandId: input.commandId,
        projectId: input.projectId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(workspaceRoot === previousRoot ? {} : { workspaceRoot }),
        ...(input.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: input.defaultModelSelection }),
        ...(input.autoPull === undefined ? {} : { autoPull: input.autoPull }),
        ...(input.projectIcon === undefined ? {} : { projectIcon: input.projectIcon }),
        ...(input.faviconPath === undefined ? {} : { faviconPath: input.faviconPath }),
        ...(input.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
        ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
      });
      if (workspaceRoot !== previousRoot) {
        yield* projectEnrichment.invalidate([previousRoot, workspaceRoot]);
      }
      return yield* readCommitted(input.projectId);
    },
  );

  const requireWorkspaceFileProjects =
    config.workspaceFileProjects === true
      ? Effect.void
      : Effect.fail(new WorkspaceFileProjectsDisabledError());

  /** Read a workspace file and probe its folders; its first folder must be usable. */
  const readUsableWorkspaceFile = Effect.fn("ProjectService.readUsableWorkspaceFile")(function* (
    projectId: ProjectId,
    workspaceFilePath: string,
  ) {
    const definition = yield* workspaceFiles
      .read(workspaceFilePath)
      .pipe(
        Effect.mapError(
          (error) => new WorkspaceFileUnavailableError({ projectId, diagnostic: error.diagnostic }),
        ),
      );
    const paths = definition.folders.flatMap((folder) =>
      folder.path === undefined ? [] : [folder.path],
    );
    // The parser rejects a file whose first folder isn't a local path.
    const [primary] = yield* projectEnrichment.probeFolders(paths);
    if (primary === undefined || primary.availability !== "available") {
      return yield* new WorkspaceFileUnavailableError({
        projectId,
        diagnostic: {
          code: "primary-unusable",
          message: `The workspace file's first folder is unavailable: ${paths[0] ?? definition.filePath}`,
          entryIndex: 0,
          ...(paths[0] === undefined ? {} : { path: paths[0] }),
        },
      });
    }
    return { ...definition, workspaceRoot: primary.path };
  });

  const defaultWorkspaceTitle = (
    filePath: string,
    primary: WorkspaceFolderEntry | undefined,
  ): string =>
    path
      .basename(filePath)
      .replace(/\.code-workspace$/i, "")
      .trim() ||
    primary?.name.trim() ||
    "Project";

  const importWorkspaceFile: ProjectService["Service"]["importWorkspaceFile"] = Effect.fn(
    "ProjectService.importWorkspaceFile",
  )(function* (input) {
    yield* requireWorkspaceFileProjects;
    const definition = yield* readUsableWorkspaceFile(input.projectId, input.workspaceFilePath);
    yield* commit({
      type: "project.create",
      commandId: input.commandId,
      projectId: input.projectId,
      title: input.title ?? defaultWorkspaceTitle(definition.filePath, definition.folders[0]),
      workspaceRoot: definition.workspaceRoot,
      workspaceFile: definition.filePath,
      folders: definition.folders,
    });
    yield* projectEnrichment.invalidate([definition.workspaceRoot]);
    return yield* readCommitted(input.projectId);
  });

  const linkWorkspaceFile: ProjectService["Service"]["linkWorkspaceFile"] = Effect.fn(
    "ProjectService.linkWorkspaceFile",
  )(function* (input) {
    yield* requireWorkspaceFileProjects;
    const existing = yield* readRow(input.projectId);
    if (Option.isNone(existing)) {
      return yield* new ProjectNotFoundError({ projectId: input.projectId });
    }
    const row = existing.value;
    const definition = yield* readUsableWorkspaceFile(input.projectId, input.workspaceFilePath);
    const linking = row.workspaceFile === null;
    if (linking && !isSamePath(definition.workspaceRoot, row.workspaceRoot)) {
      return yield* new WorkspaceFileUnavailableError({
        projectId: input.projectId,
        diagnostic: {
          code: "primary-unusable",
          message: `The workspace file's first folder must be this project's folder, ${row.workspaceRoot}. Reorder its folders in VS Code, or import it as a new project.`,
          entryIndex: 0,
          path: definition.workspaceRoot,
        },
      });
    }
    // A plain project keeps its root's stored spelling as the primary's path.
    const workspaceRoot = linking ? row.workspaceRoot : definition.workspaceRoot;
    const [, ...secondaryFolders] = definition.folders;
    const folders = [{ ...definition.folders[0]!, path: workspaceRoot }, ...secondaryFolders];
    const unchanged =
      definition.filePath === row.workspaceFile &&
      workspaceRoot === row.workspaceRoot &&
      row.folders?.length === folders.length &&
      folders.every(
        (folder, index) =>
          folder.path === row.folders?.[index]?.path &&
          folder.uri === row.folders?.[index]?.uri &&
          folder.name === row.folders?.[index]?.name,
      );
    if (!unchanged) {
      yield* commit({
        type: "project.meta.update",
        commandId: input.commandId,
        projectId: input.projectId,
        workspaceFile: definition.filePath,
        folders,
        ...(workspaceRoot === row.workspaceRoot ? {} : { workspaceRoot }),
      });
    }
    if (workspaceRoot !== row.workspaceRoot) {
      yield* projectEnrichment.invalidate([row.workspaceRoot, workspaceRoot]);
    }
    if (linking) {
      yield* bindThreadsAtLink({
        commandId: input.commandId,
        projectId: input.projectId,
        workspaceRoot,
        primaryName: folders[0]!.name,
      });
    }
    return yield* readCommitted(input.projectId);
  });

  const unlinkWorkspaceFile: ProjectService["Service"]["unlinkWorkspaceFile"] = Effect.fn(
    "ProjectService.unlinkWorkspaceFile",
  )(function* (input) {
    // Unlinking is the way back to a plain project, so it works with the
    // feature off and with the file gone. It never touches the disk.
    const existing = yield* readRow(input.projectId);
    if (Option.isNone(existing)) {
      return yield* new ProjectNotFoundError({ projectId: input.projectId });
    }
    if (existing.value.workspaceFile !== null) {
      yield* commit({
        type: "project.meta.update",
        commandId: input.commandId,
        projectId: input.projectId,
        workspaceFile: null,
        folders: null,
      });
    }
    return yield* readCommitted(input.projectId);
  });

  /**
   * A thread's snapshot entry for one folder. A folder that was unavailable
   * has no checkout root, so it stays outside git for the thread.
   */
  const snapshotFolder = (
    folder: WorkspaceFolderEntry & { readonly label: string },
    probe: WorkspaceFolderResolver.WorkspaceFolderProbe | undefined,
  ): OrchestrationV2ThreadWorkspaceFolder => {
    const checkout = probe?.availability === "available" ? (probe.vcs ?? null) : undefined;
    return {
      ...(folder.path === undefined ? {} : { path: folder.path }),
      ...(folder.uri === undefined ? {} : { uri: folder.uri }),
      name: folder.name,
      label: folder.label,
      ...(checkout === undefined
        ? {}
        : checkout === null
          ? { checkoutRoot: null }
          : { checkoutRoot: checkout.checkoutRoot, checkoutPrefix: checkout.checkoutPrefix }),
    };
  };

  const snapshotWorkspaceFolders: ProjectService["Service"]["snapshotWorkspaceFolders"] = Effect.fn(
    "ProjectService.snapshotWorkspaceFolders",
  )(function* (projectId) {
    const existing = yield* readRow(projectId);
    if (Option.isNone(existing)) return yield* new ProjectNotFoundError({ projectId });
    const row = existing.value;
    if (row.workspaceFile === null || row.folders === null) return undefined;
    const folders = allocateFolderLabels(row.folders);
    const probes = yield* projectEnrichment.probeFolders(
      folders.flatMap((folder) => (folder.path === undefined ? [] : [folder.path])),
    );
    const probeOf = (folder: WorkspaceFolderEntry) =>
      probes.find((probe) => probe.path === folder.path);
    if (probeOf(folders[0]!)?.availability !== "available") {
      return yield* new WorkspacePrimaryFolderUnavailableError({
        projectId,
        folderPath: row.workspaceRoot,
      });
    }
    return folders.map((folder) => snapshotFolder(folder, probeOf(folder)));
  });

  /**
   * Linking freezes each existing thread at the one folder it works in, with
   * its worktree as a one-member set, so a later primary change never moves
   * it and the link never widens what it reaches. Each thread commits under
   * its own lock, idempotently per link command.
   */
  const bindThreadsAtLink = Effect.fn("ProjectService.bindThreadsAtLink")(function* (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly primaryName: string;
  }) {
    const { projectId } = input;
    const snapshot = yield* threadProjections
      .getShellSnapshot()
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-threads", projectId, cause }),
        ),
      );
    const unbound = [...snapshot.threads, ...snapshot.archivedThreads].filter(
      (thread) =>
        thread.projectId === projectId &&
        thread.deletedAt === null &&
        thread.workspaceFolderCount === undefined,
    );
    if (unbound.length === 0) return;
    const probes = yield* projectEnrichment.probeFolders([
      input.workspaceRoot,
      ...unbound.map((thread) => thread.worktreePath ?? input.workspaceRoot),
    ]);
    const probeAt = (folderPath: string) => probes.find((probe) => probe.path === folderPath);
    const primaryCheckout = probeAt(input.workspaceRoot)?.vcs ?? null;
    const [label] = allocateFolderLabels([{ path: input.workspaceRoot, name: input.primaryName }]);

    const bindThread = Effect.fn("ProjectService.bindThreadAtLink")(function* (threadId: ThreadId) {
      const thread = yield* threadProjections.getThread(threadId);
      if (
        thread.deletedAt !== null ||
        thread.projectId !== projectId ||
        thread.workspaceFolders !== undefined
      ) {
        return;
      }
      const folderPath = thread.worktreePath ?? input.workspaceRoot;
      const probe = probeAt(folderPath);
      const folder = snapshotFolder(
        { path: folderPath, name: input.primaryName, label: label!.label },
        probe,
      );
      // The thread's own worktree of the primary's repository is its set.
      const checkout = probe?.availability === "available" ? probe.vcs : null;
      const member: OrchestrationV2ThreadWorktree | undefined =
        thread.worktreePath !== null &&
        thread.branch !== null &&
        checkout != null &&
        primaryCheckout !== null &&
        isSamePath(checkout.commonDir, primaryCheckout.commonDir) &&
        !isSamePath(checkout.checkoutRoot, primaryCheckout.checkoutRoot)
          ? {
              repositoryRoot: primaryCheckout.checkoutRoot,
              path: checkout.checkoutRoot,
              branch: thread.branch,
            }
          : undefined;
      const withSet =
        member === undefined
          ? undefined
          : planThreadWorkspaceUpdate(thread, { workspaceFolders: [folder], worktrees: [member] });
      const binding =
        withSet !== undefined && Result.isSuccess(withSet)
          ? withSet
          : planThreadWorkspaceUpdate(thread, { workspaceFolders: [folder] });
      if (Result.isFailure(binding)) {
        return yield* Effect.logWarning("Could not freeze a thread's folder at link", {
          threadId,
          detail: binding.failure,
        });
      }
      const commandId = CommandId.make(`${input.commandId}:bind-thread:${threadId}`);
      const now = yield* DateTime.now;
      const committed = yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "thread.metadata.update",
        acceptedAt: now,
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId, commandId }),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: thread.providerInstanceId,
            occurredAt: now,
            // Binding isn't activity, so the thread keeps its place in lists.
            payload: { ...thread, ...binding.success },
          },
        ],
        effects: [],
      });
      if (committed.receipt.threadId !== threadId) {
        return yield* Effect.fail(`Command ${commandId} belongs to another thread.`);
      }
    });

    yield* Effect.forEach(
      unbound,
      (thread) =>
        threadCommands
          .withLock(thread.id, bindThread(thread.id))
          .pipe(
            Effect.mapError(
              (cause) => new ProjectOperationError({ operation: "bind-threads", projectId, cause }),
            ),
          ),
      { concurrency: 1, discard: true },
    );
  });

  const bootstrap: ProjectService["Service"]["bootstrap"] = Effect.fn("ProjectService.bootstrap")(
    function* (input) {
      const existing = yield* getByWorkspaceRoot(input.workspaceRoot);
      if (Option.isSome(existing)) return { project: existing.value, created: false };
      return { project: yield* create(input), created: true };
    },
  );

  /** Delete one child thread durably; a stable command id makes a retry resume the cascade. */
  const deleteChildThread = Effect.fn("ProjectService.deleteChildThread")(function* (
    input: ProjectDeleteInput,
    threadId: ThreadId,
  ) {
    yield* legacyImporter.ensureTranscript(threadId);
    const projection = yield* threadProjections.getThreadRecords(threadId, [
      "runs",
      "attempts",
      "nodes",
      "runtimeRequests",
      "subagents",
      "providerSessions",
    ]);
    if (projection.thread.deletedAt !== null || projection.thread.projectId !== input.projectId) {
      return;
    }
    const command = {
      type: "thread.delete" as const,
      commandId: CommandId.make(`${input.commandId}:delete-thread:${threadId}`),
      threadId,
    };
    const now = yield* DateTime.now;
    const plan = yield* planThreadDeletion({
      command,
      projection,
      attachmentIds: yield* threadProjections.getThreadAttachmentIds(threadId),
      now,
      idAllocator,
    });
    const committed = yield* eventSink.commitCommand({
      commandId: command.commandId,
      commandType: command.type,
      threadId,
      acceptedAt: now,
      events: plan.events,
      effects: plan.effects,
    });
    if (
      committed.receipt.threadId !== command.threadId ||
      committed.receipt.commandType !== command.type
    ) {
      return yield* Effect.fail("The thread deletion command ID belongs to a different command.");
    }
    if (committed.receipt.status === "rejected") {
      return yield* Effect.fail(
        committed.receipt.error ?? "Thread deletion was previously rejected.",
      );
    }
  });

  /** Refuse a non-empty project without force, else delete its live threads first. */
  const deleteChildThreads = Effect.fn("ProjectService.deleteChildThreads")(function* (
    input: ProjectDeleteInput,
  ) {
    const { projectId } = input;
    // The V2 shell is the only record of which threads are live.
    const snapshot = yield* threadProjections
      .getShellSnapshot()
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-threads", projectId, cause }),
        ),
      );
    const projectThreads = [...snapshot.threads, ...snapshot.archivedThreads].filter(
      (thread) => thread.projectId === projectId,
    );
    if (projectThreads.length > 0 && input.force !== true) {
      return yield* new ProjectNotEmptyError({ projectId });
    }
    // Delete children durably before the project so a failed cascade can be retried.
    yield* Effect.forEach(
      projectThreads,
      (thread) =>
        threadCommands
          .withLock(thread.id, deleteChildThread(input, thread.id))
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProjectOperationError({ operation: "delete-thread", projectId, cause }),
            ),
          ),
      { concurrency: 1, discard: true },
    );
  });

  const deleteProject: ProjectService["Service"]["delete"] = Effect.fn("ProjectService.delete")(
    function* (input) {
      const { projectId } = input;
      // A deleted row still reaches commit, so a retried command id replays its
      // receipt and any other command id is rejected as not found.
      const existing = yield* readRow(projectId, { includeDeleted: true });
      if (Option.isNone(existing)) {
        return yield* new ProjectNotFoundError({ projectId });
      }

      if (existing.value.deletedAt === null) {
        yield* deleteChildThreads(input);
      }
      yield* commit({ type: "project.delete", commandId: input.commandId, projectId });
      yield* projectEnrichment.invalidate([existing.value.workspaceRoot]);
      return yield* readCommitted(projectId);
    },
  );

  const enrichShell = (shell: OrchestrationProjectShell) =>
    projectEnrichment.getAvailable(shell.workspaceRoot).pipe(
      Effect.map((enrichment) => ({
        ...shell,
        repositoryIdentity: enrichment.repositoryIdentity,
      })),
    );

  const getShell: ProjectService["Service"]["getShell"] = Effect.fn("ProjectService.getShell")(
    function* (projectId) {
      const shell = yield* projects
        .getShell(projectId)
        .pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
          ),
        );
      return Option.isNone(shell) ? shell : Option.some(yield* enrichShell(shell.value));
    },
  );

  const listShells: ProjectService["Service"]["listShells"] = Effect.fn(
    "ProjectService.listShells",
  )(function* (options) {
    const shells = yield* projects
      .listShells(options)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-projects", cause }),
        ),
      );
    return yield* Effect.forEach(shells, enrichShell, { concurrency: 16 });
  });

  const snapshot = Effect.gen(function* () {
    const rows = yield* projects
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-projects", cause }),
        ),
      );
    const hydrated = yield* Effect.forEach(rows, hydrate, { concurrency: 8 });
    return {
      projects: hydrated,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies ProjectSnapshot;
  });

  return ProjectService.of({
    create,
    bootstrap,
    update,
    importWorkspaceFile,
    linkWorkspaceFile,
    unlinkWorkspaceFile,
    snapshotWorkspaceFolders,
    delete: deleteProject,
    getById,
    getByWorkspaceRoot,
    snapshot,
    getShell,
    listShells,
  });
});

export const layer = Layer.effect(ProjectService, make).pipe(
  Layer.provide(Layer.merge(ThreadCommandExecutor.layer, WorkspaceFiles.layer)),
);
