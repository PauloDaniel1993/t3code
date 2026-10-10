import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  WorkspacePrimaryFolderUnavailableError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Admission happens before any provider opens"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  NodeServices.layer,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "run-workspace-admission" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

type ThreadCreate = Extract<OrchestrationV2Command, { readonly type: "thread.create" }>;

const createThread = (threadId: ThreadId, binding: Partial<ThreadCreate>) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:run-admission"),
      title: "Run admission",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      ...binding,
    });
  });

const send = (
  threadId: ThreadId,
  name: string,
  dispatchMode: Extract<OrchestrationV2Command, { type: "message.dispatch" }>["dispatchMode"],
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${name}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${name}`),
      text: "Continue",
      attachments: [],
      dispatchMode,
      createdBy: "user",
      creationSource: "web",
    });
  });

const runs = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return (yield* projections.getThreadRecords(threadId, ["runs"])).runs;
  });

/** Real folders, so admission's stat sees what a run would. */
const folders = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-run-admission-" });
  yield* fs.makeDirectory(path.join(root, "app"));
  yield* fs.makeDirectory(path.join(root, "lib"));
  const at = {
    app: path.join(root, "app"),
    lib: path.join(root, "lib"),
    gone: path.join(root, "gone"),
  };
  return {
    at,
    snapshot: [
      { path: at.app, name: "app", label: "app", checkoutRoot: null },
      { path: at.lib, name: "lib", label: "lib", checkoutRoot: null },
      { path: at.gone, name: "gone", label: "gone" },
      { uri: "vscode-remote://ssh-remote+devbox/srv/api", name: "api", label: "api" },
    ],
    remove: (name: string) => fs.remove(path.join(root, name), { recursive: true }),
  };
});

it.layer(testLayer)("run workspace admission", (it) => {
  it.effect("records once per run which snapshot folders it can't reach", () =>
    Effect.gen(function* () {
      const { at, snapshot, remove } = yield* folders;
      const threadId = ThreadId.make("thread:admission-record");
      yield* createThread(threadId, { workspaceFolders: snapshot });

      yield* send(threadId, "first", { type: "start_immediately" });
      const [first] = yield* runs(threadId);
      assert.deepEqual(first?.unavailableFolderPaths, [at.gone]);

      // A folder that goes away is skipped from the next run on; the first keeps its answer.
      yield* remove("lib");
      yield* send(threadId, "second", { type: "queue_after_active" });
      const [kept, second] = yield* runs(threadId);
      assert.deepEqual(kept?.unavailableFolderPaths, [at.gone]);
      assert.deepEqual(second?.unavailableFolderPaths, [at.lib, at.gone]);
    }),
  );

  it.effect("plans each run's checkpoint parts from the folders that run can reach", () =>
    Effect.gen(function* () {
      const { at, snapshot, remove } = yield* folders;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:admission-parts");
      const plannedParts = Effect.map(
        projections.getThreadRecords(threadId, ["checkpointScopes"]),
        ({ checkpointScopes }) =>
          checkpointScopes[0]?.parts?.map((part) => [part.key === "primary", part.cwd, part.vcs]),
      );
      yield* createThread(threadId, { workspaceFolders: snapshot });

      // Outside git, so recorded without being checkpointed; gone and the URI have no part.
      yield* send(threadId, "first", { type: "start_immediately" });
      assert.deepEqual(yield* plannedParts, [
        [true, at.app, null],
        [false, at.lib, null],
      ]);

      yield* remove("lib");
      yield* send(threadId, "second", { type: "queue_after_active" });
      assert.deepEqual(yield* plannedParts, [[true, at.app, null]]);
    }),
  );

  it.effect("records it when a prepared launch run is released", () =>
    Effect.gen(function* () {
      const { at, snapshot } = yield* folders;
      const threadId = ThreadId.make("thread:admission-release");
      yield* createThread(threadId, { workspaceFolders: snapshot });
      yield* send(threadId, "prepared", { type: "defer_start" });
      const [prepared] = yield* runs(threadId);
      assert.isUndefined(prepared?.unavailableFolderPaths);

      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "prepared-run.release",
        commandId: CommandId.make("release:admission"),
        threadId,
        runId: RunId.make(prepared!.id),
      });
      const [released] = yield* runs(threadId);
      assert.equal(released?.status, "starting");
      assert.deepEqual(released?.unavailableFolderPaths, [at.gone]);
    }),
  );

  it.effect("blocks a run while a root-mode thread's primary folder is gone", () =>
    Effect.gen(function* () {
      const { at, snapshot, remove } = yield* folders;
      const threadId = ThreadId.make("thread:admission-primary");
      yield* createThread(threadId, { workspaceFolders: snapshot });
      yield* remove("app");

      const failure = yield* send(threadId, "blocked", { type: "start_immediately" }).pipe(
        Effect.flip,
      );
      assert.equal(failure._tag, "OrchestratorDispatchError");
      assert.instanceOf(
        "cause" in failure ? failure.cause : undefined,
        WorkspacePrimaryFolderUnavailableError,
      );
      assert.deepEqual(yield* runs(threadId), []);
    }),
  );

  it.effect("leaves threads without a snapshot as they were", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:admission-plain");
      yield* createThread(threadId, {});
      yield* send(threadId, "plain", { type: "start_immediately" });
      const [run] = yield* runs(threadId);
      assert.notProperty(run, "unavailableFolderPaths");
    }),
  );

  it.effect("names a root-mode snapshot thread's primary on its shell", () =>
    Effect.gen(function* () {
      const { at, snapshot } = yield* folders;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const rootId = ThreadId.make("thread:admission-shell-root");
      const worktreeId = ThreadId.make("thread:admission-shell-worktree");
      yield* createThread(rootId, { workspaceFolders: snapshot });
      yield* createThread(worktreeId, {
        workspaceFolders: snapshot.slice(0, 1),
        worktreePath: "/wt/app",
      });

      assert.equal((yield* projections.getThreadShell(rootId))?.workspacePrimaryPath, at.app);
      const listed = (yield* projections.getShellSnapshot()).threads;
      assert.equal(listed.find((thread) => thread.id === rootId)?.workspacePrimaryPath, at.app);
      // A worktree thread's primary is its worktree path, already on the shell.
      assert.notProperty(
        listed.find((thread) => thread.id === worktreeId),
        "workspacePrimaryPath",
      );
    }),
  );
});
