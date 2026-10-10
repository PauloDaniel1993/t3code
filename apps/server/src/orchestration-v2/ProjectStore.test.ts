import { assert, it } from "@effect/vitest";
import {
  type ApplicationProjectCreatedPayload,
  type ApplicationProjectEvent,
  type ApplicationProjectMetaUpdatedPayload,
  EventId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

const now = "2026-03-24T00:00:00.000Z";
const eventBase = (projectId: ProjectId, eventId: string) => ({
  eventId: EventId.make(eventId),
  aggregateKind: "project" as const,
  aggregateId: projectId,
  occurredAt: now,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});
const created = (
  projectId: ProjectId,
  payload: Partial<ApplicationProjectCreatedPayload> = {},
) => ({
  ...eventBase(projectId, `${projectId}:created`),
  type: "project.created" as const,
  payload: {
    projectId,
    title: "Project",
    workspaceRoot: `/tmp/${projectId}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
    ...payload,
  },
});
const metaUpdated = (
  projectId: ProjectId,
  eventId: string,
  payload: Omit<ApplicationProjectMetaUpdatedPayload, "projectId" | "updatedAt">,
) => ({
  ...eventBase(projectId, eventId),
  type: "project.meta-updated" as const,
  payload: { projectId, updatedAt: now, ...payload },
});

it.layer(
  Layer.mergeAll(ProjectStore.layer, OrchestrationEventStoreLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
)("ProjectStoreV2", (it) => {
  it.effect("stores a model selection without options as JSON without an options key", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-null-options");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
      yield* projects.apply({
        sequence: 1,
        ...created(projectId, { defaultModelSelection: modelSelection }),
      });

      const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
      assert.deepStrictEqual(
        Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
        modelSelection,
      );
    }),
  );

  it.effect("finds plain projects by root, and linked ones by workspace file", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const linked = ProjectId.make("project-lookup-linked");
      const plain = ProjectId.make("project-lookup-plain");
      const root = "C:\\Lookup\\app";
      yield* projects.apply({
        sequence: 1,
        ...created(linked, {
          workspaceRoot: root,
          workspaceFile: "C:\\Lookup\\Team.code-workspace",
          folders: [{ path: root, name: "app" }],
        }),
      });

      // A linked project never owns its root, unless a caller asks for it by cwd.
      assert.isTrue(Option.isNone(yield* projects.findActiveByWorkspaceRoot(root)));
      const byCwd = () => projects.findActiveByWorkspaceRoot(root, { includeLinked: true });
      assert.equal(Option.getOrThrow(yield* byCwd()).projectId, linked);
      yield* projects.apply({ sequence: 2, ...created(plain, { workspaceRoot: root }) });
      assert.equal(Option.getOrThrow(yield* byCwd()).projectId, plain);

      // One Windows file in any case is one workspace file.
      const byFile = (file: string) => projects.findActiveByWorkspaceFile(file);
      assert.equal(
        Option.getOrThrow(yield* byFile("c:\\lookup\\team.code-workspace")).projectId,
        linked,
      );
      assert.isTrue(Option.isNone(yield* byFile("C:\\Lookup\\Other.code-workspace")));
    }),
  );

  it.effect("keeps workspace-file fields off plain project shells", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const projectId = ProjectId.make("project-plain");
      yield* projects.apply({ sequence: 1, ...created(projectId) });

      const row = Option.getOrThrow(yield* projects.get(projectId));
      assert.isNull(row.workspaceFile);
      assert.isNull(row.folders);
      const shell = Option.getOrThrow(yield* projects.getShell(projectId));
      for (const field of ["workspaceFile", "folders", "workspaceFileStatus"]) {
        assert.isFalse(Object.hasOwn(shell, field), field);
      }
    }),
  );

  it.effect("serves a linked project's folders with labels, and unlinking survives replay", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-linked");
      const folders = [
        { path: "C:\\work\\app", name: "app" },
        { uri: "vscode-remote://ssh-remote+devbox/srv/app", name: "app" },
        { path: "C:\\work\\docs", name: "Docs" },
      ];
      const commit = (event: OrchestrationEventStore.UnsequencedProjectEvent) =>
        events.appendProjectEvent(event).pipe(Effect.tap(projects.apply));

      const first = yield* commit(
        created(projectId, {
          workspaceRoot: "C:\\work\\app",
          workspaceFile: "C:\\work\\app.code-workspace",
          folders,
        }),
      );
      assert.deepEqual(Option.getOrThrow(yield* projects.getShell(projectId)).folders, [
        { path: "C:\\work\\app", name: "app", label: "app" },
        { uri: "vscode-remote://ssh-remote+devbox/srv/app", name: "app", label: "app-2" },
        { path: "C:\\work\\docs", name: "Docs", label: "Docs" },
      ]);
      assert.equal(
        Option.getOrThrow(yield* projects.getShell(projectId)).workspaceFile,
        "C:\\work\\app.code-workspace",
      );

      // A metadata-only update leaves the link alone.
      yield* commit(metaUpdated(projectId, "project-linked:renamed", { title: "Renamed" }));
      const renamed = Option.getOrThrow(yield* projects.get(projectId));
      assert.equal(renamed.workspaceFile, "C:\\work\\app.code-workspace");
      assert.deepEqual(renamed.folders, folders);

      const last = yield* commit(
        metaUpdated(projectId, "project-linked:unlinked", { workspaceFile: null, folders: null }),
      );
      const unlinked = Option.getOrThrow(yield* projects.get(projectId));
      assert.isNull(unlinked.workspaceFile);
      assert.isNull(unlinked.folders);
      assert.equal(unlinked.workspaceRoot, "C:\\work\\app");
      const plainShell = Option.getOrThrow(yield* projects.getShell(projectId));
      assert.isFalse(Object.hasOwn(plainShell, "folders"));

      // Rebuild the row from the stored events: the unlink's nulls must not
      // decode as "unchanged", which would bring the folders back.
      const replayed = Array.from(
        yield* events
          .readApplicationEvents({
            afterSequence: first.sequence - 1,
            throughSequence: last.sequence,
          })
          .pipe(Stream.runCollect),
      ).filter(
        (event): event is ApplicationProjectEvent =>
          "aggregateKind" in event && event.aggregateId === projectId,
      );
      assert.deepInclude(replayed.at(-1)?.payload, { workspaceFile: null, folders: null });
      yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
      yield* Effect.forEach(replayed, projects.apply);
      assert.deepEqual(Option.getOrThrow(yield* projects.get(projectId)), unlinked);
    }),
  );
});
