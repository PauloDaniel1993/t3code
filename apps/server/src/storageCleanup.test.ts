import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  storageCleanupActivityAt,
  storageCleanupCandidates,
  storageCleanupThreadIdle,
} from "./storageCleanup.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), activeRunId: RunId.make("run") }, NOW_MS),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), latestUserMessageAt: at(-1_000) }, NOW_MS),
    ).toBe(false);
  });

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

describe("V2 storage cleanup candidates", () => {
  const projects = [{ id: ProjectId.make("project-1"), workspaceRoot: "/repo" }];
  const set = [
    { repositoryRoot: "/api", path: "/worktrees/s/api", branch: "feature" },
    { repositoryRoot: "/web", path: "/worktrees/s/web", branch: "feature" },
  ];
  const thread = (id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
    shell({ id: ThreadId.make(id), branch: "feature", ...overrides });

  it("takes a set whole, each member from its own checkout, and a lone worktree from its project", () => {
    const candidates = storageCleanupCandidates({
      threads: [
        thread("set", { worktreePath: "/worktrees/s/api", worktrees: set }),
        thread("plain", { worktreePath: "/worktrees/plain" }),
        thread("in-place"),
      ],
      deletedThreads: [],
      projects,
    });
    expect(candidates.map((candidate) => [candidate.thread.id, candidate.worktrees])).toEqual([
      ["set", set],
      ["plain", [{ repositoryRoot: "/repo", path: "/worktrees/plain", branch: "feature" }]],
    ]);
  });

  it("leaves a set whose members nest for explicit removal", () => {
    const nested = [
      { repositoryRoot: "/parent", path: "/worktrees/s", branch: "feature" },
      { repositoryRoot: "/child", path: "/worktrees/s/libs/child", branch: "feature" },
    ];
    const candidates = storageCleanupCandidates({
      threads: [thread("nested", { worktreePath: "/worktrees/s", worktrees: nested })],
      deletedThreads: [],
      projects,
    });
    expect(candidates).toEqual([]);
  });

  it("keeps a set while any other thread, archived or deleted, could still need a member", () => {
    const candidates = storageCleanupCandidates({
      threads: [
        thread("set", { worktreePath: "/worktrees/s/api", worktrees: set }),
        // An archived fork of the set's thread shares its whole set.
        thread("archived-fork", {
          worktreePath: "/worktrees/s/api",
          worktrees: set,
          archivedAt: at(-DAY_MS),
        }),
      ],
      deletedThreads: [
        { ...thread("deleted", { worktreePath: "/worktrees/s/web" }), workspaceRoot: "/repo" },
      ],
      projects,
    });
    expect(candidates).toEqual([]);
  });
});
