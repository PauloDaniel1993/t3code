import {
  GitCommandError,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  OrchestrationV2ThreadShell,
  ProjectId,
  ServerSettings,
  ServerSettingsError,
  TerminalSummary,
  WorktreeCleanupRules,
  StorageCleanupReport,
  StorageCleanupReportEntry,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  isPathWithin,
  projectFolders,
  threadUsingWorktrees,
  type WorkspaceProject,
} from "@t3tools/shared/workspaceFolders";
import * as WorktreeSet from "./orchestration-v2/WorktreeSetService.ts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
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
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import { threadHasQueuedTurnStart } from "./orchestration-v2/ThreadSettlementService.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "./worktreesDirectory.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const decodeCleanupThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeCleanupSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);

const DAY_MS = 86_400_000;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const REPORT_ENTRY_LIMIT = 200;
const isGitCommandError = Schema.is(GitCommandError);

function cleanupFailureReason(error: { readonly message: string }) {
  return isGitCommandError(error)
    ? `${error.command}: ${error.detail.split(/\r?\n/)[0]}${error.reason ? ` (${error.reason})` : ""}`
    : (error.message.split(/\r?\n/)[0] ?? error.message);
}

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
    (thread.status === "idle" ||
      thread.status === "completed" ||
      thread.status === "interrupted" ||
      thread.status === "failed" ||
      thread.status === "cancelled" ||
      thread.status === "rolled_back") &&
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

/**
 * Whether the host's pull request proves this worktree's head was merged. A
 * squash or rebase merge leaves the head outside the default branch, so the
 * merged pull request then has to name this exact commit.
 */
export function storageCleanupPullRequestMerged(
  pullRequest: Pick<
    GitManager.GitBranchPullRequest,
    "state" | "headRef" | "baseRef" | "headSha"
  > | null,
  worktree: {
    readonly branch: string;
    readonly defaultBranch: string;
    readonly headSha: string;
    readonly integrated: boolean;
  },
): boolean {
  return (
    pullRequest?.state === "merged" &&
    (worktree.integrated ||
      (pullRequest.headRef === worktree.branch &&
        pullRequest.baseRef === worktree.defaultBranch &&
        pullRequest.headSha === worktree.headSha))
  );
}

