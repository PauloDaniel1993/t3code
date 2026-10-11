import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { RepositoryIdentity, ThreadEnvMode } from "./environment.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  CommandId,
  ForwardCompatibleArray,
  ForwardCompatibleOptional,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_SEARCH_CONTENTS_MAX_LIMIT = 500;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  /** Original workspace folder path; absent means the thread's primary folder. */
  folderPath: Schema.optional(TrimmedNonEmptyString),
  /** Start the agent while setup runs unless explicitly disabled. */
  async: Schema.optional(Schema.Boolean),
  previewUrl: Schema.optional(TrimmedNonEmptyString),
  autoOpenPreview: Schema.optional(Schema.Boolean),
});
export type ProjectScript = typeof ProjectScript.Type;

export const ProjectIconColor = Schema.Literals([
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);
export type ProjectIconColor = typeof ProjectIconColor.Type;

const ProjectLucideIconName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

const ProjectEmoji = TrimmedNonEmptyString.check(Schema.isMaxLength(32));

// Grapheme-count validation belongs to the server command boundary, not snapshot decoding.
export const ProjectMonogramText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200c\u200d]*$/u),
);

const ProjectLucideIcon = Schema.Struct({
  kind: Schema.Literal("lucide"),
  name: ProjectLucideIconName,
  color: ProjectIconColor,
});
const ProjectEmojiIcon = Schema.Struct({
  kind: Schema.Literal("emoji"),
  emoji: ProjectEmoji,
});
const ProjectMonogramIcon = Schema.Struct({
  kind: Schema.Literal("monogram"),
  text: ProjectMonogramText,
  color: ProjectIconColor,
});
const ProjectIcon = Schema.Union([ProjectLucideIcon, ProjectEmojiIcon, ProjectMonogramIcon]);
const ProjectLucideIconWire = Schema.Struct({
  ...ProjectLucideIcon.fields,
  monogramText: Schema.optional(ProjectMonogramText),
  monogram: Schema.optional(ProjectMonogramText),
});

/** A workspace-relative image a project may use as its favicon. */
export const ProjectFaviconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i),
);
export type ProjectFaviconPath = typeof ProjectFaviconPath.Type;

// Older peers only know lucide/emoji. Keep monograms out of their validated
// `monogram` field too: old grapheme counters can reject otherwise valid text.
export const ProjectIconOverride = Schema.Union([
  ProjectLucideIconWire,
  ProjectEmojiIcon,
  ProjectMonogramIcon,
]).pipe(
  Schema.decodeTo(
    ProjectIcon,
    SchemaTransformation.transform({
      decode: (icon): typeof ProjectIcon.Type => {
        if (icon.kind !== "lucide") return icon;
        const text = icon.monogramText ?? icon.monogram;
        return text === undefined
          ? { kind: "lucide", name: icon.name, color: icon.color }
          : { kind: "monogram", text, color: icon.color };
      },
      encode: (icon) =>
        icon.kind === "monogram"
          ? {
              kind: "lucide" as const,
              name: "folder-code",
              color: icon.color,
              monogramText: icon.text,
            }
          : icon,
    }),
  ),
);
export type ProjectIconOverride = typeof ProjectIconOverride.Type;

/**
 * One folder named by a linked project's workspace file, as stored: in file
 * order, deduplicated. Exactly one of `path` and `uri` is set.
 */
export const WorkspaceFolderEntry = Schema.Struct({
  /** Normalized absolute server path, from a plain path or a converted `file:` URI. */
  path: Schema.optional(TrimmedNonEmptyString),
  /** A kept non-file URI, such as `vscode-remote://ssh-remote+devbox/srv/api`. */
  uri: Schema.optional(TrimmedNonEmptyString),
  /** The file's `name`, else the basename or last URI segment. */
  name: TrimmedNonEmptyString,
});
export type WorkspaceFolderEntry = typeof WorkspaceFolderEntry.Type;

export const WorkspaceFolderUnavailableReason = Schema.Literals([
  "missing",
  "not-directory",
  "inaccessible",
  "remote",
]);
export type WorkspaceFolderUnavailableReason = typeof WorkspaceFolderUnavailableReason.Type;

/**
 * A linked project's folder as served: the stored entry plus derived and probed
 * facts. Values a newer server adds decode as absent instead of failing the shell.
 */
