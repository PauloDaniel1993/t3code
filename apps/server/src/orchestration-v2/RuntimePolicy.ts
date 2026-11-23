import {
  isRuntimeModeAbove,
  managedRuntimeModeCeilingMessage,
  ModelSelection,
  OrchestrationV2AppThread,
  PROVIDER_WORKSPACE_FOLDER_ACCESS_MESSAGE,
  ProjectId,
  ProviderInstanceId,
  type ProviderWorkspaceFolderAccess,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  resolveThreadWorkspace,
  threadPrimaryPath,
  workspaceAdditionalDirectories,
} from "@t3tools/shared/workspaceFolders";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";
import * as ProjectStore from "./ProjectStore.ts";

export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

/** The run spans workspace folders its provider can't reach. */
export class ProviderWorkspaceFolderAccessError extends Schema.TaggedError<ProviderWorkspaceFolderAccessError>()(
  "ProviderWorkspaceFolderAccessError",
  {
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return PROVIDER_WORKSPACE_FOLDER_ACCESS_MESSAGE;
  }
}

/**
 * The thread's snapshot folders, beyond its primary, that aren't directories
 * now. A run records this once, as it is admitted; callers outside a run probe
 * with this before resolving a policy.
 */
export const probeUnavailableFolderPaths = Effect.fn("RuntimePolicy.probeUnavailableFolderPaths")(
  function* (thread: Pick<OrchestrationV2AppThread, "workspaceFolders">) {
    const fileSystem = yield* FileSystem.FileSystem;
    const [, ...others] = thread.workspaceFolders ?? [];
    return yield* Effect.filter(
      others.flatMap((folder) => (folder.path === undefined ? [] : [folder.path])),
      (path) =>
        fileSystem.stat(path).pipe(
          Effect.map((info) => info.type !== "Directory"),
          Effect.orElseSucceed(() => true),
        ),
      { concurrency: 4 },
    );
  },
);

/**
 * A turn would start in a mode above the policy's ceiling. The orchestrator refuses those when
 * they are dispatched; this catches the ones it never saw, such as a run resumed after a restart
 * on a thread whose mode predates the policy.
 */
export class RuntimePolicyAboveCeilingError extends Schema.TaggedError<RuntimePolicyAboveCeilingError>()(
  "RuntimePolicyAboveCeilingError",
  {
    threadId: ThreadId,
    runtimeMode: RuntimeMode,
    maxRuntimeMode: RuntimeMode,
    organization: Schema.String,
  },
) {
  override get message(): string {
    return `${managedRuntimeModeCeilingMessage(this.organization, this.maxRuntimeMode)} Switch this thread's mode to continue.`;
  }
}

export const isRuntimePolicyAboveCeilingError = Schema.is(RuntimePolicyAboveCeilingError);

