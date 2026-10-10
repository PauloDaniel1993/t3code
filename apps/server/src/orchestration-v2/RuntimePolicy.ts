import {
  ModelSelection,
  OrchestrationV2AppThread,
  PROVIDER_WORKSPACE_FOLDER_ACCESS_MESSAGE,
  ProjectId,
  ProviderInstanceId,
  type ProviderWorkspaceFolderAccess,
  type RuntimeMode,
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

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2RuntimePolicy as ProviderAdapterV2RuntimePolicyType,
} from "./ProviderAdapter.ts";
import * as ProjectStore from "./ProjectStore.ts";

/**
 * ERRORS
 */
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
 * Whether a provider with this workspace-folder access may run a scope. Only a
 * "supported" provider gets additional directories. A scope whose other
 * folders are all unavailable, or all inside cwd, has none, so any provider
 * runs it.
 */
export function providerMayRunScope(
  scope: Pick<ProviderAdapterV2RuntimePolicyType, "additionalDirectories">,
  access: ProviderWorkspaceFolderAccess | undefined,
): boolean {
  return scope.additionalDirectories.length === 0 || access === "supported";
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

export const RuntimePolicyV2Error = Schema.Union([RuntimePolicyResolveError]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

/**
 * SERVICE DEFINITION
 */
export interface RuntimePolicyV2Shape {
  /**
   * The policy a run of this thread hands its provider: the thread's primary
   * folder as cwd, and its other available folders as additional directories.
   * `unavailableFolderPaths` is the run's record of snapshot folders it can't
   * reach; a run and its provider read the same record.
   */
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
    readonly unavailableFolderPaths?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<ProviderAdapterV2RuntimePolicyType, RuntimePolicyV2Error>;
  /**
   * The one eligibility rule, for turn start, provider and model switches and
   * launches: a scope with additional directories needs a provider instance
   * whose workspace-folder access is "supported".
   */
  readonly requireWorkspaceFolderAccess: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly scope: Pick<ProviderAdapterV2RuntimePolicyType, "additionalDirectories">;
  }) => Effect.Effect<void, ProviderWorkspaceFolderAccessError>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

/**
 * IMPLEMENTATIONS
 */
export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: (input) =>
    Effect.succeed(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: input.thread.runtimeMode,
        interactionMode: input.thread.interactionMode,
        cwd: input.thread.worktreePath,
      }),
    ),
  requireWorkspaceFolderAccess: (input) => requireAccess(input, undefined),
});

function requireAccess(
  input: Parameters<RuntimePolicyV2Shape["requireWorkspaceFolderAccess"]>[0],
  access: ProviderWorkspaceFolderAccess | undefined,
): Effect.Effect<void, ProviderWorkspaceFolderAccessError> {
  return providerMayRunScope(input.scope, access)
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
function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  ProjectStore.ProjectStoreV2 | ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        // Every thread resolves through the one workspace helper with its
        // project, worktree threads included. Only a thread that names no
        // folder of its own needs the project to exist.
        const project = yield* projects.get(input.thread.projectId).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new RuntimePolicyResolveError({
                projectId: input.thread.projectId,
                providerInstanceId: input.modelSelection.instanceId,
                cause,
              }),
          ),
        );
        const primaryPath = threadPrimaryPath(input.thread, project);
        if (primaryPath === null) {
          return yield* new RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause: "Project not found.",
          });
        }
        const workspace = resolveThreadWorkspace({
          thread: input.thread,
          project: project ?? { workspaceRoot: primaryPath },
          unavailableFolderPaths: input.unavailableFolderPaths,
        });
        return ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          cwd: workspace.primaryPath,
          additionalDirectories: workspaceAdditionalDirectories(workspace),
        });
      }),
      requireWorkspaceFolderAccess: Effect.fn("RuntimePolicyV2.requireWorkspaceFolderAccess")(
        function* (input) {
          if (input.scope.additionalDirectories.length === 0) return;
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
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapterV2RuntimePolicy.make({
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
