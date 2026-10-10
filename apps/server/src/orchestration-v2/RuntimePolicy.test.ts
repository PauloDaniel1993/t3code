import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  PROVIDER_WORKSPACE_FOLDER_ACCESS_MESSAGE,
  ProjectId,
  ProviderInstanceId,
  type ProviderWorkspaceFolderAccess,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
  readonly workspaceFolders?: OrchestrationV2AppThread["workspaceFolders"];
  readonly worktrees?: OrchestrationV2AppThread["worktrees"];
  readonly projectId?: ProjectId;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: input.projectId ?? projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    ...(input.workspaceFolders === undefined ? {} : { workspaceFolders: input.workspaceFolders }),
    ...(input.worktrees === undefined ? {} : { worktrees: input.worktrees }),
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

// Grok's instance offers no Auto-accept edits; the Codex instance advertises no
// restriction.
const grokInstanceId = ProviderInstanceId.make("grok");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
// Codex says nothing of folder access, which counts as unverified.
const supportedInstanceId = ProviderInstanceId.make("multi-root");
const unverifiedInstanceId = ProviderInstanceId.make("unverified");
const missingInstanceId = ProviderInstanceId.make("missing");
const workspaceFolderAccessByInstance = new Map<ProviderInstanceId, ProviderWorkspaceFolderAccess>([
  [supportedInstanceId, "supported"],
  [unverifiedInstanceId, "unverified"],
  [grokInstanceId, "unsupported"],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  instanceId === missingInstanceId
    ? undefined
    : ({
        snapshot: {
          getSnapshot: Effect.succeed({
            supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
            workspaceFolderAccess: workspaceFolderAccessByInstance.get(instanceId),
          } as ServerProvider),
        },
      } as ProviderInstance);

let projectReads = 0;
const TestLayer = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (requestedProjectId) =>
        Effect.sync(() => {
          projectReads += 1;
        }).pipe(
          Effect.as(
            requestedProjectId !== projectId
              ? Option.none()
              : Option.some({
                  projectId,
                  title: "Project",
                  workspaceRoot: "/project-root",
                  workspaceFile: null,
                  folders: null,
                  defaultModelSelection: null,
                  defaultThreadEnvMode: null,
                  autoPull: false,
                  faviconPath: null,
                  projectIcon: null,
                  scripts: [],
                  createdAt: "2026-06-21T00:00:00.000Z",
                  updatedAt: "2026-06-21T00:00:00.000Z",
                  deletedAt: null,
                }),
          ),
        ),
    }),
  ),
);

const folder = (path: string, checkoutRoot: string | null = null) => ({
  path,
  name: path.split("/").at(-1)!,
  label: path.split("/").at(-1)!,
  checkoutRoot,
});

it.layer(TestLayer)("RuntimePolicyV2", (it) => {
  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );

  it.effect("keeps a thread with a folder snapshot in its own primary folder", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      // The project's primary has since moved to /project-root.
      const resolved = yield* policy.resolve({
        thread: makeThread({
          now,
          worktreePath: null,
          workspaceFolders: [
            { path: "/bound-primary", name: "app", label: "app", checkoutRoot: null },
            { path: "/bound-docs", name: "docs", label: "docs", checkoutRoot: null },
          ],
        }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/bound-primary");
    }),
  );

  it.effect("reads the project even for a worktree thread, which needs none to exist", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const readsBefore = projectReads;
      const resolved = yield* policy.resolve({
        thread: makeThread({
          now,
          worktreePath: "/project-worktree",
          projectId: ProjectId.make("project:gone"),
        }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
      assert.equal(projectReads, readsBefore + 1);

      // A thread that names no folder of its own can't run without its project.
      const error = yield* policy
        .resolve({
          thread: makeThread({
            now,
            worktreePath: null,
            projectId: ProjectId.make("project:gone"),
          }),
          modelSelection,
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "RuntimePolicyResolveError");
    }),
  );

  it.effect("hands a one-folder thread no additional directories", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      for (const worktreePath of [null, "/project-worktree"]) {
        const resolved = yield* policy.resolve({
          thread: makeThread({ now, worktreePath }),
          modelSelection,
        });
        assert.deepEqual(resolved.additionalDirectories, []);
      }
    }),
  );

  it.effect("lists the other available folders in snapshot order, leaving out nested ones", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({
          now,
          worktreePath: null,
          workspaceFolders: [
            folder("/work/app", "/work/app"),
            folder("/work/lib", "/work/lib"),
            folder("/work/app/docs", "/work/app"),
            folder("/work/gone"),
            { uri: "vscode-remote://ssh-remote+box/srv", name: "srv", label: "srv" },
            folder("/shared"),
          ],
        }),
        modelSelection,
        unavailableFolderPaths: ["/work/gone"],
      });
      assert.equal(resolved.cwd, "/work/app");
      assert.deepEqual(resolved.additionalDirectories, ["/work/lib", "/shared"]);
    }),
  );

  it.effect("maps a worktree thread's folders into its set, and leaves the rest in place", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({
          now,
          worktreePath: "/wt/s/repo/web",
          workspaceFolders: [
            folder("/repo/web", "/repo"),
            folder("/repo/lib/vendor", "/repo/lib/vendor"),
            folder("/repo/lib", "/repo"),
            folder("/notes"),
          ],
          worktrees: [
            { repositoryRoot: "/repo", path: "/wt/s/repo", branch: "t3code/feature" },
            {
              repositoryRoot: "/repo/lib/vendor",
              path: "/wt/s/repo/lib/vendor",
              branch: "t3code/feature",
            },
          ],
        }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/wt/s/repo/web");
      assert.deepEqual(resolved.additionalDirectories, [
        "/wt/s/repo/lib/vendor",
        "/wt/s/repo/lib",
        "/notes",
      ]);
    }),
  );

  it.effect("lets only a supported provider run a scope with additional directories", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const threadId = ThreadId.make("thread:runtime-policy");
      const check = (providerInstanceId: ProviderInstanceId, additionalDirectories: string[]) =>
        policy
          .requireWorkspaceFolderAccess({
            threadId,
            providerInstanceId,
            scope: { additionalDirectories },
          })
          .pipe(Effect.exit);

      assert.isTrue(Exit.isSuccess(yield* check(supportedInstanceId, ["/work/lib"])));
      for (const instanceId of [
        unverifiedInstanceId,
        grokInstanceId,
        providerInstanceId,
        missingInstanceId,
      ]) {
        const exit = yield* check(instanceId, ["/work/lib"]);
        assert.isTrue(Exit.isFailure(exit));
        const error = yield* policy
          .requireWorkspaceFolderAccess({
            threadId,
            providerInstanceId: instanceId,
            scope: { additionalDirectories: ["/work/lib"] },
          })
          .pipe(Effect.flip);
        assert.equal(error.message, PROVIDER_WORKSPACE_FOLDER_ACCESS_MESSAGE);
        // Every provider runs a one-folder scope.
        assert.isTrue(Exit.isSuccess(yield* check(instanceId, [])));
      }
    }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      // A provider that advertises no restriction runs every mode as stored.
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );
});

it("reads a policy without additional directories as a one-folder scope", () => {
  const legacy = { runtimeMode: "full-access", interactionMode: "default", cwd: "/work/app" };
  assert.deepEqual(
    Schema.decodeUnknownSync(ProviderAdapterV2RuntimePolicy)(legacy).additionalDirectories,
    [],
  );
  assert.deepEqual(
    ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/work/app",
    }).additionalDirectories,
    [],
  );
});
