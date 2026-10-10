import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
  openSession: () => Effect.die("No provider process needed for workspace bindings"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "thread-workspace-binding" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const workspaceFolders = [
  { path: "/repo/web", name: "web", label: "web", checkoutRoot: "/repo" },
  { path: "/lib", name: "lib", label: "lib", checkoutRoot: "/lib" },
  { path: "/notes", name: "notes", label: "notes", checkoutRoot: null },
];
const worktrees = [
  { repositoryRoot: "/repo", path: "/wt/feature/repo", branch: "t3code/feature" },
  { repositoryRoot: "/lib", path: "/wt/feature/lib", branch: "t3code/feature" },
];

type ThreadCreate = Extract<OrchestrationV2Command, { readonly type: "thread.create" }>;
type MetadataUpdate = Extract<OrchestrationV2Command, { readonly type: "thread.metadata.update" }>;
type MetadataFields = Omit<MetadataUpdate, "type" | "commandId" | "threadId">;

const createThread = (
  threadId: ThreadId,
  binding: Partial<
    Pick<ThreadCreate, "branch" | "worktreePath" | "workspaceFolders" | "worktrees">
  > = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:workspace-binding"),
      title: "Workspace binding",
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

const attachSession = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`attach:${threadId}`),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderSessionId.make(`session:${threadId}`),
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/wt/feature/repo/web",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
  });

const sessionCount = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return (yield* projections.getThreadProviderContext(threadId)).providerSessions.length;
  });

it.layer(testLayer)("thread workspace binding", (it) => {
  it.effect("serves a bound thread's folder count and worktree set on its shell", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const boundId = ThreadId.make("thread:binding-shell");
      const plainId = ThreadId.make("thread:binding-plain");
      yield* createThread(boundId, {
        branch: "t3code/feature",
        worktreePath: "/wt/feature/repo/web",
        workspaceFolders,
        worktrees,
      });
      yield* createThread(plainId);

      const detail = (yield* projections.getThreadProjection(boundId)).thread;
      assert.deepEqual(detail.workspaceFolders, workspaceFolders);
      assert.deepEqual(detail.worktrees, worktrees);
      const shell = yield* projections.getThreadShell(boundId);
      assert.equal(shell?.workspaceFolderCount, 3);
      assert.deepEqual(shell?.worktrees, worktrees);
      assert.notProperty(shell, "workspaceFolders");
      const snapshot = yield* projections.getShellSnapshot();
      const listed = snapshot.threads.find((thread) => thread.id === boundId);
      assert.equal(listed?.workspaceFolderCount, 3);
      assert.deepEqual(listed?.worktrees, worktrees);
      const plain = snapshot.threads.find((thread) => thread.id === plainId);
      assert.notProperty(plain, "workspaceFolderCount");
      assert.notProperty(plain, "worktrees");
    }),
  );

  it.effect("keeps a worktree set in step with writers that only send branch and path", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:binding-legacy-writers");
      yield* createThread(threadId, {
        branch: "t3code/feature",
        worktreePath: "/wt/feature/repo/web",
        workspaceFolders,
        worktrees,
      });
      yield* attachSession(threadId);
      const update = (name: string, fields: MetadataFields) =>
        orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${threadId}:${name}`),
          threadId,
          ...fields,
        });
      const thread = () =>
        projections.getThreadProjection(threadId).pipe(Effect.map((value) => value.thread));

      // A branch rename moves no folder, so the session stays.
      yield* update("rename", { branch: "feature/login" });
      assert.deepEqual(
        (yield* thread()).worktrees?.map((member) => member.branch),
        ["feature/login", "t3code/feature"],
      );
      assert.equal(yield* sessionCount(threadId), 1);

      // A detached primary keeps the branch its member is expected on.
      yield* update("detach-head", { branch: null });
      assert.equal((yield* thread()).worktrees?.[0]?.branch, "feature/login");

      // Moving a member that isn't the primary still changes what a provider can reach.
      yield* update("move-member", {
        branch: "feature/login",
        worktrees: [
          { ...worktrees[0]!, branch: "feature/login" },
          { ...worktrees[1]!, path: "/wt/other/lib" },
        ],
      });
      assert.equal((yield* thread()).worktrees?.[1]?.path, "/wt/other/lib");
      assert.equal(yield* sessionCount(threadId), 0);

      // A new worktree path from a writer that knows nothing of sets drops the set.
      yield* update("pick-worktree", { branch: "main", worktreePath: "/wt/picked" });
      const picked = yield* thread();
      assert.equal(picked.worktreePath, "/wt/picked");
      assert.notProperty(picked, "worktrees");
      assert.deepEqual(picked.workspaceFolders, workspaceFolders);
    }),
  );

  it.effect("freezes the folder snapshot and rejects malformed sets", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:binding-frozen");
      yield* createThread(threadId);
      const update = (name: string, fields: MetadataFields) =>
        orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${threadId}:${name}`),
          threadId,
          ...fields,
        });
      const rejection = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => {
            assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
            return String(error.cause);
          }),
        );

      assert.include(
        yield* rejection(update("set-without-snapshot", { worktrees })),
        "needs its folder snapshot",
      );
      // The first turn binds the snapshot; repeating it is harmless, changing it is not.
      yield* update("bind", { workspaceFolders });
      yield* update("bind-again", { workspaceFolders });
      assert.include(
        yield* rejection(update("rebind", { workspaceFolders: workspaceFolders.slice(1) })),
        "can't change after binding",
      );
      assert.include(
        yield* rejection(
          update("primary-outside-set", {
            branch: "t3code/feature",
            worktreePath: "/wt/feature/lib",
            worktrees,
          }),
        ),
        "inside its primary worktree",
      );
      assert.include(
        yield* rejection(
          createThread(ThreadId.make("thread:binding-remote-primary"), {
            workspaceFolders: [
              { uri: "vscode-remote://ssh-remote+box/srv", name: "srv", label: "srv" },
            ],
          }),
        ),
        "local primary folder",
      );
      const thread = (yield* projections.getThreadProjection(threadId)).thread;
      assert.deepEqual(thread.workspaceFolders, workspaceFolders);
      assert.notProperty(thread, "worktrees");
    }),
  );
});