export class StorageCleanup extends Context.Service<
  StorageCleanup,
  {
    readonly runNow: Effect.Effect<StorageCleanupReport, ServerSettingsError>;
    readonly latestReport: Effect.Effect<StorageCleanupReport | null>;
    readonly reports: Stream.Stream<StorageCleanupReport | null>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/storageCleanup") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const worktreeSets = yield* WorktreeSet.WorktreeSetService;
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

  const measureWorktree = (worktreePath: string) =>
    Effect.gen(function* () {
      const root = yield* fs.realPath(worktreePath);
      const pending = [root];
      let entries = 1;
      let bytes = 0;
      while (pending.length > 0) {
        const target = pending.pop()!;
        // Effect's stat follows links. Probe with readLink first to get lstat
        // semantics, including skipping dangling links and directory links.
        const isLink = yield* fs.readLink(target).pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) =>
              error.cause instanceof Error &&
              "code" in error.cause &&
              error.cause.code === "EINVAL",
            () => Effect.succeed(false),
          ),
        );
        if (isLink) continue;
        if ((yield* fs.realPath(target)) !== target) return null;
        const stat = yield* fs.stat(target);
        if (stat.type === "File") bytes += Number(stat.size);
        else if (stat.type === "Directory") {
          const names = yield* fs.readDirectory(target);
          entries += names.length;
          if (entries > 2_000_000) return null;
          for (const name of names) {
            const child = path.join(target, name);
            if (!inside(root, child)) return null;
            pending.push(child);
          }
        }
      }
      return bytes;
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.orElseSucceed(() => null),
    );

  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const active = yield* projections.getShellSnapshot();
    const archived = yield* projections.getShellSnapshot({ location: "archive" });
    const projects = yield* projectStore.listShells();
    return { projects, threads: [...active.threads, ...archived.archivedThreads] };
  });

  // Local threads under another project need not have a worktreePath of their own.
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

  // Whether cwd stopped being a checkout of this branch. Two small Git reads,
  // since every worktree in a sweep is asked; statusDetailsLocal also diffs and
  // counts.
  const branchChanged = Effect.fn("StorageCleanup.branchChanged")(function* (
    cwd: string,
    branch: string | null,
  ) {
    const failure = (detail: string) =>
      new GitCommandError({
        operation: "StorageCleanup.branchChanged",
        command: "git",
        cwd,
        detail,
      });
    // Null when cwd is not a repository, or is gone. Git's own messages are
    // matched, so they must not be translated.
    const read = Effect.fnUntraced(function* (args: string[], allowedExitCode?: number) {
      const result = yield* git
        .execute({
          operation: "StorageCleanup.branchChanged",
          cwd,
          args,
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.flatMap(fs.exists(cwd), (exists) =>
              exists ? Effect.fail(error) : Effect.succeed(null),
            ),
          ),
        );
      if (result === null) return null;
      if (result.exitCode === 0 || result.exitCode === allowedExitCode) return result;
      if (result.stderr.toLowerCase().includes("not a git repository")) return null;
      return yield* failure(
        result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
      );
    });
    const index = yield* read(["rev-parse", "--git-path", "index"]);
    if (index === null) return true;
    // Another Git process is writing to this checkout.
    if (yield* fs.exists(`${path.resolve(cwd, index.stdout.trim())}.lock`))
      return yield* failure(
        "Git index is locked. Status will resume when the index lock is removed.",
      );
    // Exits 1 for a detached HEAD. Reads the full ref name, which is never
    // shortened to "heads/<branch>" when a tag shares the branch name.
    const head = yield* read(["symbolic-ref", "--quiet", "HEAD"], 1);
    if (head === null) return true;
    const ref = head.exitCode === 0 ? head.stdout.trim() : "";
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length).trim() : null;
    // Status output writes a detached HEAD as "(detached)", so a branch named
    // with a leading "(" has always been read as one.
    return (name?.startsWith("(") ? null : name) !== branch;
  });

  const localChangesReason = Effect.fn("StorageCleanup.localChangesReason")(function* (
    cwd: string,
    rules: WorktreeCleanupRules,
  ) {
    const status = yield* git.execute({
      operation: "StorageCleanup.localChanges",
      cwd,
      args: [
        "status",
        "--porcelain=v1",
        "-z",
        "--ignore-submodules=none",
        rules.worktreeKeepWhen === "tracked-changes"
          ? "--untracked-files=no"
          : "--untracked-files=all",
      ],
      maxOutputBytes: 64 * 1024,
    });
    if (status.stdoutTruncated) return "local changes exceed the inspection limit";
    const records = status.stdout.split("\0").filter(Boolean);
    let count = 0;
    for (let i = 0; i < records.length; i++) {
      count++;
      if (/^[RC]|^.[RC]/.test(records[i]!)) i++;
    }
    if (count > 0) return `has uncommitted changes (${count} ${count === 1 ? "file" : "files"})`;
    if (rules.worktreeKeepWhen !== "any-local-files") return null;
    const ignored = yield* git.execute({
      operation: "StorageCleanup.ignoredFiles",
      cwd,
      args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      maxOutputBytes: 64 * 1024,
    });
    if (ignored.stdoutTruncated) return "ignored files exceed the inspection limit";
    const file = ignored.stdout
      .split("\0")
      .find((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry));
    return file === undefined ? null : `has ignored files (${file})`;
  });

  const cleanupGit = Effect.fn("StorageCleanup.cleanupGit")(function* (
    cwd: string,
    args: string[],
    command: string,
  ) {
    const result = yield* git.execute({
      operation: "StorageCleanup.cleanupGit",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: 300_000,
    });
    if (result.exitCode !== 0)
      return yield* Effect.fail(
        new GitCommandError({
          operation: "StorageCleanup.cleanupGit",
          command,
          cwd,
          detail: result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
        }),
      );
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
    entries: StorageCleanupReportEntry[],
  ) {
    const roots: Array<string> = [];
    for (const directory of managedWorktreesDirectories(
      serverSettings,
      config.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    )) {
      // An unmounted drive only skips its own worktrees.
      const root = yield* fs.exists(directory).pipe(
        Effect.flatMap((exists) => (exists ? fs.realPath(directory) : Effect.succeed(null))),
        Effect.orElseSucceed(() => null),
      );
      if (root !== null && !isFilesystemRoot(root, path)) roots.push(root);
    }
    const deletedRows = yield* sql<{ payload_json: string; workspaceRoot: string }>`
          SELECT t.payload_json, p.workspace_root AS "workspaceRoot"
          FROM orchestration_v2_projection_threads t
          JOIN projection_projects p ON p.project_id = t.project_id
          WHERE t.deleted_at IS NOT NULL
        `;
    const deletedThreads = (yield* Effect.forEach(deletedRows, (row) =>
      decodeCleanupThread(row.payload_json).pipe(
        Effect.map((thread) => ({ ...thread, workspaceRoot: row.workspaceRoot })),
      ),
    )).filter((thread) => thread.worktreePath !== null && thread.branch !== null);
    const snapshot = yield* readThreads();
    const refreshedDefaultRefs = new Map<string, Set<string>>();
    const groups = Map.groupBy(
      snapshot.threads.filter((thread) => thread.worktreePath !== null),
      (thread) => path.resolve(thread.worktreePath!),
    );
    const candidates = [
      ...[...groups.values()].map((group) => group[0]!),
      ...deletedThreads.filter((thread) => !groups.has(path.resolve(thread.worktreePath!))),
    ];
    for (const thread of candidates) {
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      if (!worktreeCleanupEnabled(settings)) continue;
      const worktreePath = path.resolve(thread.worktreePath!);
      const deleted = "workspaceRoot" in thread;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : snapshot.projects.find((entry) => entry.id === thread.projectId);
      const entry: StorageCleanupReportEntry = {
        kind: "worktree",
        outcome: "kept",
        reason: "",
        path: worktreePath,
        threadId: thread.id,
        threadTitle: thread.title,
        bytes: null,
        files: null,
      };
      const keep = (reason: string) => entries.push({ ...entry, reason: sentence(reason) });
      const worktrees = (
        thread.worktrees ??
        (project === undefined || thread.branch === null
          ? []
          : [{ repositoryRoot: project.workspaceRoot, path: worktreePath, branch: thread.branch }])
      ).map((worktree) => ({ ...worktree, path: path.resolve(worktree.path) }));
      const paths = worktrees.map((worktree) => worktree.path);
      yield* Effect.gen(function* () {
        if (!(yield* fs.exists(worktreePath))) return;
        if (deleted && !settings.worktreeOnDelete) return keep("no rules apply");
        if (project === undefined || worktrees.length === 0) return keep("project is unavailable");
        const shared = groups.get(worktreePath)?.length ?? 0;
        if (shared > 1) return keep(`shared by ${shared} threads`);
        if (threadUsingWorktrees(snapshot.threads, thread.id, paths) !== undefined)
          return keep("shared with another thread's workspace");
        if (
          worktrees.some((worktree) =>
            worktrees.some(
              (other) => other !== worktree && isPathWithin(worktree.path, other.path),
            ),
          )
        )
          return keep("nested worktree set needs explicit removal");
        if (!deleted && !storageCleanupThreadIdle(thread, now))
          return keep("thread is running or has pending work");
        // Every member passes the same upstream checks before any member is removed.
        const inspect = Effect.fnUntraced(function* (worktree: (typeof worktrees)[number]) {
          if (!(yield* fs.exists(worktree.path))) return "worktree set is incomplete";
          if (hasTerminal(worktree.path)) return "open terminal";
          const realPath = yield* fs.realPath(worktree.path);
          const realParent = yield* fs.realPath(path.dirname(worktree.path));
          if (realPath !== path.join(realParent, path.basename(worktree.path)))
            return "worktree is a symbolic link";
          if (!roots.some((root) => inside(root, realPath)))
            return "outside the managed worktree folder";
          if (yield* containsProjectRoot(worktree.path, [project, ...snapshot.projects]))
            return "contains a project checkout";
          if ((yield* fs.stat(path.join(worktree.path, ".git"))).type !== "File")
            return "not a linked worktree";
          if (yield* branchChanged(worktree.path, worktree.branch))
            return "repository or branch changed";
          return yield* localChangesReason(worktree.path, settings);
        });
        const heads: string[] = [];
        for (const worktree of worktrees) {
          const blocked = yield* inspect(worktree);
          if (blocked !== null) return keep(blocked);
          heads.push(
            (yield* git.resolveCommit({ cwd: worktree.path, revision: "HEAD" })).commitSha,
          );
        }
        const old =
          !deleted &&
          settings.worktreeAfterDays !== null &&
          storageCleanupActivityAt(thread) < now - settings.worktreeAfterDays * DAY_MS;
        let removalReason = deleted
          ? "thread was deleted"
          : `inactive for ${Math.floor((now - storageCleanupActivityAt(thread)) / DAY_MS)} days`;
        if (!deleted && !old) {
          for (const [index, worktree] of worktrees.entries()) {
            let eligible = false;
            if (settings.worktreeUnchanged || settings.worktreeOnMerge) {
              const repositoryCwd = path.resolve(worktree.repositoryRoot);
              const remote = yield* git.resolvePrimaryRemoteName(repositoryCwd);
              const branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
              if (branch === null) return keep("default branch is unavailable");
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
              const base = yield* git.resolveCommit({ cwd: worktree.path, revision: defaultRef });
              const ancestor = yield* git.execute({
                operation: "StorageCleanup.integratedBranch",
                cwd: worktree.path,
                args: ["merge-base", "--is-ancestor", heads[index]!, base.commitSha],
                allowNonZeroExit: true,
              });
              const integrated = ancestor.exitCode === 0;
              eligible = integrated && settings.worktreeUnchanged;
              if (eligible) removalReason = "no commits beyond the default branch";
              if (!eligible && settings.worktreeOnMerge) {
                const pullRequest = yield* gitManager.branchPullRequest(
                  { cwd: worktree.path, branch: worktree.branch },
                  { refresh: true },
                );
                eligible = storageCleanupPullRequestMerged(pullRequest, {
                  branch: worktree.branch,
                  defaultBranch: branch,
                  headSha: heads[index]!,
                  integrated,
                });
                if (eligible) removalReason = "pull request was merged";
              }
            }
            if (!eligible)
              return keep(
                settings.worktreeAfterDays !== null
                  ? `inactive for ${Math.floor((now - storageCleanupActivityAt(thread)) / DAY_MS)} of ${settings.worktreeAfterDays} days`
                  : settings.worktreeOnMerge
                    ? "not merged"
                    : "has commits beyond the default branch",
              );
          }
        }
        // Recheck all bindings, pending effects and provider roots after slow I/O.
        const blockedSinceCheck = Effect.fnUntraced(function* () {
          const latestSnapshot = yield* readThreads();
          if (threadUsingWorktrees(latestSnapshot.threads, thread.id, paths) !== undefined)
            return "thread activity or shared worktree changed since check";
          for (const worktree of worktrees) {
            if (hasTerminal(worktree.path)) return "open terminal";
            if (yield* containsProjectRoot(worktree.path, [project, ...latestSnapshot.projects]))
              return "contains a project checkout";
          }
          const latest = latestSnapshot.threads.find((entry) => entry.id === thread.id);
          if (deleted) {
            if (
              latest !== undefined ||
              !resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
                .worktreeOnDelete
            )
              return "thread or cleanup settings changed since check";
            const pendingCleanup = yield* sql`
              SELECT 1 FROM orchestration_v2_effect_outbox
              WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1
            `;
            if (pendingCleanup.length > 0) return "thread deletion is still pending";
          } else if (
            latest === undefined ||
            latest.worktreePath !== thread.worktreePath ||
            !Equal.equals(latest.worktrees, thread.worktrees) ||
            !storageCleanupThreadIdle(latest, now) ||
            storageCleanupActivityAt(latest) !== storageCleanupActivityAt(thread)
          )
            return "thread activity or shared worktree changed since check";
          const sessionRows = yield* sql<{ payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE status != 'stopped'
          `;
          const sessions = yield* Effect.forEach(sessionRows, (row) =>
            decodeCleanupSession(row.payload_json),
          );
          if (
            sessions.some((session) =>
              [session.cwd, ...(session.additionalDirectories ?? [])].some((directory) => {
                const cwd = path.resolve(directory);
                return paths.some((member) => cwd === member || inside(member, cwd));
              }),
            )
          )
            return "provider session is still open";
          return null;
        });
        const blocked = yield* blockedSinceCheck();
        if (blocked !== null) return keep(blocked);
        const sizes = yield* Effect.forEach(worktrees, (worktree) =>
          measureWorktree(worktree.path),
        );
        const bytes = sizes.some((size) => size === null)
          ? null
          : sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0);
        const blockedWhileMeasuring = yield* blockedSinceCheck();
        if (blockedWhileMeasuring !== null) return keep(blockedWhileMeasuring);
        for (const [index, worktree] of worktrees.entries()) {
          const changed = yield* inspect(worktree);
          if (changed !== null) return keep(changed);
          if (
            (yield* git.resolveCommit({ cwd: worktree.path, revision: "HEAD" })).commitSha !==
            heads[index]
          )
            return keep("commit changed since check");
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
          return keep("settings changed since check");
        // Tracked edits remain protected by Git even after the final inspection.
        if (settings.worktreeKeepWhen === "tracked-changes")
          for (const worktree of worktrees)
            yield* cleanupGit(worktree.path, ["clean", "-ffdx"], "git clean");
        const removed =
          thread.worktrees === undefined
            ? yield* cleanupGit(
                project.workspaceRoot,
                ["-c", "status.showUntrackedFiles=normal", "worktree", "remove", worktreePath],
                "git worktree remove",
              ).pipe(Effect.as(worktrees))
            : yield* worktreeSets.remove({ threadId: thread.id, force: false });
        entries.push({ ...entry, outcome: "removed", reason: sentence(removalReason), bytes });
        for (const worktree of removed) yield* gitManager.invalidateStatus(worktree.repositoryRoot);
        // Keep recorded branches and paths for turn-start recreation.
        yield* Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id });
      }).pipe(
        (effect) =>
          paths.toSorted().reduceRight((held, member) => withWorkspaceLease(member, held), effect),
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({ ...entry, outcome: "failed", reason: cleanupFailureReason(error) });
            yield* Effect.logWarning("storage cleanup failed for worktree", {
              threadId: thread.id,
              error,
            });
          }),
        ),
      );
    }
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
    // Owned by the caller so files removed before a failure still count.
    removed: { files: number; bytes: number },
  ) {
    if (days === null || !(yield* fs.exists(root))) return removed;
    const realRoot = yield* fs.realPath(root);
    if (realRoot !== path.resolve(root)) return removed;
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
            removed.files++;
            removed.bytes += Number(stat.size);
          }
        }
      }
    });
    yield* visit(realRoot);
    return removed;
  });

  const reportRef = yield* SubscriptionRef.make<StorageCleanupReport | null>(null);
  const sweep = Effect.fn("StorageCleanup.sweep")(function* (
    trigger: StorageCleanupReport["trigger"],
  ) {
    const now = yield* Clock.currentTimeMillis;
    const serverSettings = yield* settingsService.getSettings;
    const settings = serverSettings.storageCleanup;
    const entries: StorageCleanupReportEntry[] = [];
    yield* cleanWorktrees(serverSettings, now, entries).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          entries.push({
            kind: "worktree",
            outcome: "failed",
            reason: cleanupFailureReason(error),
            path: null,
            threadId: null,
            threadTitle: null,
            bytes: null,
            files: null,
          });
          yield* Effect.logWarning("worktree cleanup failed", { error });
        }),
      ),
    );
    for (const category of [
      {
        kind: "browser-artifacts" as const,
        root: config.browserArtifactsDir,
        days: settings.browserArtifactsAfterDays,
        label: "browser artifacts",
      },
      {
        kind: "logs" as const,
        root: config.logsDir,
        days: settings.logsAfterDays,
        label: "rotated logs",
      },
    ]) {
      if (category.days === null) continue;
      const removed = { files: 0, bytes: 0 };
      yield* cleanFiles(category.root, category.days, now, category.kind === "logs", removed).pipe(
        Effect.map(({ files, bytes }) =>
          entries.push({
            kind: category.kind,
            outcome: files > 0 ? "removed" : "kept",
            reason: files === 0 ? "No expired files" : `Removed ${files} ${category.label}`,
            path: null,
            threadId: null,
            threadTitle: null,
            bytes: files > 0 ? bytes : null,
            files: files > 0 ? files : null,
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({
              kind: category.kind,
              outcome: "failed",
              reason: cleanupFailureReason(error),
              path: null,
              threadId: null,
              threadTitle: null,
              bytes: removed.files > 0 ? removed.bytes : null,
              files: removed.files > 0 ? removed.files : null,
            });
            yield* Effect.logWarning("storage file cleanup failed", { kind: category.kind, error });
          }),
        ),
      );
    }
    const counts = { removed: 0, kept: 0, failed: 0 };
    let bytesFreed = 0;
    for (const entry of entries) {
      counts[entry.outcome]++;
      bytesFreed += entry.bytes ?? 0;
    }
    const priority = { failed: 0, removed: 1, kept: 2 };
    const latestReport: StorageCleanupReport = {
      trigger,
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      finishedAt: DateTime.formatIso(yield* DateTime.now),
      entries: entries
        .sort((a, b) => priority[a.outcome] - priority[b.outcome])
        .slice(0, REPORT_ENTRY_LIMIT),
      counts,
      bytesFreed,
      omittedCount: Math.max(0, entries.length - REPORT_ENTRY_LIMIT),
    };
    yield* SubscriptionRef.set(reportRef, latestReport);
    return latestReport;
  });
  const worker = yield* makeDrainableWorker(
    (completion: Deferred.Deferred<StorageCleanupReport, ServerSettingsError> | undefined) =>
      sweep(completion === undefined ? "automatic" : "manual").pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          completion === undefined
            ? exit.pipe(
                Effect.asVoid,
                Effect.catchCause((cause) =>
                  Effect.logWarning("storage cleanup failed", { cause }),
                ),
              )
            : Deferred.done(completion, exit).pipe(Effect.asVoid),
        ),
      ),
  );
  const runNow = Effect.gen(function* () {
    const completion = yield* Deferred.make<StorageCleanupReport, ServerSettingsError>();
    yield* worker.enqueue(completion);
    return yield* Deferred.await(completion);
  });

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
  yield* start();
  return StorageCleanup.of({
    runNow,
    latestReport: SubscriptionRef.get(reportRef),
    reports: SubscriptionRef.changes(reportRef),
    drain: worker.drain,
  });
});

export const layer = Layer.effect(StorageCleanup, make);
