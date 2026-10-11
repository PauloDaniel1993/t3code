import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type {
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadWorktree,
  ProjectId,
  ServerSettings,
  ServerSettingsError,
  TerminalSummary,
  WorktreeCleanupRules,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  isPathWithin,
  projectFolders,
  threadUsingWorktrees,
  type WorkspaceProject,
} from "@t3tools/shared/workspaceFolders";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as WorktreeSet from "./orchestration-v2/WorktreeSetService.ts";
import { threadHasQueuedTurnStart } from "./orchestration-v2/ThreadSettlementService.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";

const decodeCleanupThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeCleanupSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);

const DAY_MS = 86_400_000;

const worktreeCleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
  rules.worktreeOnMerge ||
  rules.worktreeOnDelete ||
  rules.worktreeUnchanged;

function anyWorktreePolicy(
  settings: ServerSettings,
  predicate: (rules: WorktreeCleanupRules) => boolean,
): boolean {
  return (
    predicate(resolveWorktreeCleanup(settings, null)) ||
    Object.keys(settings.projectSettingsOverrides).some((projectId) =>
      predicate(resolveWorktreeCleanup(settings, projectId as ProjectId)),
    )
  );
}

function sameProjectWorktreePolicies(left: ServerSettings, right: ServerSettings): boolean {
  return [
    ...new Set([
      ...Object.keys(left.projectSettingsOverrides),
      ...Object.keys(right.projectSettingsOverrides),
    ]),
  ].every((projectId) =>
    Equal.equals(
      left.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
      right.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
    ),
  );
}

/** Live sessions keep their cwd even when no turn is currently running. */
export function storageCleanupThreadIdle(thread: OrchestrationV2ThreadShell, now: number): boolean {
  return (
    thread.branch !== null &&
    thread.worktreePath !== null &&
    thread.activeRunId === null &&
    (thread.status === "idle" || thread.status === "failed") &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    thread.pendingRuntimeRequest === null &&
    !threadHasQueuedTurnStart(thread, now)
  );
}

/** PR metadata refreshes must not reset the inactivity clock. */
export function storageCleanupActivityAt(thread: OrchestrationV2ThreadShell): number {
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].flatMap((value) => (value == null ? [] : [DateTime.toEpochMillis(value)])),
  );
}

type CleanupThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "projectId" | "worktreePath" | "branch" | "worktrees"
>;

/**
 * The threads whose worktrees storage cleanup may remove, each with the
 * worktrees that go together: every member of its set, each from its own
 * checkout, or its lone worktree from its project's checkout. A thread is
 * left out while any other thread, archived ones included, works inside one
 * of them, and a deleted thread while any remaining thread does. A set whose
 * members nest is left for explicit removal: its parent's checkout can't tell
 * the nested worktree from its own untracked or ignored files.
 */
export function storageCleanupCandidates<
  Thread extends CleanupThread,
  Deleted extends CleanupThread & { readonly workspaceRoot: string },
>(input: {
  readonly threads: ReadonlyArray<Thread>;
  readonly deletedThreads: ReadonlyArray<Deleted>;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
}): ReadonlyArray<
  {
    readonly projectRoot: string;
    readonly worktrees: ReadonlyArray<OrchestrationV2ThreadWorktree>;
  } & (
    | { readonly deleted: false; readonly thread: Thread }
    | { readonly deleted: true; readonly thread: Deleted }
  )
