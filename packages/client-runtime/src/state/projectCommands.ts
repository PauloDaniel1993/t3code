import {
  type EnvironmentId,
  type ProjectEntry,
  ProjectId,
  type ProjectReadFileResult,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type WorkspaceScope,
  type WorkspaceScopeFolder,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  type EnvironmentRpcInput,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcFailure,
  EnvironmentRpcUnavailableError,
  request,
  requestGuarded,
} from "../rpc/client.ts";
import type { EnvironmentProject, EnvironmentThread } from "./models.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentQueryAtomFamily,
  provideCommandPermissionGuard,
} from "./runtime.ts";
import {
  type CreateProjectInput,
  type ImportWorkspaceFileProjectInput,
  type DeleteProjectInput,
  type UpdateProjectInput,
  createProject,
  importWorkspaceFileProject,
  deleteProject,
  updateProject,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createFileMetadataAtoms } from "./fileMetadata.ts";
import { isAbsolutePath, resolveWorkspaceFilePath } from "@t3tools/shared/path";
import {
  isSamePath,
  parseCanonicalPath,
  projectFolders,
  resolveThreadWorkspace,
  type ResolvedWorkspaceFolder,
} from "@t3tools/shared/workspaceFolders";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { createCommandPermissions } from "./commandPermissions.ts";

export type {
  CreateProjectInput,
  ImportWorkspaceFileProjectInput,
  DeleteProjectInput,
  UpdateProjectInput,
} from "../operations/commands.ts";

export interface OptimisticProjectFile {
  readonly data: ProjectReadFileResult;
  readonly confirmedAgainst: object | null | undefined;
}

export interface OptimisticProjectFileTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

function optimisticProjectFileKey(target: OptimisticProjectFileTarget): string {
  return JSON.stringify([target.environmentId, target.cwd, target.relativePath]);
}

function writtenFilePaths(
  input: EnvironmentRpcInput<typeof WS_METHODS.projectsWriteFile>,
  result: EnvironmentRpcSuccess<typeof WS_METHODS.projectsWriteFile>,
  folders: ReadonlyArray<ResolvedWorkspaceFolder> | null,
) {
  if ("scope" in input) {
    return new Set(
      [result.relativePath, input.path].flatMap((path) => {
        const located = scopedFileLocation(path, folders);
        return located === null
          ? []
          : [resolveWorkspaceFilePath(located.relativePath, located.cwd)];
      }),
    );
  }
  return new Set(
    [result.relativePath, input.relativePath].map((path) =>
      resolveWorkspaceFilePath(path, input.cwd),
    ),
  );
}

/** Canonical labels are navigation identities, never filesystem path bases. */
function scopedFileLocation(path: string, folders: ReadonlyArray<ResolvedWorkspaceFolder> | null) {
  if (folders === null) return null;
  const located = parseCanonicalPath(path, folders);
  const cwd = located?.folder.effectivePath;
  if (located === null || cwd == null || !isAbsolutePath(cwd)) return null;
  // Only the server's cwd form supports absolute file paths.
  if (isAbsolutePath(located.relativePath) || located.relativePath.startsWith("~/")) return null;
  return { ...located, cwd };
}

function workspaceBindingKey(folders: ReadonlyArray<ResolvedWorkspaceFolder> | null) {
  return JSON.stringify(
    folders?.map(({ folder, label, effectivePath }) => [
      folder.path ?? folder.uri,
      label,
      effectivePath,
    ]),
  );
}

type ProjectFileQueryTag =
  | typeof WS_METHODS.projectsSearchEntries
  | typeof WS_METHODS.projectsListEntries
  | typeof WS_METHODS.projectsReadFile;

/** A caller's binding key selects a fresh query without sending client cache identity over RPC. */
function createProjectFileQuery<R, E, TTag extends ProjectFileQueryTag>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    readonly tag: TTag;
    readonly label: string;
    readonly staleTimeMs: number;
    readonly idleTtlMs?: number;
    readonly execute: (
      input: EnvironmentRpcInput<TTag>,
    ) => Effect.Effect<
      EnvironmentRpcSuccess<TTag>,
      EnvironmentRpcFailure<TTag> | EnvironmentRpcUnavailableError,
      EnvironmentSupervisor.EnvironmentSupervisor | EnvironmentRegistry | AtomRegistry.AtomRegistry
    >;
  },
) {
  const query = createEnvironmentQueryAtomFamily(runtime, {
    ...options,
    execute: (input: {
      readonly request: EnvironmentRpcInput<TTag>;
      readonly bindingKey?: string;
    }) => options.execute(input.request),
  });
  return (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<TTag>;
    readonly bindingKey?: string;
  }) =>
    query({
      environmentId: target.environmentId,
      input: {
        request: target.input,
        ...(target.bindingKey === undefined ? {} : { bindingKey: target.bindingKey }),
      },
    });
}

export class ScratchProjectNotLoadedError extends Schema.TaggedError<ScratchProjectNotLoadedError>()(
  "ScratchProjectNotLoadedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "The folder for threads without a project has not reached this device yet. Try again.";
  }
}