export const ProjectWorkspaceFolder = Schema.Struct({
  ...WorkspaceFolderEntry.fields,
  /** The folder's unique canonical path label. Derived from the entries, never stored. */
  label: TrimmedNonEmptyString,
  /** Absent until probed. "unavailable" carries `unavailableReason`. */
  availability: ForwardCompatibleOptional(Schema.Literals(["available", "unavailable"])),
  unavailableReason: ForwardCompatibleOptional(WorkspaceFolderUnavailableReason),
  /** Where a remote URI folder lives, e.g. "SSH: devbox". */
  remoteDescription: Schema.optional(TrimmedNonEmptyString),
  /** Absent until enriched; null when the folder is not inside a git repository. */
  vcs: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        /** Realpath of `git rev-parse --show-toplevel`. */
        checkoutRoot: TrimmedNonEmptyString,
        /** Omitted on `folders[0]`, whose identity is the project's `repositoryIdentity`. */
        repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
      }),
    ),
  ),
});
export type ProjectWorkspaceFolder = typeof ProjectWorkspaceFolder.Type;

export const WorkspaceFileDiagnosticCode = Schema.Literals([
  "file-not-found",
  "not-a-file",
  "unreadable",
  "malformed-jsonc",
  "invalid-shape",
  "empty-folders",
  "primary-unusable",
  "primary-remote",
  "conflict",
]);
export type WorkspaceFileDiagnosticCode = typeof WorkspaceFileDiagnosticCode.Type;

/** Why a workspace file or one of its entries can't be used. */
export const WorkspaceFileDiagnostic = Schema.Struct({
  code: WorkspaceFileDiagnosticCode,
  message: TrimmedNonEmptyString,
  /** Index of the offending entry in the file's `folders`. */
  entryIndex: Schema.optional(NonNegativeInt),
  /** The server path concerned: the workspace file or a resolved folder. */
  path: Schema.optional(TrimmedNonEmptyString),
  /** 1-based position in the file, for syntax errors. */
  line: Schema.optional(PositiveInt),
  column: Schema.optional(PositiveInt),
});
export type WorkspaceFileDiagnostic = typeof WorkspaceFileDiagnostic.Type;

/** Server-owned sync health of a linked project's workspace file. Never an event. */
export const WorkspaceFileStatus = Schema.Struct({
  state: Schema.Literals(["ok", "missing", "unreadable", "invalid"]),
  // Diagnostics with codes this build doesn't know are dropped.
  diagnostics: ForwardCompatibleArray(WorkspaceFileDiagnostic),
  /** False when the file can't be watched; changes then apply only on load or Refresh. */
  liveDetection: Schema.Boolean,
});
export type WorkspaceFileStatus = typeof WorkspaceFileStatus.Type;

/**
 * Fields only a project linked to a workspace file carries. Plain projects
 * omit them on the wire, and clients derive their one folder from
 * `workspaceRoot`.
 */
export const ProjectWorkspaceFileFields = {
  /** Normalized server path of the linked workspace file. */
  workspaceFile: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /**
   * In file order. `folders[0]` is the primary folder, and its `path` is
   * `workspaceRoot`. Strict, because dropping a folder would shift the primary.
   */
  folders: Schema.optional(Schema.Array(ProjectWorkspaceFolder)),
  /** A `state` this build doesn't know decodes as absent. */
  workspaceFileStatus: ForwardCompatibleOptional(WorkspaceFileStatus),
};

export const Project = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  ...ProjectWorkspaceFileFields,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Opt-in because background sync performs network I/O and may move the checkout.
  autoPull: Schema.optional(Schema.Boolean),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type Project = typeof Project.Type;

export const ProjectSnapshot = Schema.Struct({
  projects: Schema.Array(Project),
  updatedAt: IsoDateTime,
});
export type ProjectSnapshot = typeof ProjectSnapshot.Type;

export const ProjectChange = Schema.Union([
  Schema.Struct({ type: Schema.Literal("project.upserted"), project: Project }),
  Schema.Struct({
    type: Schema.Literal("project.deleted"),
    projectId: ProjectId,
    deletedAt: IsoDateTime,
  }),
]);
export type ProjectChange = typeof ProjectChange.Type;

export const ProjectCreatePayload = Schema.Struct({
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});
export type ProjectCreatePayload = typeof ProjectCreatePayload.Type;

