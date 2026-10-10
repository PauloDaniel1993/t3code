import {
  type CommandId,
  type EventId,
  MAX_SCRIPT_ID_LENGTH,
  type ModelSelection,
  type ProjectIconOverride,
  ProjectId,
  type ProjectScript,
  SCRIPT_RUN_COMMAND_PATTERN,
  type ThreadEnvMode,
  type WorkspaceFolderEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UnsequencedProjectEvent } from "../persistence/Services/OrchestrationEventStore.ts";
import type { ProjectRow } from "./ProjectStore.ts";

export interface ProjectCreateCommand {
  readonly type: "project.create";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  /** Creates the project linked to this workspace file, with its `folders`. */
  readonly workspaceFile?: string;
  readonly folders?: ReadonlyArray<WorkspaceFolderEntry>;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface ProjectMetaUpdateCommand {
  readonly type: "project.meta.update";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly workspaceRoot?: string;
  /** Absent leaves the link unchanged; null unlinks, together with `folders: null`. */
  readonly workspaceFile?: string | null;
  readonly folders?: ReadonlyArray<WorkspaceFolderEntry> | null;
  /**
   * The workspace file the caller read the project with (null: plain). A
   * link decided against that read is rejected once another command changed it.
   */
  readonly expectedWorkspaceFile?: string | null;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null;
  readonly autoPull?: boolean;
  readonly faviconPath?: string | null;
  readonly projectIcon?: ProjectIconOverride | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface ProjectDeleteCommand {
  readonly type: "project.delete";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export type ProjectCommand = ProjectCreateCommand | ProjectMetaUpdateCommand | ProjectDeleteCommand;

export class ProjectCommandInvariantError extends Schema.TaggedError<ProjectCommandInvariantError>()(
  "ProjectCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Project command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

/** The command targets a project that does not exist or was deleted. */
export class ProjectCommandMissingProjectError extends Schema.TaggedError<ProjectCommandMissingProjectError>()(
  "ProjectCommandMissingProjectError",
  {
    commandType: Schema.String,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist for command '${this.commandType}'.`;
  }
}

export class ProjectWorkspaceConflictError extends Schema.TaggedError<ProjectWorkspaceConflictError>()(
  "ProjectWorkspaceConflictError",
  {
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Active project '${this.conflictingProjectId}' already exists for workspace root '${this.workspaceRoot}'.`;
  }
}

export class ProjectWorkspaceFileConflictError extends Schema.TaggedError<ProjectWorkspaceFileConflictError>()(
  "ProjectWorkspaceFileConflictError",
  {
    workspaceFile: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Active project '${this.conflictingProjectId}' is already linked to workspace file '${this.workspaceFile}'.`;
  }
}

export const ProjectCommandRejection = Schema.Union([
  ProjectCommandInvariantError,
  ProjectCommandMissingProjectError,
  ProjectWorkspaceConflictError,
  ProjectWorkspaceFileConflictError,
]);
export type ProjectCommandRejection = typeof ProjectCommandRejection.Type;

const ProjectCommandRejectionJson = Schema.fromJsonString(ProjectCommandRejection);
/**
 * A rejected receipt stores its rejection as JSON, so a retried command id
 * replays the same typed error even when a fresh plan would now succeed.
 */
export const encodeProjectCommandRejection = Schema.encodeSync(ProjectCommandRejectionJson);
/** None for receipts that predate structured rejections. */
export const decodeProjectCommandRejection = Schema.decodeUnknownOption(
  ProjectCommandRejectionJson,
);

export interface ProjectCommandState {
  /** The target project's row, including a soft-deleted one; only create sees deleted rows as taken. */
  readonly project: ProjectRow | undefined;
  /** The active plain project that holds the root the command claims, if any. */
  readonly workspaceOwner: ProjectRow | undefined;
  /** The active project linked to the workspace file the command claims, if any. */
  readonly workspaceFileOwner: ProjectRow | undefined;
}

/**
 * The identities a command takes or gives up. A plain project owns its root,
 * and a linked project its workspace file, so linking gives up the root and
 * unlinking claims it back.
 */
export interface ProjectCommandIdentities {
  /** The root the command newly holds as a plain project. */
  readonly claimedRoot?: string;
  /** The workspace file the command newly links. */
  readonly claimedFile?: string;
  /** Every root it claims or releases, sorted. Their locks are taken before the files'. */
  readonly roots: ReadonlyArray<string>;
  /** Every workspace file it claims or releases, sorted. */
  readonly files: ReadonlyArray<string>;
}

const sortedUnique = (values: ReadonlyArray<string | undefined>) =>
  Array.from(new Set(values.filter((value) => value !== undefined))).toSorted();

/** Decide which identities a command claims and locks, against its project's current row. */
export function projectCommandIdentities(
  command: ProjectCommand,
  project: ProjectRow | undefined,
): ProjectCommandIdentities {
  if (command.type === "project.create") {
    return command.workspaceFile === undefined
      ? { claimedRoot: command.workspaceRoot, roots: [command.workspaceRoot], files: [] }
      : { claimedFile: command.workspaceFile, roots: [], files: [command.workspaceFile] };
  }
  if (command.type === "project.delete" || project === undefined || project.deletedAt !== null) {
    return { roots: [], files: [] };
  }
  const previousFile = project.workspaceFile;
  const nextFile = command.workspaceFile === undefined ? previousFile : command.workspaceFile;
  if (nextFile === null) {
    const claimedRoot =
      command.workspaceRoot !== undefined || previousFile !== null
        ? (command.workspaceRoot ?? project.workspaceRoot)
        : undefined;
    return {
      ...(claimedRoot === undefined ? {} : { claimedRoot }),
      roots: sortedUnique([claimedRoot]),
      files: sortedUnique([previousFile ?? undefined]),
    };
  }
  if (nextFile === previousFile) return { roots: [], files: [] };
  return {
    claimedFile: nextFile,
    roots: previousFile === null ? [project.workspaceRoot] : [],
    files: sortedUnique([nextFile, previousFile ?? undefined]),
  };
}

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

/**
 * A linked project's first folder is its primary folder, at `workspaceRoot`,
 * and each folder has exactly one of a path or a URI. A plain project stores
 * no folders.
 */
function workspaceLinkViolation(project: {
  readonly workspaceRoot: string;
  readonly workspaceFile: string | null;
  readonly folders: ReadonlyArray<WorkspaceFolderEntry> | null;
}): string | undefined {
  if (project.workspaceFile === null) {
    return project.folders === null ? undefined : "A plain project cannot store workspace folders.";
  }
  if (project.folders?.[0]?.path !== project.workspaceRoot) {
    return "A linked project's first workspace folder must be its workspace root.";
  }
  if (
    project.folders.some((folder) => (folder.path === undefined) === (folder.uri === undefined))
  ) {
    return "Each workspace folder needs exactly one of a path or a URI.";
  }
  return undefined;
}

/**
 * Decide one project command against the rows it touches. The caller reads
 * `state` under the project's lock and commits the planned event.
 */
export function planProjectCommand(input: {
  readonly command: ProjectCommand;
  readonly state: ProjectCommandState;
  readonly eventId: EventId;
  readonly now: DateTime.Utc;
}): Result.Result<UnsequencedProjectEvent, ProjectCommandRejection> {
  const { command, state } = input;
  const invariant = (detail: string) =>
    Result.fail(new ProjectCommandInvariantError({ commandType: command.type, detail }));
  const missingProject = () =>
    Result.fail(
      new ProjectCommandMissingProjectError({
        commandType: command.type,
        projectId: command.projectId,
      }),
    );
  const activeProject = state.project?.deletedAt === null ? state.project : undefined;
  const requireWorkspaceAvailable = (workspaceRoot: string) =>
    state.workspaceOwner === undefined || state.workspaceOwner.projectId === command.projectId
      ? undefined
      : new ProjectWorkspaceConflictError({
          workspaceRoot,
          conflictingProjectId: state.workspaceOwner.projectId,
        });
  const requireWorkspaceFileAvailable = (workspaceFile: string) =>
    state.workspaceFileOwner === undefined ||
    state.workspaceFileOwner.projectId === command.projectId
      ? undefined
      : new ProjectWorkspaceFileConflictError({
          workspaceFile,
          conflictingProjectId: state.workspaceFileOwner.projectId,
        });
  const requireIdentitiesAvailable = () => {
    const identities = projectCommandIdentities(command, state.project);
    return (
      (identities.claimedRoot === undefined
        ? undefined
        : requireWorkspaceAvailable(identities.claimedRoot)) ??
      (identities.claimedFile === undefined
        ? undefined
        : requireWorkspaceFileAvailable(identities.claimedFile))
    );
  };
  const occurredAt = DateTime.formatIso(input.now);
  const base = {
    eventId: input.eventId,
    aggregateKind: "project" as const,
    aggregateId: command.projectId,
    occurredAt,
    commandId: command.commandId,
    causationEventId: null,
    correlationId: command.commandId,
    metadata: {},
  };

  switch (command.type) {
    case "project.create": {
      if (state.project !== undefined) {
        return invariant(
          `Project '${command.projectId}' already exists and cannot be created twice.`,
        );
      }
      const linkViolation = workspaceLinkViolation({
        workspaceRoot: command.workspaceRoot,
        workspaceFile: command.workspaceFile ?? null,
        folders: command.folders ?? null,
      });
      if (linkViolation !== undefined) return invariant(linkViolation);
      const conflict = requireIdentitiesAvailable();
      if (conflict !== undefined) return Result.fail(conflict);
      return Result.succeed({
        ...base,
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          ...(command.workspaceFile === undefined ? {} : { workspaceFile: command.workspaceFile }),
          ...(command.folders === undefined ? {} : { folders: command.folders }),
          // Project creation has no user model choice. Older clients sent an
          // automatic seed, but only a metadata update records an explicit default.
          defaultModelSelection: null,
          faviconPath: null,
          projectIcon: null,
          scripts: command.scripts ?? [],
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
    }

    case "project.meta.update": {
      const project = activeProject;
      if (project === undefined) return missingProject();
      if (
        command.projectIcon?.kind === "monogram" &&
        Array.from(monogramSegmenter.segment(command.projectIcon.text)).length > 2
      ) {
        return invariant("Project monograms must contain at most two characters.");
      }
      if (command.scripts !== undefined) {
        // Persisted IDs predate shortcut validation. Let users edit or remove them
        // without allowing another invalid ID to enter the project.
        const existingIds = new Set(project.scripts.map((script) => script.id));
        for (const script of command.scripts) {
          if (!existingIds.has(script.id) && !isScriptRunCommand(`script.${script.id}.run`)) {
            // The raw ID is unbounded user input and this detail is persisted.
            return invariant(
              `Script IDs must be 1-${MAX_SCRIPT_ID_LENGTH} lowercase letters, digits or hyphens, starting with a letter or digit (got ${script.id.length} characters).`,
            );
          }
        }
      }
      if (
        command.expectedWorkspaceFile !== undefined &&
        command.expectedWorkspaceFile !== project.workspaceFile
      ) {
        return invariant("The project's workspace file changed meanwhile; try again.");
      }
      if (
        command.workspaceRoot !== undefined ||
        command.workspaceFile !== undefined ||
        command.folders !== undefined
      ) {
        const linkViolation = workspaceLinkViolation({
          workspaceRoot: command.workspaceRoot ?? project.workspaceRoot,
          workspaceFile:
            command.workspaceFile === undefined ? project.workspaceFile : command.workspaceFile,
          folders: command.folders === undefined ? project.folders : command.folders,
        });
        if (linkViolation !== undefined) return invariant(linkViolation);
      }
      const conflict = requireIdentitiesAvailable();
      if (conflict !== undefined) return Result.fail(conflict);
      return Result.succeed({
        ...base,
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.workspaceRoot === undefined ? {} : { workspaceRoot: command.workspaceRoot }),
          ...(command.workspaceFile === undefined ? {} : { workspaceFile: command.workspaceFile }),
          ...(command.folders === undefined ? {} : { folders: command.folders }),
          ...(command.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: command.defaultModelSelection }),
          ...(command.defaultThreadEnvMode === undefined
            ? {}
            : { defaultThreadEnvMode: command.defaultThreadEnvMode }),
          ...(command.autoPull === undefined ? {} : { autoPull: command.autoPull }),
          ...(command.faviconPath === undefined ? {} : { faviconPath: command.faviconPath }),
          ...(command.projectIcon === undefined ? {} : { projectIcon: command.projectIcon }),
          ...(command.scripts === undefined ? {} : { scripts: command.scripts }),
          updatedAt: occurredAt,
        },
      });
    }

    case "project.delete": {
      if (activeProject === undefined) return missingProject();
      // Thread children are deleted by ProjectService before this event commits.
      return Result.succeed({
        ...base,
        type: "project.deleted",
        payload: { projectId: command.projectId, deletedAt: occurredAt },
      });
    }
  }
}