export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
  options: {
    readonly projectAtom: (ref: ScopedProjectRef) => Atom.Atom<EnvironmentProject | null>;
    /** Full thread detail, including its frozen folders and worktree set; a shell is insufficient. */
    readonly threadAtom: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThread | null>;
  },
) {
  const fileMetadata = createFileMetadataAtoms(runtime);
  const projectScheduler = createAtomCommandScheduler();
  const fileScheduler = createAtomCommandScheduler();
  const optimisticFileFamily = Atom.family((key: string) =>
    Atom.make<OptimisticProjectFile | null>(null).pipe(
      Atom.withLabel(`environment-data:projects:optimistic-file:${key}`),
    ),
  );
  const projectConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  const scopeFolders = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    scope: WorkspaceScope,
  ) => {
    const project = registry.get(
      options.projectAtom({ environmentId, projectId: scope.projectId }),
    );
    if (
      project === null ||
      project.id !== scope.projectId ||
      project.environmentId !== environmentId
    )
      return null;
    if (scope.threadId === undefined) {
      return projectFolders(project).map((folder, index): ResolvedWorkspaceFolder => ({
        folder,
        label: folder.label,
        effectivePath: folder.path ?? null,
        isPrimary: index === 0,
        checkoutRoot: undefined,
      }));
    }
    const detail = registry.get(options.threadAtom({ environmentId, threadId: scope.threadId }));
    const thread = detail?.projection.thread;
    if (
      detail?.environmentId !== environmentId ||
      thread === undefined ||
      thread.id !== scope.threadId ||
      thread.projectId !== scope.projectId ||
      thread.deletedAt !== null
    ) {
      return null;
    }
    return resolveThreadWorkspace({ thread, project }).folders;
  };
  const captureScope = Effect.fnUntraced(function* (scope: WorkspaceScope) {
    const registry = yield* AtomRegistry.AtomRegistry;
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const environmentId = supervisor.target.environmentId;
    const folders = scopeFolders(registry, environmentId, scope);
    const key = workspaceBindingKey(folders);
    return {
      folders,
      isCurrent: () => workspaceBindingKey(scopeFolders(registry, environmentId, scope)) === key,
    };
  });
  const seedEntries = (
    cwd: string | null,
    folders: ReadonlyArray<ResolvedWorkspaceFolder> | null,
    result: {
      entries: ReadonlyArray<ProjectEntry>;
      folders?: ReadonlyArray<WorkspaceScopeFolder> | undefined;
    },
    isCurrent: Parameters<typeof fileMetadata.rememberEntries>[2],
  ) => {
    if (cwd !== null) return fileMetadata.rememberEntries(cwd, result.entries, isCurrent);
    // The response table confirms original identities even if the project's labels changed.
    return Effect.forEach(result.entries, (entry) => {
      const located = scopedFileLocation(entry.path, folders);
      const row = result.folders?.find((folder) => folder.label === located?.folder.label);
      if (
        located === null ||
        row?.status !== "ok" ||
        located.folder.folder.path === undefined ||
        !isSamePath(row.folderPath, located.folder.folder.path) ||
        result.folders?.length !== folders?.length
      )
        return Effect.void;
      return fileMetadata.rememberEntries(
        located.cwd,
        [{ ...entry, path: located.relativePath }],
        isCurrent,
      );
    }).pipe(Effect.asVoid);
  };
  const writePermissions = createCommandPermissions(runtime, WS_METHODS.projectsWriteFile);
  return {
    fileMetadata: fileMetadata.metadata,
    fileMetadataThread: fileMetadata.retainThread,
    invalidateFileMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:filesystem:invalidate-metadata",
      execute: (input: { paths: ReadonlyArray<string> }, registry, environmentId) =>
        Effect.forEach([...new Set(input.paths)], (path) =>
          fileMetadata
            .invalidate(path)
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => fileMetadata.refreshPath(environmentId, path, registry)),
              ),
            ),
        ),
    }),
    searchEntries: createProjectFileQuery(runtime, {
      tag: WS_METHODS.projectsSearchEntries,
      label: "environment-data:projects:search-entries",
      staleTimeMs: 15_000,
      execute: Effect.fn("ProjectCommands.searchEntries")(function* (
        input: EnvironmentRpcInput<typeof WS_METHODS.projectsSearchEntries>,
      ) {
        const captured = "scope" in input ? yield* captureScope(input.scope) : null;
        return yield* fileMetadata.seedAfterRead(
          request(WS_METHODS.projectsSearchEntries, input),
          (result, isCurrent) =>
            seedEntries(
              "cwd" in input ? input.cwd : null,
              captured?.folders ?? null,
              result,
              (session) => isCurrent(session) && (captured?.isCurrent() ?? true),
            ),
        );
      }),
    }),
    listEntries: createProjectFileQuery(runtime, {
      tag: WS_METHODS.projectsListEntries,
      label: "environment-data:projects:list-entries",
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
      execute: Effect.fn("ProjectCommands.listEntries")(function* (
        input: EnvironmentRpcInput<typeof WS_METHODS.projectsListEntries>,
      ) {
        const captured = "scope" in input ? yield* captureScope(input.scope) : null;
        return yield* fileMetadata.seedAfterRead(
          request(WS_METHODS.projectsListEntries, input),
          (result, isCurrent) =>
            seedEntries(
              "cwd" in input ? input.cwd : null,
              captured?.folders ?? null,
              result,
              (session) => isCurrent(session) && (captured?.isCurrent() ?? true),
            ),
        );
      }),
    }),
    listIgnoredFiles: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-ignored-files",
      tag: WS_METHODS.projectsListIgnoredFiles,
      staleTimeMs: 15_000,
    }),
    readFile: createProjectFileQuery(runtime, {
      tag: WS_METHODS.projectsReadFile,
      label: "environment-data:projects:read-file",
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
      execute: Effect.fn("ProjectCommands.readFile")(function* (
        input: EnvironmentRpcInput<typeof WS_METHODS.projectsReadFile>,
      ) {
        const captured = "scope" in input ? yield* captureScope(input.scope) : null;
        return yield* fileMetadata.seedAfterRead(
          request(WS_METHODS.projectsReadFile, input),
          (result, isCurrent) => {
            if (result.exists === false) return Effect.void;
            if ("cwd" in input) return fileMetadata.rememberFile(input.cwd, result, isCurrent);
            const located = scopedFileLocation(result.relativePath, captured?.folders ?? null);
            return located === null
              ? Effect.void
              : fileMetadata.rememberFile(
                  located.cwd,
                  { ...result, relativePath: located.relativePath },
                  (session) => isCurrent(session) && (captured?.isCurrent() ?? false),
                );
          },
        );
      }),
    }),
    optimisticFile: (target: OptimisticProjectFileTarget) =>
      optimisticFileFamily(optimisticProjectFileKey(target)),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:create",
      execute: (input: CreateProjectInput) => createProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    importWorkspaceFile: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:import-workspace-file",
      execute: (input: ImportWorkspaceFileProjectInput) => importWorkspaceFileProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update",
      execute: (input: UpdateProjectInput) => updateProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:delete",
      execute: (input: DeleteProjectInput) => deleteProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    // Finds or creates the environment's Scratch project and resolves once the
    // project is in the client store, since drafts key off its stored path.
    openScratch: createEnvironmentCommand(runtime, {
      label: "environment-data:projects:open-scratch",
      execute: (
        input: EnvironmentRpcInput<typeof WS_METHODS.projectsEnsureScratch>,
        registry,
        environmentId,
      ) =>
        request(WS_METHODS.projectsEnsureScratch, input).pipe(
          Effect.flatMap(({ projectId }) =>
            AtomRegistry.toStream(registry, options.projectAtom({ environmentId, projectId })).pipe(
              Stream.filter(Predicate.isNotNull),
              Stream.runHead,
              Effect.timeoutOption("10 seconds"),
              Effect.map(Option.flatten),
              Effect.flatMap(
                Option.match({
                  onSome: Effect.succeed,
                  onNone: () => Effect.fail(new ScratchProjectNotLoadedError({ projectId })),
                }),
              ),
            ),
          ),
        ),
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    createNew: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:create-new",
      tag: WS_METHODS.projectsCreateNew,
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    writeFile: {
      ...createEnvironmentCommand(runtime, {
        label: "environment-data:projects:write-file",
        scheduler: fileScheduler,
        concurrency: {
          mode: "serial",
          key: ({
            environmentId,
            input,
          }: {
            readonly environmentId: EnvironmentId;
            readonly input: EnvironmentRpcInput<typeof WS_METHODS.projectsWriteFile>;
          }) =>
            JSON.stringify(
              "scope" in input
                ? [environmentId, input.scope.projectId, input.scope.threadId ?? null, input.path]
                : [environmentId, input.cwd, input.relativePath],
            ),
        },
        execute: Effect.fn("ProjectCommands.writeFile")(
          function* (
            input: EnvironmentRpcInput<typeof WS_METHODS.projectsWriteFile>,
            registry: AtomRegistry.AtomRegistry,
            environmentId: EnvironmentId,
          ) {
            yield* writePermissions.authorize(registry, environmentId, input);
            const before =
              "scope" in input ? scopeFolders(registry, environmentId, input.scope) : null;
            const result = yield* requestGuarded(WS_METHODS.projectsWriteFile, input);
            const after =
              "scope" in input ? scopeFolders(registry, environmentId, input.scope) : null;
            const paths = new Set([
              ...writtenFilePaths(input, result, before),
              ...writtenFilePaths(input, result, after),
            ]);
            yield* Effect.forEach(paths, fileMetadata.invalidate);
            for (const path of paths) fileMetadata.refreshPath(environmentId, path, registry);
            return result;
          },
          (effect, _input, registry) =>
            effect.pipe(provideCommandPermissionGuard(runtime, registry)),
        ),
      }),
      requiredScopes: writePermissions.requiredScopes,
      permissionAtom: writePermissions.permissionAtom,
    },
  };
}
