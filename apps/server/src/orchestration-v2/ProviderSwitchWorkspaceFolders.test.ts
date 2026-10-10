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
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
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
  }) as ProviderAdapterV2Shape;

// The real policy; the snapshot names the primary, so the project's root is unused.
const runtimePolicyLayer = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeed(
            Option.some({ workspaceRoot: "/unused", folders: null } as ProjectStore.ProjectRow),
          ),
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
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  NodeServices.layer,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "provider-switch-workspace-folders" },
    ProviderAdapterRegistry.makeLayer([adapterFor(unverified), adapterFor(supported)]),
    { databaseLayer: database, runEffectWorker: false, runtimePolicyLayer },
  ),
);

const selection = (instanceId: ProviderInstanceId): ModelSelection => ({
  instanceId,
  model: "gpt-5.1-codex",
});

it.layer(testLayer)("provider switches on a thread spanning workspace folders", (it) => {
  it.effect("move only to a provider that reaches every folder it can reach now", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-switch-folders-" });
      const app = path.join(root, "app");
      const lib = path.join(root, "lib");
      yield* fs.makeDirectory(app);
      yield* fs.makeDirectory(lib);
      const threadId = ThreadId.make("thread:switch-folders");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:switch-folders"),
        threadId,
        projectId: ProjectId.make("project:switch-folders"),
        title: "Switch",
        modelSelection: selection(supported),
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        workspaceFolders: [
          { path: app, name: "app", label: "app", checkoutRoot: null },
          { path: lib, name: "lib", label: "lib", checkoutRoot: null },
        ],
        createdBy: "user",
        creationSource: "web",
      });
      const switchTo = (name: string, instanceId: ProviderInstanceId) =>
        orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`switch:${name}`),
          threadId,
          modelSelection: selection(instanceId),
        });
      const currentInstance = projections
        .getThreadShell(threadId)
        .pipe(Effect.map((shell) => shell?.modelSelection.instanceId));

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
