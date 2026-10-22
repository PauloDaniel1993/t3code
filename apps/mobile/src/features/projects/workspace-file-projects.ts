import {
  resolveAddProjectKind,
  resolveAddProjectPath,
} from "@t3tools/client-runtime/operations/projects";
import { filterFilesystemBrowseEntries } from "@t3tools/client-runtime/state/filesystem";
import {
  getBrowseLeafPathSegment,
  hasTrailingPathSeparator,
  isWindowsPlatform,
} from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  ProjectMutationError,
  type FilesystemBrowseResult,
  type Project,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isProjectMutationError = Schema.is(ProjectMutationError);

/** Uses a fresh server listing before a typed path can reach directory creation. */
export function resolveMobileAddProjectTarget(input: {
  readonly path: string;
  readonly platform: string;
  readonly workspaceFileProjects: boolean;
  readonly browse: FilesystemBrowseResult | null;
}) {
  const resolved = resolveAddProjectPath({ rawPath: input.path, platform: input.platform });
  if (!resolved.ok) throw new Error(resolved.error);
  const entry = filterFilesystemBrowseEntries(
    input.browse?.entries ?? [],
    getBrowseLeafPathSegment(input.path.trim()),
    !isWindowsPlatform(input.platform),
  ).exactEntry;
  const kind = resolveAddProjectKind(
    resolved.path,
    entry,
    input.browse !== null && hasTrailingPathSeparator(input.path.trim()),
  );
  if (kind === "workspace-file" && !input.workspaceFileProjects) {
    throw new Error("Workspace-file projects are not enabled on this environment.");
  }
  return { kind, path: entry?.fullPath ?? resolved.path };
}

/** Only a duplicate file import opens another project; other conflicts remain errors. */
export function workspaceFileMutationOutcome(
  result: AtomCommandResult<Project, unknown>,
  importing: boolean,
) {
  if (result._tag === "Success") return { project: result.value, projectId: result.value.id };
  if (isAtomCommandInterrupted(result))
    throw new Error("The workspace file operation was interrupted. Try again.");
  const error = squashAtomCommandFailure(result);
  if (
    importing &&
    isProjectMutationError(error) &&
    error.diagnostic?.code === "conflict" &&
    error.conflictingProjectId
  ) {
    return { project: null, projectId: error.conflictingProjectId };
  }
  throw error;
}

export function workspaceFileErrorMessage(error: unknown): string {
  if (isProjectMutationError(error) && error.diagnostic) {
    const diagnostic = error.diagnostic;
    return `${diagnostic.message}${diagnostic.line === undefined ? "" : ` (line ${diagnostic.line}${diagnostic.column === undefined ? "" : `, column ${diagnostic.column}`})`}`;
  }
  return error instanceof Error ? error.message : "Could not use the workspace file.";
}

export async function workspaceFileActionError(
  action: () => Promise<void>,
): Promise<string | null> {
  try {
    await action();
    return null;
  } catch (error) {
    return workspaceFileErrorMessage(error);
  }
}
