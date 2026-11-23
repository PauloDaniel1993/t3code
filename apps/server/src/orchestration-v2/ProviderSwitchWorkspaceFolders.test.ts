import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  PROVIDER_WORKSPACE_FOLDER_ACCESS_MESSAGE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

const unverified = ProviderInstanceId.make("codex");
const supported = ProviderInstanceId.make("codex_multi_root");
const adapterFor = (instanceId: ProviderInstanceId) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("A switch is judged before any provider opens"),
  }) as ProviderAdapterV2["Service"];

// The real policy; the snapshot names the primary, so the project's root is unused.
const runtimePolicyLayer = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.unwrap(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return Layer.mock(WorkspaceFolders.WorkspaceFolders)({
            forThread: ({ worktreePath }) =>
              Effect.gen(function* () {
                if (worktreePath === null) return { folders: [], extraRoots: [] };
                const lib = worktreePath + "-lib";
                if (!(yield* fs.exists(lib).pipe(Effect.orElseSucceed(() => false)))) {
                  return { folders: [], extraRoots: [] };
                }
                return {
                  folders: [{ name: "lib", path: lib, isGitRepository: true }],
                  extraRoots: [lib],
                };
              }),
          });
        }),
      ).pipe(Layer.provide(NodeServices.layer)),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeedSome({
            workspaceRoot: "/unused",
            folders: null,
          } as ProjectStore.ProjectRow),
      }),
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) =>
          Effect.succeed({
            snapshot: {
              getSnapshot: Effect.succeed({
                workspaceFolderAccess: instanceId === supported ? "supported" : "unverified",
              } as ServerProvider),
            },
          } as ProviderInstance),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
  ),
);
const database = SqlitePersistence.layerMemory;
const testLayer = Layer.mergeAll(
  database,
  NodeServices.layer,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  layerWithRegistry(
    { name: "provider-switch-workspace-folders" },
    ProviderAdapterRegistry.layerFromAdapters([adapterFor(unverified), adapterFor(supported)]),
    { databaseLayer: database, runEffectWorker: false, runtimePolicyLayer },
  ),
);

const selection = (instanceId: ProviderInstanceId): ModelSelection => ({
  instanceId,
  model: "gpt-5.1-codex",
});

it.layer(testLayer)("provider switches on a thread spanning workspace folders", (it) => {
  it.effect.each(["legacy", "tracked"] as const)(
    "moves only to a provider that reaches all $0 folders",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-switch-folders-" });
        const app = path.join(root, "app");
        const lib = kind === "tracked" ? app + "-lib" : path.join(root, "lib");
        yield* fs.makeDirectory(app);
        yield* fs.makeDirectory(lib);
        const threadId = ThreadId.make("thread:switch-folders:" + kind);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:switch-folders:" + kind),
          threadId,
          projectId: ProjectId.make("project:switch-folders"),
          title: "Switch",
          modelSelection: selection(unverified),
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: kind === "tracked" ? app : null,
          ...(kind === "legacy"
            ? {
                workspaceFolders: [
                  { path: app, name: "app", label: "app", checkoutRoot: null },
                  { path: lib, name: "lib", label: "lib", checkoutRoot: null },
                ],
              }
            : {}),
          createdBy: "user",
          creationSource: "web",
        });
        const switchTo = (name: string, instanceId: ProviderInstanceId) =>
          orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make(`switch:${kind}:${name}`),
            threadId,
            modelSelection: selection(instanceId),
          });
        const currentInstance = projections
          .getThreadShell(threadId)
          .pipe(Effect.map((shell) => shell?.modelSelection.instanceId));

        yield* switchTo("supported", supported);
        const refused = yield* switchTo("unverified", unverified).pipe(Effect.flip);
        assert.equal(
          userFacingDispatchErrorMessage(refused),
          PROVIDER_WORKSPACE_FOLDER_ACCESS_MESSAGE,
        );
        assert.equal(yield* currentInstance, supported);

        // Once the other folder is gone, the scope is one folder and any provider runs it.
        yield* fs.remove(lib, { recursive: true });
        yield* switchTo("one-folder", unverified);
        assert.equal(yield* currentInstance, unverified);
      }),
  );
});
