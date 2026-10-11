import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

const finalizedScope = (parts: OrchestrationV2CheckpointScope["parts"]) =>
  ({
    id: CheckpointScopeId.make("scope_finalize"),
    threadId: ThreadId.make("thread_finalize"),
    runId: RunId.make("run_finalize"),
    nodeId: NodeId.make("node_finalize"),
    parentScopeId: null,
    providerThreadId: null,
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: "/repo",
    ...(parts === undefined ? {} : { parts }),
    createdAt: DateTime.makeUnsafe("2026-10-10T00:00:00.000Z"),
  }) satisfies OrchestrationV2CheckpointScope;

it.effect.each([
  { label: "its cwd", scope: finalizedScope(undefined), expected: ["/repo"] },
  {
    // The scope row may hold a later run's plan; the run's own facts win.
    label: "each folder its run could reach",
    scope: finalizedScope([
      { key: "primary", cwd: "/repo", vcs: "git", pathspecs: ["."], folders: [] },
    ]),
    expected: ["/repo/app", "/notes"],
  },
])("refreshes $label after checkpoint capture without reading history", ({ scope, expected }) => {
  const { threadId, runId, id: scopeId } = scope;
  const capture = vi.fn(() => Effect.void);
  const refreshed: Array<string> = [];
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: capture }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () =>
            Effect.die("workspace refresh must not load transcript history"),
          getCheckpointCaptureContext: () =>
            Effect.succeed({
              run: { unavailableFolderPaths: ["/lib"] } as unknown as OrchestrationV2Run,
              rootNode: undefined,
              scope,
              providerThread: undefined,
              readyCheckpointOrdinals: [],
              partTurnCheckpointOrdinals: [],
            }),
          getThread: () =>
            Effect.succeed({
              worktreePath: null,
              workspaceFolders: [
                { path: "/repo/app", name: "app", label: "app", checkoutRoot: "/repo" },
                { path: "/notes", name: "notes", label: "notes", checkoutRoot: null },
                { path: "/lib", name: "lib", label: "lib", checkoutRoot: "/lib" },
              ],
            } as unknown as OrchestrationV2AppThread),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh: ({ cwd }) => Effect.sync(() => void refreshed.push(cwd)),
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId: runId!, scopeId });
    assert.equal(capture.mock.calls.length, 1);
    assert.deepEqual(refreshed.toSorted(), expected.toSorted());
  }).pipe(Effect.provide(layer));
});

it.effect.each(
  (
    [
      {
        label: "discovers a new PR for the completed run's branch",
        branch: "feature",
        checkedOut: "feature",
        activeRun: null,
        expected: ["/repo"],
      },
      {
        label: "leaves the default branch's PR cache alone",
        branch: "main",
        checkedOut: "main",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh another thread's checkout",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh during a newer active run",
        branch: "feature",
        checkedOut: "feature",
        activeRun: "newer-run",
        expected: [],
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const refreshed: string[] = [];
  const threadId = ThreadId.make("thread-pr-refresh");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.observerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: scenario.checkedOut === "main",
              refName: scenario.checkedOut,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () =>
            Effect.die("turn completion must preserve known PRs and lookup backoff"),
          refreshPullRequestStatus: (cwd) =>
            Effect.sync(() => {
              refreshed.push(cwd);
              return null;
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: scenario.branch,
              activeRunId: scenario.activeRun === null ? null : RunId.make(scenario.activeRun),
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    assert.deepEqual(refreshed, [...scenario.expected]);
  }).pipe(Effect.provide(layer));
});