/** A project made from a VS Code workspace file; the server reads its folders. */
export const ProjectImportWorkspaceFilePayload = Schema.Struct({
  /** A server path to the `.code-workspace` file. */
  workspaceFilePath: TrimmedNonEmptyString,
  /** Defaults to the file name without `.code-workspace`. */
  title: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectImportWorkspaceFilePayload = typeof ProjectImportWorkspaceFilePayload.Type;

export const ProjectUpdatePayload = Schema.Struct({
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  /**
   * Absent leaves the link unchanged. A path links a plain project, relinks a
   * linked one, or re-reads the same file; null unlinks. Sent on its own.
   */
  workspaceFilePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  autoPull: Schema.optional(Schema.Boolean),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});
export type ProjectUpdatePayload = typeof ProjectUpdatePayload.Type;

// An older server rejects a variant it doesn't know, so an import never falls
// through to directory or name-only creation.
export const ProjectMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("project.create"),
    commandId: CommandId,
    projectId: ProjectId,
    ...ProjectCreatePayload.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("project.import-workspace-file"),
    commandId: CommandId,
    projectId: ProjectId,
    ...ProjectImportWorkspaceFilePayload.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("project.update"),
    commandId: CommandId,
    projectId: ProjectId,
    ...ProjectUpdatePayload.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("project.delete"),
    commandId: CommandId,
    projectId: ProjectId,
    force: Schema.optional(Schema.Boolean),
  }),
]);
export type ProjectMutation = typeof ProjectMutation.Type;

