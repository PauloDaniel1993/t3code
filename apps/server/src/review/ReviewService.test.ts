import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EventId, ProjectId, type WorkspaceFolderEntry } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

function layer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly worktreesDirectory?: string;
  readonly previousWorktreesDirectories?: ReadonlyArray<string>;
  readonly projectRoots?: ReadonlyArray<string> | "unavailable";
}) {
  return ReviewService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      ServerSettings.layerTest({
        worktreesDirectory: input.worktreesDirectory ?? "",
        previousWorktreesDirectories: [...(input.previousWorktreesDirectories ?? [])],
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(
      input.projectRoots === undefined
        ? ProjectStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))
        : Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () =>
              input.projectRoots === "unavailable"
                ? Effect.fail(
                    new ProjectStore.ProjectStoreV2Error({ operation: "list", cause: "offline" }),
                  )
                : Effect.succeed(
                    (input.projectRoots ?? []).map((workspaceRoot, index) => ({
                      id: ProjectId.make(`project-${index}`),
                      title: `Project ${index}`,
                      workspaceRoot,
                      defaultModelSelection: null,
                      scripts: [],
                      createdAt: "2026-01-01T00:00:00.000Z",
                      updatedAt: "2026-01-01T00:00:00.000Z",
                    })),
                  ),
          }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

const now = "2026-10-11T00:00:00.000Z";
const eventBase = (projectId: ProjectId, sequence: number) => ({
  sequence,
  eventId: EventId.make(`${projectId}:${sequence}`),
  aggregateKind: "project" as const,
  aggregateId: projectId,
  occurredAt: now,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

const addProject = (input: {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly workspaceFile?: string;
  readonly folders?: ReadonlyArray<WorkspaceFolderEntry>;
}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projectId = ProjectId.make(input.id);
    yield* projects.apply({
      ...eventBase(projectId, 1),
      type: "project.created",
      payload: {
        projectId,
        title: input.id,
        workspaceRoot: input.workspaceRoot,
        ...(input.workspaceFile === undefined ? {} : { workspaceFile: input.workspaceFile }),
        ...(input.folders === undefined ? {} : { folders: input.folders }),
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
    return projectId;
  });

const deleteProject = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    yield* projects.apply({
      ...eventBase(projectId, 2),
      type: "project.deleted",
      payload: { projectId, deletedAt: now },
    });
  });

describe("ReviewService", () => {
  it.effect("rejects diff preview cwd outside every registered location", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within a registered project folder or worktree/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attributes file-content workspace violations to the file-content operation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .getDiffFileContents({
            cwd: outsideRoot,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: "file.ts",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffFileContents");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within a registered project folder or worktree/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "allows previous custom worktree locations but never a filesystem root",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
        const previous = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-old-worktrees-" });
        const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });

        const result = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd: previous });
        }).pipe(
          Effect.provide(
            layer({
              workspaceRoot,
              baseDir,
              worktreesDirectory: "/",
              previousWorktreesDirectories: [previous],
            }),
          ),
        );
        assert.strictEqual(result.cwd, previous);

        const rootLink = `${baseDir}/root-link`;
        yield* fs.symlink("/", rootLink);
        for (const worktreesDirectory of ["/", rootLink]) {
          const error = yield* Effect.gen(function* () {
            const review = yield* ReviewService.ReviewService;
            return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
          }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, worktreesDirectory })));
          assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows registered project roots outside the server cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      // Stands in for a project on another drive than the server's home cwd.
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const projectChild = `${projectRoot}/packages/app`;
      yield* fs.makeDirectory(projectChild, { recursive: true });
      const sibling = `${projectRoot}-sibling`;
      yield* fs.makeDirectory(sibling);
      yield* Effect.addFinalizer(() => fs.remove(sibling, { recursive: true }).pipe(Effect.ignore));

      const review = (cwd: string, projectRoots: ReadonlyArray<string> | "unavailable") =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, projectRoots })));

      assert.strictEqual((yield* review(projectRoot, [projectRoot])).cwd, projectRoot);
      assert.strictEqual((yield* review(projectChild, [projectRoot])).cwd, projectChild);
      for (const [cwd, projectRoots] of [
        [sibling, [projectRoot]],
        [projectRoot, []],
        [projectRoot, "unavailable"],
      ] as const) {
        const error = yield* review(cwd, projectRoots).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff preview cwd inside the server's launch directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: workspaceRoot });
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(result.cwd, workspaceRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: workspaceRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves unexpected path-resolution failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const invalidCwd = `${workspaceRoot}\0invalid`;
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: invalidCwd }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.assertWorkspaceBoundCwd.canonicalizePath");
      assert.strictEqual(error.cwd, invalidCwd);
      assert.match(error.detail, /Failed to resolve a path/);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "allows diff previews at an active plain project's root outside the launch directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The server launched in one place while the project lives in another, as on another drive.
        const launchRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-launch-" });
        const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
        const detectCalls: Array<{ readonly cwd: string }> = [];

        const result = yield* Effect.gen(function* () {
          yield* addProject({ id: "plain", workspaceRoot: projectRoot });
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd: projectRoot });
        }).pipe(Effect.provide(layer({ workspaceRoot: launchRoot, baseDir, detectCalls })));

        assert.strictEqual(result.cwd, projectRoot);
        assert.deepStrictEqual(detectCalls, [{ cwd: projectRoot }]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows review diffs in every folder of an active linked project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const launchRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-launch-" });
      const projectsRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-projects-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const primary = path.join(projectsRoot, "t3code");
      const secondary = path.join(projectsRoot, "Whisper");
      yield* fs.makeDirectory(primary);
      yield* fs.makeDirectory(secondary);
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const [previews, fileContentsError] = yield* Effect.gen(function* () {
        yield* addProject({
          id: "linked",
          workspaceRoot: primary,
          workspaceFile: path.join(projectsRoot, "Personal.code-workspace"),
          folders: [
            { path: primary, name: "t3code" },
            { path: secondary, name: "Whisper" },
          ],
        });
        const review = yield* ReviewService.ReviewService;
        const previews = yield* Effect.forEach([primary, secondary], (cwd) =>
          review.getDiffPreview({ cwd }),
        );
        const fileContentsError = yield* review
          .getDiffFileContents({
            cwd: secondary,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: "file.ts",
          })
          .pipe(Effect.flip);
        return [previews, fileContentsError] as const;
      }).pipe(Effect.provide(layer({ workspaceRoot: launchRoot, baseDir, detectCalls })));

      assert.deepStrictEqual(
        previews.map((preview) => preview.cwd),
        [primary, secondary],
      );
      // Past the guard, file contents fail only because the folder is no repository.
      assert.strictEqual(fileContentsError._tag, "VcsUnsupportedOperationError");
      assert.deepStrictEqual(detectCalls, [
        { cwd: primary },
        { cwd: secondary },
        { cwd: secondary },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!symlinksSupported)("compares project folders by where symlinks lead", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const launchRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-launch-" });
      const realRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-real-" });
      const linksRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-links-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const registeredRoot = path.join(linksRoot, "project");
      const escape = path.join(realRoot, "escape");
      yield* fs.symlink(realRoot, registeredRoot);
      yield* fs.symlink(outsideRoot, escape);
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const [result, escapeError] = yield* Effect.gen(function* () {
        yield* addProject({ id: "linked-root", workspaceRoot: registeredRoot });
        const review = yield* ReviewService.ReviewService;
        return [
          yield* review.getDiffPreview({ cwd: realRoot }),
          yield* review.getDiffPreview({ cwd: escape }).pipe(Effect.flip),
        ] as const;
      }).pipe(Effect.provide(layer({ workspaceRoot: launchRoot, baseDir, detectCalls })));

      // The project is registered through a link to where the diff runs.
      assert.strictEqual(result.cwd, realRoot);
      // A link inside the folder that leads out of it grants nothing.
      assert.strictEqual(escapeError._tag, "VcsRepositoryDetectionError");
      assert.deepStrictEqual(detectCalls, [{ cwd: realRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff previews inside the worktrees directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const launchRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-launch-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const [worktree, result] = yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const worktree = path.join(config.worktreesDir, "t3code", "feature");
        yield* fs.makeDirectory(worktree, { recursive: true });
        const review = yield* ReviewService.ReviewService;
        return [worktree, yield* review.getDiffPreview({ cwd: worktree })] as const;
      }).pipe(Effect.provide(layer({ workspaceRoot: launchRoot, baseDir, detectCalls })));

      assert.strictEqual(result.cwd, worktree);
      assert.deepStrictEqual(detectCalls, [{ cwd: worktree }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects deleted projects' folders and paths no project registers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const launchRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-launch-" });
      const activeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-active-" });
      const deletedRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-deleted-" });
      const unrelatedRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-unrelated-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const errors = yield* Effect.gen(function* () {
        yield* addProject({ id: "active", workspaceRoot: activeRoot });
        // A folder that can't be resolved, like one on an unplugged drive, grants nothing.
        yield* addProject({ id: "unplugged", workspaceRoot: path.join(activeRoot, "missing") });
        yield* deleteProject(yield* addProject({ id: "deleted", workspaceRoot: deletedRoot }));
        const review = yield* ReviewService.ReviewService;
        return yield* Effect.forEach([deletedRoot, unrelatedRoot], (cwd) =>
          review.getDiffPreview({ cwd }).pipe(Effect.flip),
        );
      }).pipe(Effect.provide(layer({ workspaceRoot: launchRoot, baseDir, detectCalls })));

      for (const error of errors) {
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
        assert.match(
          "detail" in error ? error.detail : "",
          /must stay within a registered project folder or worktree/,
        );
      }
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
