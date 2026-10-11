import { expect, it } from "@effect/vitest";
import {
  AgentSessionImportProjectChangedError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { ThreadWorkspaceBinding } from "../orchestration-v2/ThreadWorkspaceBinding.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

const workspaceFolders = [
  {
    path: "/workspace/project",
    name: "Primary",
    label: "primary",
    checkoutRoot: "/workspace/project",
  },
  {
    path: "/workspace/secondary",
    name: "Secondary",
    label: "secondary",
    checkoutRoot: "/workspace/secondary",
  },
];
const mappedBinding: ThreadWorkspaceBinding = {
  workspaceFolders,
  branch: "shared",
  worktreePath: "/worktrees/project",
  worktrees: [
    { repositoryRoot: "/workspace/project", path: "/worktrees/project", branch: "shared" },
    { repositoryRoot: "/workspace/secondary", path: "/worktrees/secondary", branch: "shared" },
  ],
};

it.effect.each(["plain", "workspace-file", "worktree"] as const)(
  "%s: imports once and preserves the native resume and workspace bindings",
  (scenario) => {
    const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
    const upserts: Array<unknown> = [];
    const recorded: Array<unknown> = [];
    let imported = false;
    const cwd = scenario === "worktree" ? mappedBinding.worktreePath! : "/workspace/project";
    const scannedRoots: Array<string> = [];
    const scanner = AgentSessionScanner.AgentSessionScanner.of({
      scan: Effect.die("unused"),
      worktreeBinding: () =>
        Effect.succeed(scenario === "worktree" ? Option.some(mappedBinding) : Option.none()),
      recentThreads: (root) => {
        scannedRoots.push(root);
        return Stream.succeed({
          _tag: "Importable",
          source: {
            provider: "codex",
            providerInstanceId,
            providerSessionId,
            filePath: "/tmp/native-codex-thread.jsonl",
            size: 100,
            mtimeMs: 2,
            device: 3,
            inode: 4,
            birthtimeMs: 1,
          },
          thread: {
            source: "codex",
            providerInstanceId,
            providerSessionId,
            title: "Imported thread",
            model: "gpt-5.4",
            createdAt: "2026-09-01T10:00:00.000Z",
            updatedAt: "2026-09-01T10:01:00.000Z",
            messages: [
              { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
              { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
            ],
          },
        });
      },
    });
    const testLayer = AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(
                Option.some({
                  id: projectId,
                  workspaceRoot: "/workspace/project",
                  ...(scenario === "plain"
                    ? {}
                    : { workspaceFile: "/workspace/project.code-workspace" }),
                } as never),
              ),
            snapshotWorkspaceFolders: () => Effect.succeed(workspaceFolders),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () =>
              imported
                ? Effect.succeed({
                    thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                  } as never)
                : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: (input) =>
              Effect.sync(() => {
                writes.push(input.events);
                imported = true;
                return [];
              }),
          }),
          Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
            list: () => Effect.succeed([]),
            upsert: (input) => Effect.sync(() => void upserts.push(input)),
            recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
          }),
          IdAllocator.layer,
        ),
      ),
    );

    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      expect(
        yield* importer.importRecentAgentThreads({ projectId, expectedWorkspaceRoot: cwd }),
      ).toEqual({
        importedCount: 1,
        skippedCount: 0,
      });
      expect(
        yield* importer.importRecentAgentThreads({ projectId, expectedWorkspaceRoot: cwd }),
      ).toEqual({
        importedCount: 1,
        skippedCount: 0,
      });

      expect(writes).toHaveLength(1);
      expect(writes[0]?.map((event) => event.type)).toEqual([
        "thread.created",
        "message.updated",
        "turn-item.updated",
        "message.updated",
        "turn-item.updated",
        "provider-thread.updated",
      ]);
      const created = writes[0]?.find((event) => event.type === "thread.created");
      const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
      expect(created?.payload).toMatchObject({
        id: threadId,
        activeProviderThreadId: providerThread?.payload.id,
        historyOrigin: "v1_import",
        ...(scenario === "worktree" ? mappedBinding : { branch: null, worktreePath: null }),
      });
      if (scenario === "plain") {
        expect(created?.payload).not.toHaveProperty("workspaceFolders");
      } else {
        expect(created?.payload).toMatchObject({ workspaceFolders });
      }
      expect(scannedRoots).toEqual([cwd, cwd]);
      expect(providerThread?.payload).toMatchObject({
        appThreadId: threadId,
        nativeThreadRef: {
          driver: "codex",
          nativeId: providerSessionId,
          strength: "strong",
        },
      });
      expect(
        writes[0]
          ?.filter((event) => event.type === "message.updated")
          .map((event) => event.payload.text),
      ).toEqual(["Fix it", "Fixed"]);
      expect(upserts).toEqual([
        expect.objectContaining({
          threadId,
          providerInstanceId,
          resumeCursor: { threadId: providerSessionId },
          runtimePayload: { cwd },
        }),
      ]);
      expect(recorded).toHaveLength(2);
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect("rejects secondary and stale worktree cwds before importing any history", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    for (const expectedWorkspaceRoot of [
      "/workspace/secondary",
      "/worktrees/secondary",
      "/worktrees/removed",
    ]) {
      expect(
        yield* importer
          .importRecentAgentThreads({ projectId, expectedWorkspaceRoot })
          .pipe(Effect.flip),
      ).toEqual(new AgentSessionImportProjectChangedError({ projectId }));
    }
  }).pipe(
    Effect.provide(
      AgentSessionImporter.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AgentSessionScanner.AgentSessionScanner)({
              worktreeBinding: () => Effect.succeed(Option.none()),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeed(
                  Option.some({
                    id: projectId,
                    workspaceRoot: "/workspace/project",
                    workspaceFile: "/workspace/project.code-workspace",
                  } as never),
                ),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({}),
            Layer.mock(EventSink.EventSinkV2)({}),
            Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({}),
            IdAllocator.layer,
          ),
        ),
      ),
    ),
  ),
);

it.effect("rejects a workspace file that changes primary during import binding", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(
      yield* importer
        .importRecentAgentThreads({ projectId, expectedWorkspaceRoot: "/workspace/project" })
        .pipe(Effect.flip),
    ).toEqual(new AgentSessionImportProjectChangedError({ projectId }));
  }).pipe(
    Effect.provide(
      AgentSessionImporter.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeed(
                  Option.some({
                    id: projectId,
                    workspaceRoot: "/workspace/project",
                    workspaceFile: "/workspace/project.code-workspace",
                  } as never),
                ),
              snapshotWorkspaceFolders: () =>
                Effect.succeed([{ path: "/workspace/new-primary", name: "Moved", label: "moved" }]),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({}),
            Layer.mock(EventSink.EventSinkV2)({}),
            Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({}),
            IdAllocator.layer,
          ),
        ),
      ),
    ),
  ),
);