export class ProjectMutationError extends Schema.TaggedError<ProjectMutationError>()(
  "ProjectMutationError",
  {
    commandId: CommandId,
    message: Schema.String,
    /** Why a workspace file can't be imported or linked. A newer server's code decodes as absent. */
    diagnostic: ForwardCompatibleOptional(WorkspaceFileDiagnostic),
    /** The project that already holds the requested workspace file or folder. */
    conflictingProjectId: Schema.optional(ProjectId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** The workspace file is missing, unreadable or invalid, so it can't be imported, linked or bound. */
export class WorkspaceFileUnavailableError extends Schema.TaggedError<WorkspaceFileUnavailableError>()(
  "WorkspaceFileUnavailableError",
  {
    projectId: ProjectId,
    diagnostic: WorkspaceFileDiagnostic,
  },
) {
  override get message(): string {
    return this.diagnostic.message;
  }
}

/** A linked project's primary folder is unavailable, so no thread can start or run in it. */
export class WorkspacePrimaryFolderUnavailableError extends Schema.TaggedError<WorkspacePrimaryFolderUnavailableError>()(
  "WorkspacePrimaryFolderUnavailableError",
  {
    projectId: ProjectId,
    folderPath: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Primary folder unavailable: ${this.folderPath}. Restore the folder or fix the workspace file.`;
  }
}

/** Workspace-file projects are turned off on this server. */
export class WorkspaceFileProjectsDisabledError extends Schema.TaggedError<WorkspaceFileProjectsDisabledError>()(
  "WorkspaceFileProjectsDisabledError",
  {},
) {
  override get message(): string {
    return "Workspace-file projects are not enabled on this server.";
  }
}

export const ProjectEntryKind = Schema.Literals(["file", "directory"]);
export type ProjectEntryKind = typeof ProjectEntryKind.Type;

/**
 * Which folders a scoped file request addresses. With a thread, its frozen
 * folder snapshot, mapped into its worktrees; otherwise the project's current
 * folders.
 */
export const WorkspaceScope = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  /**
   * One folder's identity: its original path, or its kept URI. A search
   * narrows to it, and a canonical path must resolve to it, so a rename
   * between search and open can't open another folder. To open a result,
   * pin the folder-table row whose label starts the result's path: a nested
   * folder's files carry that folder's label, even in a search narrowed to
   * its parent.
   */
  folderPath: Schema.optional(TrimmedNonEmptyString),
});
export type WorkspaceScope = typeof WorkspaceScope.Type;

/**
 * One folder of a scoped response, in workspace order, primary first. The
 * response's paths start with `label/`, unless the scope has one folder.
 */
export const WorkspaceScopeFolder = Schema.Struct({
  folderPath: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  /** "index-error": searching this folder failed, which is not "no matches". */
  status: Schema.Literals(["ok", "unavailable", "index-error"]),
});
export type WorkspaceScopeFolder = typeof WorkspaceScopeFolder.Type;

/** A scoped request names a folder the scope doesn't have, or one it can't reach. */
export class WorkspaceScopeError extends Schema.TaggedError<WorkspaceScopeError>()(
  "WorkspaceScopeError",
  {
    failure: Schema.Literals([
      "project-not-found",
      "thread-not-found",
      "folder-not-found",
      // The path's label now names a different folder than `folderPath`.
      "folder-changed",
      "folder-unavailable",
      "read-failed",
    ]),
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    /** The folder concerned: its identity, or the label a path started with. */
    folder: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const folder = this.folder === undefined ? "" : ` '${this.folder}'`;
    switch (this.failure) {
      case "project-not-found":
        return `Project ${this.projectId} was not found.`;
      case "thread-not-found":
        return `Thread ${this.threadId} was not found in project ${this.projectId}.`;
      case "folder-not-found":
        return `Workspace folder${folder} is not part of this workspace.`;
      case "folder-changed":
        return `Workspace folder${folder} changed. Search again.`;
      case "folder-unavailable":
        return `Workspace folder${folder} is unavailable.`;
      case "read-failed":
        return "Failed to read the workspace folders.";
    }
  }
}

const ProjectSearchEntriesFields = {
  // An empty query is a bounded browse: the index returns frecency-ordered
  // entries, which the file picker uses for its initial results.
  query: TrimmedString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
  kind: Schema.optional(ProjectEntryKind),
  imageOnly: Schema.optional(Schema.Boolean),
};

export const ProjectSearchEntriesCwdInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  ...ProjectSearchEntriesFields,
});
export type ProjectSearchEntriesCwdInput = typeof ProjectSearchEntriesCwdInput.Type;

/** Searches every available folder of the scope; `limit` caps the merged total. */
export const ProjectSearchEntriesScopedInput = Schema.Struct({
  scope: WorkspaceScope,
  ...ProjectSearchEntriesFields,
});
export type ProjectSearchEntriesScopedInput = typeof ProjectSearchEntriesScopedInput.Type;

export const ProjectSearchEntriesInput = Schema.Union([
  ProjectSearchEntriesCwdInput,
  ProjectSearchEntriesScopedInput,
]);
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  ignored: Schema.optional(Schema.Boolean),
});
export type ProjectEntry = typeof ProjectEntry.Type;

/** A scoped result's paths are canonical, and it carries the scope's folder table. */
const ScopedResultFields = {
  folders: Schema.optional(Schema.Array(WorkspaceScopeFolder)),
};

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
  ...ScopedResultFields,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

const ProjectSearchContentsFields = {
  // Whitespace is significant in content queries (" foo", regex trailing
  // spaces), so the query is deliberately not trimmed on the wire.
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_CONTENTS_MAX_LIMIT)),
  caseSensitive: Schema.Boolean,
  wholeWord: Schema.Boolean,
  useRegex: Schema.Boolean,
};

export const ProjectSearchContentsCwdInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  ...ProjectSearchContentsFields,
});
export type ProjectSearchContentsCwdInput = typeof ProjectSearchContentsCwdInput.Type;

/** Searches every available folder of the scope; `limit` and a byte cap bound the merged total. */
export const ProjectSearchContentsScopedInput = Schema.Struct({
  scope: WorkspaceScope,
  ...ProjectSearchContentsFields,
});
export type ProjectSearchContentsScopedInput = typeof ProjectSearchContentsScopedInput.Type;

export const ProjectSearchContentsInput = Schema.Union([
  ProjectSearchContentsCwdInput,
  ProjectSearchContentsScopedInput,
]);
export type ProjectSearchContentsInput = typeof ProjectSearchContentsInput.Type;

export const ProjectContentMatchRange = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type ProjectContentMatchRange = typeof ProjectContentMatchRange.Type;

export const ProjectContentMatch = Schema.Struct({
  path: TrimmedNonEmptyString,
  lineNumber: PositiveInt,
  lineContent: Schema.String,
  matchRanges: Schema.Array(ProjectContentMatchRange),
});
export type ProjectContentMatch = typeof ProjectContentMatch.Type;

export const ProjectSearchContentsResult = Schema.Struct({
  matches: Schema.Array(ProjectContentMatch),
  truncated: Schema.Boolean,
  regexFallbackError: Schema.optional(Schema.String),
  ...ScopedResultFields,
});
export type ProjectSearchContentsResult = typeof ProjectSearchContentsResult.Type;

export const ProjectListEntriesCwdInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // Present for immediate filesystem children, including ignored entries; empty means root.
  // Omitted preserves the indexed recursive listing used by older clients.
  directoryPath: Schema.optional(TrimmedString),
});
export type ProjectListEntriesCwdInput = typeof ProjectListEntriesCwdInput.Type;

/**
 * The immediate children of a canonical directory path. In a scope with
 * several folders, the root (`""`) lists only the folder table, unless the
 * scope's `folderPath` names the folder to list.
 */
export const ProjectListEntriesScopedInput = Schema.Struct({
  scope: WorkspaceScope,
  directoryPath: TrimmedString,
});
export type ProjectListEntriesScopedInput = typeof ProjectListEntriesScopedInput.Type;

export const ProjectListEntriesInput = Schema.Union([
  ProjectListEntriesCwdInput,
  ProjectListEntriesScopedInput,
]);
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
  ...ScopedResultFields,
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

export const ProjectEntriesFailure = Schema.Literals([
  "workspace_root_not_found",
  "workspace_root_create_failed",
  "workspace_root_stat_failed",
  "workspace_root_not_directory",
  "search_index_create_failed",
  "search_index_scan_timed_out",
  "search_index_search_failed",
  "directory_list_failed",
]);
export type ProjectEntriesFailure = typeof ProjectEntriesFailure.Type;

type ProjectEntriesFailureContext = {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
  readonly cause?: unknown;
};

function decodedProjectErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class ProjectSearchEntriesError extends Schema.TaggedError<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // The structured fields are optional on the wire so newer peers can decode legacy message-only
  // failures. New application code must provide them through this constructor.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectSearchContentsError extends Schema.TaggedError<ProjectSearchContentsError>()(
  "ProjectSearchContentsError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace contents in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectListEntriesError extends Schema.TaggedError<ProjectListEntriesError>()(
  "ProjectListEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectEntriesFailureContext & { readonly cwd: string }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ?? `Failed to list workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectReadFileCwdInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // Workspace-relative, or an absolute host path for a file outside the
  // workspace. Only workspace-relative paths can be written back.
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileCwdInput = typeof ProjectReadFileCwdInput.Type;

/** A file by canonical path. Absolute host paths stay on the `cwd` form. */
export const ProjectReadFileScopedInput = Schema.Struct({
  scope: WorkspaceScope,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileScopedInput = typeof ProjectReadFileScopedInput.Type;

export const ProjectReadFileInput = Schema.Union([
  ProjectReadFileCwdInput,
  ProjectReadFileScopedInput,
]);
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  /** For a scoped read, the canonical path. */
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectFileFailure = Schema.Literals([
  "workspace_path_outside_root",
  "resolved_path_outside_root",
  "path_not_file",
  "binary_file",
  "operation_failed",
]);
export type ProjectFileFailure = typeof ProjectFileFailure.Type;

export const ProjectFileOperation = Schema.Literals([
  "realpath-workspace-root",
  "realpath-target",
  "open",
  "stat",
  "read",
  "close",
  "make-directory",
  "write-file",
]);
export type ProjectFileOperation = typeof ProjectFileOperation.Type;

type ProjectFileFailureContext = {
  readonly cwd: string;
  readonly relativePath: string;
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
  readonly cause?: unknown;
};

export class ProjectReadFileError extends Schema.TaggedError<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to read workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectWriteFileCwdInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileCwdInput = typeof ProjectWriteFileCwdInput.Type;

/** Writes a file by canonical path, inside its folder. */
export const ProjectWriteFileScopedInput = Schema.Struct({
  scope: WorkspaceScope,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileScopedInput = typeof ProjectWriteFileScopedInput.Type;

export const ProjectWriteFileInput = Schema.Union([
  ProjectWriteFileCwdInput,
  ProjectWriteFileScopedInput,
]);
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  /** For a scoped write, the canonical path. */
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

/** The environment's Scratch project, created on first request. */
export const ProjectEnsureScratchResult = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectEnsureScratchResult = typeof ProjectEnsureScratchResult.Type;

/** A project started from just a name, in a new folder the server makes. */
export const ProjectCreateNewInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type ProjectCreateNewInput = typeof ProjectCreateNewInput.Type;

export const ProjectCreateNewResult = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  /** Why the first commit failed. The project and its files exist either way. */
  commitError: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProjectCreateNewResult = typeof ProjectCreateNewResult.Type;

export class ProjectWriteFileError extends Schema.TaggedError<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to write workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}