> {
  const worktreesOf = (thread: CleanupThread, projectRoot: string) =>
    thread.worktrees ??
    (thread.worktreePath === null || thread.branch === null
      ? []
      : [{ repositoryRoot: projectRoot, path: thread.worktreePath, branch: thread.branch }]);
  const unshared = (
    thread: CleanupThread,
    worktrees: ReadonlyArray<OrchestrationV2ThreadWorktree>,
  ) =>
    worktrees.length > 0 &&
    !worktrees.some((worktree) =>
      worktrees.some((other) => other !== worktree && isPathWithin(worktree.path, other.path)),
    ) &&
    threadUsingWorktrees(
      input.threads,
      thread.id,
      worktrees.map((worktree) => worktree.path),
    ) === undefined;
  return [
    ...input.threads.flatMap((thread) => {
      const projectRoot = input.projects.find(
        (project) => project.id === thread.projectId,
      )?.workspaceRoot;
      if (projectRoot === undefined) return [];
      const worktrees = worktreesOf(thread, projectRoot);
      return unshared(thread, worktrees)
        ? [{ deleted: false as const, thread, projectRoot, worktrees }]
        : [];
    }),
    ...input.deletedThreads.flatMap((thread) => {
      const worktrees = worktreesOf(thread, thread.workspaceRoot);
      return unshared(thread, worktrees)
        ? [{ deleted: true as const, thread, projectRoot: thread.workspaceRoot, worktrees }]
        : [];
    }),
  ];
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const worktreeSets = yield* WorktreeSet.WorktreeSetService;
  const gitManager = yield* GitManager.GitManager;
  const terminals = yield* TerminalManager.TerminalManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };

  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const hasTerminal = (worktreePath: string) =>
    [...liveTerminals.values()]
      .flatMap((entries) => [...entries.values()])
      .some((terminal) => {
        if (terminal.status !== "starting" && terminal.status !== "running") return false;
        const cwd = path.resolve(terminal.cwd);
        return (
          (terminal.worktreePath !== null &&
            path.resolve(terminal.worktreePath) === worktreePath) ||
          cwd === worktreePath ||
          inside(worktreePath, cwd)
        );
      });

  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const active = yield* projections.getShellSnapshot();
    const archived = yield* projections.getShellSnapshot({ location: "archive" });
    const projects = yield* projectStore.listShells();
    // The archive snapshot holds archived threads in `archivedThreads`.
    return { projects, threads: [...active.threads, ...archived.archivedThreads] };
  });

  // Local threads under another project need not have a worktreePath of their
  // own, and neither do threads reaching a linked project's other folders.
  const containsProjectRoot = Effect.fn("StorageCleanup.containsProjectRoot")(function* (
    worktreePath: string,
    projects: ReadonlyArray<WorkspaceProject>,
  ) {
    for (const folder of projects.flatMap(projectFolders)) {
      if (folder.path === undefined) continue;
      const projectPath = path.resolve(folder.path);
      if (projectPath === worktreePath || inside(worktreePath, projectPath)) return true;
      const realPath = yield* fs
        .realPath(projectPath)
        .pipe(Effect.orElseSucceed(() => projectPath));
      if (realPath === worktreePath || inside(worktreePath, realPath)) return true;
    }
    return false;
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
  ) {
    if (!anyWorktreePolicy(serverSettings, worktreeCleanupEnabled)) return;
    if (!(yield* fs.exists(config.worktreesDir))) return;
    const hasDeleteRule = anyWorktreePolicy(serverSettings, (rules) => rules.worktreeOnDelete);
    const deletedRows = hasDeleteRule
      ? yield* sql<{ payload_json: string; workspaceRoot: string }>`
          SELECT t.payload_json, p.workspace_root AS "workspaceRoot"
          FROM orchestration_v2_projection_threads t
          JOIN projection_projects p ON p.project_id = t.project_id
          WHERE t.deleted_at IS NOT NULL
        `
      : [];
    const deletedThreads = (yield* Effect.forEach(deletedRows, (row) =>
      decodeCleanupThread(row.payload_json).pipe(
        Effect.map((thread) => ({ ...thread, workspaceRoot: row.workspaceRoot })),
      ),
    )).filter(
      (thread) =>
        thread.worktreePath !== null &&
        thread.branch !== null &&
        resolveWorktreeCleanup(serverSettings, thread.projectId).worktreeOnDelete,
    );
    const snapshot = yield* readThreads();
    const root = yield* fs.realPath(config.worktreesDir);
    const refreshedDefaultRefs = new Map<string, Set<string>>();
    const candidates = storageCleanupCandidates({
      threads: snapshot.threads,
      deletedThreads,
      projects: snapshot.projects,
    });

    // Ignored files can contain secrets or local datasets. Dependency installs
    // are reproducible; every other ignored path prevents automatic removal.
    const onlyRemovableIgnored = (worktreePath: string) =>
      git
        .execute({
          operation: "StorageCleanup.ignoredFiles",
          cwd: worktreePath,
          args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
          maxOutputBytes: 64 * 1024,
        })
        .pipe(
          Effect.map(
            (ignored) =>
              !ignored.stdoutTruncated &&
              ignored.stdout
                .split("\0")
                .every((entry) => entry === "" || /(^|\/)node_modules\/$/.test(entry)),
          ),
        );

    for (const candidate of candidates) {
      const { thread, projectRoot } = candidate;
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      if (!worktreeCleanupEnabled(settings)) continue;
      if (!candidate.deleted && !storageCleanupThreadIdle(candidate.thread, now)) continue;
      const deleted = candidate.deleted;
      // When the live thread last did anything; a change cancels the removal.
      const activityAt = candidate.deleted ? null : storageCleanupActivityAt(candidate.thread);
      const worktrees = candidate.worktrees.map((worktree) => ({
        ...worktree,
        path: path.resolve(worktree.path),
      }));
      if (worktrees.some((worktree) => hasTerminal(worktree.path))) continue;
      const project = { workspaceRoot: projectRoot };
      // The set is removed whole or not at all, so every member must qualify.
      const removable = (
        worktree: (typeof worktrees)[number],
        expectedHead: string | undefined,
        projects: ReadonlyArray<WorkspaceProject>,
      ) =>
        Effect.gen(function* () {
          if (!inside(root, worktree.path) || !(yield* fs.exists(worktree.path))) return null;
          if ((yield* fs.realPath(worktree.path)) !== worktree.path) return null;
          if (yield* containsProjectRoot(worktree.path, projects)) return null;
          // A linked worktree has a .git file. Never remove a main checkout.
          if ((yield* fs.stat(path.join(worktree.path, ".git"))).type !== "File") return null;
          const status = yield* git.statusDetailsLocal(worktree.path);
          if (!status.isRepo || status.branch !== worktree.branch || status.hasWorkingTreeChanges)
            return null;
          const head = yield* git.resolveCommit({ cwd: worktree.path, revision: "HEAD" });
          if (expectedHead !== undefined && head.commitSha !== expectedHead) return null;
          if (!(yield* onlyRemovableIgnored(worktree.path))) return null;
          return head.commitSha;
        });
      // Its HEAD is in its repository's default branch, and, under the merge
      // rule, its pull request merged.
      const integrated = (worktree: (typeof worktrees)[number], head: string) =>
        Effect.gen(function* () {
          const repositoryCwd = path.resolve(worktree.repositoryRoot);
          const remote = yield* git.resolvePrimaryRemoteName(repositoryCwd);
          const branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
          if (branch === null) return false;
          const defaultRef = `refs/remotes/${remote}/${branch}`;
          const refreshed = refreshedDefaultRefs.get(repositoryCwd) ?? new Set<string>();
          if (!refreshed.has(defaultRef)) {
            yield* git.fetchRemoteTrackingBranch({
              cwd: repositoryCwd,
              remoteName: remote,
              remoteBranch: branch,
            });
            refreshed.add(defaultRef);
            refreshedDefaultRefs.set(repositoryCwd, refreshed);
          }
          const base = yield* git.resolveCommit({
            cwd: worktree.path,
            revision: defaultRef,
          });
          const ancestor = yield* git.execute({
            operation: "StorageCleanup.integratedBranch",
            cwd: worktree.path,
            args: ["merge-base", "--is-ancestor", head, base.commitSha],
            allowNonZeroExit: true,
          });
          if (ancestor.exitCode !== 0) return false;
          if (settings.worktreeUnchanged) return true;
          if (!settings.worktreeOnMerge) return false;
          const pullRequest = yield* gitManager.branchPullRequest(
            { cwd: worktree.path, branch: worktree.branch },
            { refresh: true },
          );
          return pullRequest?.state === "merged";
        });
      yield* Effect.gen(function* () {
        const heads: Array<string> = [];
        for (const worktree of worktrees) {
          const head = yield* removable(worktree, undefined, [project, ...snapshot.projects]);
          if (head === null) return;
          heads.push(head);
        }
        const old =
          activityAt !== null &&
          settings.worktreeAfterDays !== null &&
          activityAt < now - settings.worktreeAfterDays * DAY_MS;
        if (!deleted && !old) {
          if (!settings.worktreeUnchanged && !settings.worktreeOnMerge) return;
          for (const [index, worktree] of worktrees.entries()) {
            if (!(yield* integrated(worktree, heads[index]!))) return;
          }
        }
        // Re-read after Git/host calls so a queued turn, resumed session or new
        // thread sharing these paths cancels the removal.
        const latestSnapshot = yield* readThreads();
        const paths = worktrees.map((worktree) => worktree.path);
        if (worktrees.some((worktree) => hasTerminal(worktree.path))) return;
        if (threadUsingWorktrees(latestSnapshot.threads, thread.id, paths) !== undefined) return;
        if (deleted) {
          if (
            !resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
              .worktreeOnDelete
          )
            return;
          // V2 deletion queues durable cleanup. Do not remove its checkout until
          // every effect has finished successfully or was explicitly cancelled.
          const pendingCleanup = yield* sql`
            SELECT 1 FROM orchestration_v2_effect_outbox
            WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1
          `;
          if (pendingCleanup.length > 0) return;
        } else {
          const latest = latestSnapshot.threads.find((entry) => entry.id === thread.id);
          if (
            latest === undefined ||
            latest.worktreePath !== thread.worktreePath ||
            !storageCleanupThreadIdle(latest, now) ||
            storageCleanupActivityAt(latest) !== activityAt
          )
            return;
        }
        // Sessions can outlive their run and can be shared across app threads.
        const sessionRows = yield* sql<{ payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_provider_sessions
          WHERE status != 'stopped'
        `;
        const sessions = yield* Effect.forEach(sessionRows, (row) =>
          decodeCleanupSession(row.payload_json),
        );
        if (
          sessions.some((session) => {
            const cwd = path.resolve(session.cwd);
            return paths.some((worktreePath) => cwd === worktreePath || inside(worktreePath, cwd));
          })
        )
          return;
        for (const [index, worktree] of worktrees.entries()) {
          if (
            (yield* removable(worktree, heads[index], [project, ...latestSnapshot.projects])) ===
            null
          )
            return;
        }
        const current = resolveWorktreeCleanup(
          yield* settingsService.getSettings,
          thread.projectId,
        );
        if (
          Object.keys(settings).some(
            (key) =>
              current[key as keyof typeof settings] !== settings[key as keyof typeof settings],
          )
        )
          return;
        // The coordinator removes the set and what it leaves in its session
        // directory, each member from the checkout the thread recorded.
        const removed = yield* worktreeSets.remove({ threadId: thread.id, force: false });
        for (const worktree of removed) {
          yield* gitManager.invalidateStatus(worktree.repositoryRoot);
        }
        // Preserve branches and paths: turn start recreates the checkouts from
        // those branches when the thread is resumed.
        yield* Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id });
      }).pipe(
        (effect) =>
          worktrees
            .map((worktree) => worktree.path)
            .toSorted()
            .reduce((leased, worktreePath) => withWorkspaceLease(worktreePath, leased), effect),
        Effect.catch((error) =>
          Effect.logDebug("storage cleanup skipped worktree", { threadId: thread.id, error }),
        ),
      );
    }
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
  ) {
    if (days === null || !(yield* fs.exists(root))) return;
    const realRoot = yield* fs.realPath(root);
    if (realRoot !== path.resolve(root)) return;
    const visit = Effect.fn("StorageCleanup.visitFiles")(function* (
      directory: string,
    ): Effect.fn.Return<void, PlatformError | ServerSettingsError> {
      for (const name of yield* fs.readDirectory(directory)) {
        const target = path.join(directory, name);
        if ((yield* fs.realPath(target)) !== target || !inside(realRoot, target)) continue;
        const stat = yield* fs.stat(target);
        if (stat.type === "Directory" && rotatedLogs) {
          yield* visit(target);
        } else if (stat.type === "File" && (!rotatedLogs || /\.(?:log|ndjson)\.\d+$/.test(name))) {
          const modified = Option.getOrNull(stat.mtime);
          if (modified !== null && modified.getTime() < now - days * DAY_MS) {
            const current = (yield* settingsService.getSettings).storageCleanup;
            if ((rotatedLogs ? current.logsAfterDays : current.browserArtifactsAfterDays) !== days)
              return;
            yield* fs.remove(target);
          }
        }
      }
    });
    yield* visit(realRoot);
  });

  const sweep = Effect.fn("StorageCleanup.sweep")(function* () {
    const serverSettings = yield* settingsService.getSettings;
    const settings = serverSettings.storageCleanup;
    const now = yield* Clock.currentTimeMillis;
    yield* cleanWorktrees(serverSettings, now).pipe(
      Effect.catch((error) => Effect.logWarning("worktree cleanup failed", { error })),
    );
    yield* cleanFiles(
      config.browserArtifactsDir,
      settings.browserArtifactsAfterDays,
      now,
      false,
    ).pipe(
      Effect.catch((error) => Effect.logWarning("browser artifact cleanup failed", { error })),
    );
    yield* cleanFiles(config.logsDir, settings.logsAfterDays, now, true).pipe(
      Effect.catch((error) => Effect.logWarning("rotated log cleanup failed", { error })),
    );
  });
  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("storage cleanup failed", { cause }),
      ),
    ),
  );

  const start = Effect.fn("StorageCleanup.start")(function* () {
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          liveTerminals.clear();
          for (const terminal of event.terminals) noteTerminal(terminal);
        } else if (event.type === "upsert") {
          noteTerminal(event.terminal);
        } else {
          const threadTerminals = liveTerminals.get(event.threadId);
          threadTerminals?.delete(event.terminalId);
          if (threadTerminals?.size === 0) liveTerminals.delete(event.threadId);
        }
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const changes = yield* settingsService.subscribeChanges;
    const events = engine.streamDomainEvents;
    let lastSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      worker
        .enqueue(undefined)
        .pipe(
          Effect.andThen(worker.drain),
          Effect.repeat(Schedule.spaced("1 hour")),
          Effect.asVoid,
        ),
    );
    yield* forkParked(
      Stream.runForEach(changes, (settings) => {
        if (
          Equal.equals(settings.storageCleanup, lastSettings.storageCleanup) &&
          Equal.equals(settings.worktreeCleanup, lastSettings.worktreeCleanup) &&
          sameProjectWorktreePolicies(settings, lastSettings)
        )
          return Effect.void;
        lastSettings = settings;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        (event.type === "thread.deleted" || event.type === "provider-session.updated") &&
        anyWorktreePolicy(lastSettings, (rules) => rules.worktreeOnDelete)
          ? worker.enqueue(undefined)
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Storage cleanup event stream failed", { cause }),
        ),
      ),
    );
  });
  return { start, drain: worker.drain };
});