export const RuntimePolicyV2Error = Schema.Union([
  RuntimePolicyResolveError,
  RuntimePolicyAboveCeilingError,
]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

type WorkspaceScope = Pick<
  ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  "cwd" | "additionalDirectories" | "workspace"
>;

export interface RuntimePolicyV2Shape {
  /**
   * Resolves the provider's cwd and workspace scope for a run.
   * `unavailableFolderPaths` is the run's record of snapshot folders it can't
   * reach; a run and its provider read the same record.
   */
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
    readonly unavailableFolderPaths?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
  readonly resolveWorkspace: (input: {
    readonly thread: Pick<
      OrchestrationV2AppThread,
      "projectId" | "worktreePath" | "workspaceFolders" | "worktrees"
    >;
    readonly providerInstanceId: ProviderInstanceId;
    readonly unavailableFolderPaths?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<WorkspaceScope | undefined, RuntimePolicyResolveError>;
  /**
   * A scope with directory grants beyond cwd requires a provider instance that
   * advertises workspace-folder access.
   */
  readonly requireWorkspaceFolderAccess: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly scope: Pick<
      ProviderAdapter.ProviderAdapterV2RuntimePolicy,
      "additionalDirectories" | "workspace"
    >;
  }) => Effect.Effect<void, ProviderWorkspaceFolderAccessError>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

function requireAccess(
  input: Parameters<RuntimePolicyV2Shape["requireWorkspaceFolderAccess"]>[0],
  access: ProviderWorkspaceFolderAccess | undefined,
): Effect.Effect<void, ProviderWorkspaceFolderAccessError> {
  return access === "supported" ||
    ProviderAdapter.runtimeWorkspaceExtraRoots(input.scope).length === 0
    ? Effect.void
    : Effect.fail(
        new ProviderWorkspaceFolderAccessError({
          threadId: input.threadId,
          providerInstanceId: input.providerInstanceId,
        }),
      );
}

/**
 * The mode a provider runs a thread in. A mode the provider does not offer
 * (a thread set before it stopped offering it, or a stale client) runs in
 * Supervised rather than having T3 imitate it.
 */
export function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

const refuseAboveCeiling = (
  managedPolicy: ServerSettings.ServerSettingsService["Service"]["managedPolicy"],
  thread: OrchestrationV2AppThread,
) => {
  const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
  return managedPolicy !== undefined &&
    maxRuntimeMode !== undefined &&
    isRuntimeModeAbove(thread.runtimeMode, maxRuntimeMode)
    ? Effect.fail(
        new RuntimePolicyAboveCeilingError({
          threadId: thread.id,
          runtimeMode: thread.runtimeMode,
          maxRuntimeMode,
          organization: managedPolicy.organization,
        }),
      )
    : Effect.void;
};

/** Lays the policy's ceiling over another runtime policy, as `layerFromProjectStore` does. */
export const layerEnforcingCeiling: Layer.Layer<
  RuntimePolicyV2,
  never,
  RuntimePolicyV2 | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    return RuntimePolicyV2.of({
      requireWorkspaceFolderAccess: base.requireWorkspaceFolderAccess,
      resolveWorkspace: base.resolveWorkspace,
      resolve: Effect.fn("RuntimePolicyV2.resolveWithinCeiling")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        return yield* base.resolve(input);
      }),
    });
  }),
);

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  | ProjectStore.ProjectStoreV2
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ServerSettings.ServerSettingsService
  | WorkspaceFolders.WorkspaceFolders
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    // The same ceiling the orchestrator enforces, fixed for the server's life.
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
    const resolveWorkspace: RuntimePolicyV2Shape["resolveWorkspace"] = Effect.fn(
      "RuntimePolicyV2.resolveWorkspace",
    )(function* (input) {
      const project = yield* projects.get(input.thread.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(
          (cause) =>
            new RuntimePolicyResolveError({
              projectId: input.thread.projectId,
              providerInstanceId: input.providerInstanceId,
              cause,
            }),
        ),
      );
      const primaryPath = threadPrimaryPath(input.thread, project);
      if (primaryPath === null) return undefined;
      if (input.thread.workspaceFolders !== undefined || project?.workspaceFile != null) {
        const workspace = resolveThreadWorkspace({
          thread: input.thread,
          project: project ?? { workspaceRoot: primaryPath },
          unavailableFolderPaths: input.unavailableFolderPaths,
        });
        return {
          cwd: workspace.primaryPath,
          additionalDirectories: workspaceAdditionalDirectories(workspace),
        };
      }
      const workspace = yield* workspaceFolders
        .forThread({
          projectId: input.thread.projectId,
          worktreePath: input.thread.worktreePath,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not resolve the thread's tracked folders.", cause).pipe(
              Effect.as(undefined),
            ),
          ),
        );
      return {
        cwd: primaryPath,
        additionalDirectories: [],
        ...(workspace === undefined || workspace.folders.length === 0 ? {} : { workspace }),
      };
    });
    return RuntimePolicyV2.of({
      resolveWorkspace,
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        const scope = yield* resolveWorkspace({
          thread: input.thread,
          providerInstanceId: input.modelSelection.instanceId,
          unavailableFolderPaths: input.unavailableFolderPaths,
        });
        if (scope === undefined) {
          return yield* new RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause: "Project not found.",
          });
        }
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...scope,
          runtimeMode: providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          ...(maxRuntimeMode === undefined ? {} : { maxRuntimeMode }),
        });
      }),
      requireWorkspaceFolderAccess: Effect.fn("RuntimePolicyV2.requireWorkspaceFolderAccess")(
        function* (input) {
          if (ProviderAdapter.runtimeWorkspaceExtraRoots(input.scope).length === 0) return;
          const instance = yield* providerInstances.getInstance(input.providerInstanceId);
          // An instance that is gone, or doesn't say, is unverified.
          const access =
            instance === undefined
              ? undefined
              : (yield* instance.snapshot.getSnapshot).workspaceFolderAccess;
          return yield* requireAccess(input, access);
        },
      ),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        requireWorkspaceFolderAccess: base.requireWorkspaceFolderAccess,
        resolveWorkspace: (input) =>
          base
            .resolveWorkspace(input)
            .pipe(
              Effect.map((scope) =>
                scope === undefined || override.cwd === undefined
                  ? scope
                  : { ...scope, cwd: override.cwd },
              ),
            ),
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
