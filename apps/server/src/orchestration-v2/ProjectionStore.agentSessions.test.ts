import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const sqlLayer = ProjectionStore.layer.pipe(Layer.provide(SqlitePersistenceMemory));

it.effect.each([
  { name: "SQL", layer: sqlLayer },
  { name: "memory", layer: ProjectionStore.layerMemory },
])(
  "$name: discovers frozen worktrees across archive states and preserves native ownership",
  ({ layer }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("workspace");
      const instanceId = ProviderInstanceId.make("codex");
      const workspaceFolders = [
        { path: "/repo", name: "Repo", label: "repo", checkoutRoot: "/repo" },
      ];
      const worktrees = [{ repositoryRoot: "/repo", path: "/worktrees/repo", branch: "topic" }];
      for (const state of ["active", "archived", "deleted", "plain", "root", "other-project"]) {
        const threadId = ThreadId.make(state);
        yield* store.apply({
          id: EventId.make(`created:${state}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: state === "other-project" ? ProjectId.make("other") : projectId,
            title: state,
            providerInstanceId: instanceId,
            modelSelection: { instanceId, model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "topic",
            worktreePath: state === "root" ? null : "/worktrees/repo",
            ...(state === "plain" ? {} : { workspaceFolders, worktrees }),
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: state === "archived" ? now : null,
            deletedAt: state === "deleted" ? now : null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
          },
        });
      }
      const bindings = yield* store.getWorkspaceWorktreeBindings(projectId);
      expect(bindings.map((binding) => binding.id)).toEqual(["active", "archived"]);
      expect(bindings[0]).toEqual({
        id: ThreadId.make("active"),
        projectId,
        branch: "topic",
        worktreePath: "/worktrees/repo",
        workspaceFolders,
        worktrees,
      });
      expect((yield* store.getWorkspaceWorktreeBindings()).map((binding) => binding.id)).toEqual([
        "active",
        "archived",
        "other-project",
      ]);

      const providerThreadId = ProviderThreadId.make("native-session");
      expect(yield* store.getProviderThreadOwner(providerThreadId)).toBeUndefined();
      const threadId = ThreadId.make("active");
      const driver = ProviderDriverKind.make("codex");
      yield* store.apply({
        id: EventId.make("provider-owned"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        driver,
        providerInstanceId: instanceId,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId: instanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: { driver, nativeId: "session", strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          pendingBackgroundTasks: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      expect(yield* store.getProviderThreadOwner(providerThreadId)).toEqual(threadId);
    }).pipe(Effect.provide(layer)),
);
