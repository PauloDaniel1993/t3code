import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { groupNativeAgentsByTurn } from "@t3tools/client-runtime/state/native-agents";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ThreadNativeAgent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  NATIVE_AGENT_WINDOW,
  buildTaskAgentModel,
  type NativeAgentOutcomeRollup,
  type TaskAgentModel,
} from "./taskAgentModel";
import { NATIVE_AGENT_NOT_STEERABLE_REASON } from "./taskAgentNavigation";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const nowMs = Date.parse("2026-07-29T10:10:00.000Z");
const requestedAt = "2026-07-29T10:00:00.000Z";
const deliveredAt = "2026-07-29T10:05:00.000Z";

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return {
    environmentId,
    projectId,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "dev",
    worktreePath: null,
    latestTurn: null,
    createdAt: requestedAt,
    updatedAt: requestedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

function makeTask(
  parentThreadId: ThreadId,
  input: {
    readonly id: ThreadId;
    readonly title?: string;
    readonly status?: "queued" | "running" | "finished" | "failed" | "cancelled";
    readonly delivered?: boolean;
    readonly nativeAgents?: ReadonlyArray<ThreadNativeAgent>;
    readonly taskSummary?: EnvironmentThreadShell["taskSummary"];
  },
): EnvironmentThreadShell {
  const status = input.status ?? "finished";
  const terminal = status === "finished" || status === "failed" || status === "cancelled";
  const delivery = input.delivered ? { state: "delivered" as const, updatedAt: deliveredAt } : null;
  return makeThread({
    id: input.id,
    title: input.title ?? "Task",
    parentThreadId,
    task: {
      parentThreadId,
      title: input.title ?? "Task",
      prompt: "Do the task",
      context: { kind: "none" },
      contextTruncated: false,
      createdBy: "agent",
      status,
      requestedAt,
      startedAt: status === "queued" ? null : requestedAt,
      finishedAt: terminal ? deliveredAt : null,
      result: terminal
        ? {
            outcome:
              status === "finished" ? "succeeded" : status === "failed" ? "failed" : "cancelled",
            summary: status === "failed" ? "Task failure reason" : "Task result",
            summaryTruncated: false,
            assistantMessageId: MessageId.make(`result-${input.id}`),
            completedAt: deliveredAt,
          }
        : null,
      delivery,
    },
    taskSummary: input.taskSummary,
    nativeAgents: input.nativeAgents,
  });
}

function makeAgent(
  input: Omit<Partial<ThreadNativeAgent>, "taskId" | "turnId" | "status"> & {
    readonly taskId: string;
    readonly status?: "running" | "finished" | "failed";
    readonly turnId?: string | null;
  },
): ThreadNativeAgent {
  const { status, taskId, turnId, ...rest } = input;
  return {
    taskId,
    turnId: turnId === undefined ? TurnId.make("turn-1") : turnId,
    status: status ?? "running",
    description: rest.description ?? taskId,
    startedAt: rest.startedAt ?? requestedAt,
    updatedAt: rest.updatedAt ?? requestedAt,
    ...rest,
  } as ThreadNativeAgent;
}

function project(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  lastVisitedAtByThreadId: ReadonlyMap<ThreadId, string> = new Map(),
): TaskAgentModel {
  return buildTaskAgentModel({
    threads,
    nowMs,
    readState: { lastVisitedAtByThreadId },
  });
}

function rollup(model: TaskAgentModel, index = 0) {
  const row = model.threads[index];
  expect(row?.kind).toBe("rollup-thread");
  if (row?.kind !== "rollup-thread") throw new Error("expected a rollup thread");
  return row;
}

function firstTask(model: TaskAgentModel) {
  const parent = rollup(model);
  const task = parent.rollup.tasks[0];
  if (task === undefined) throw new Error("expected a task");
  return { parent, task };
}

function firstTurn(model: TaskAgentModel) {
  const parent = rollup(model);
  const turn = parent.rollup.nativeAgentTurns[0] ?? parent.rollup.tasks[0]?.nativeAgentTurns[0];
  if (turn === undefined) throw new Error("expected a native-agent turn");
  return turn;
}

function outcomeCounts(outcome: NativeAgentOutcomeRollup) {
  return {
    runningCount: "runningCount" in outcome ? outcome.runningCount : 0,
    finishedCount:
      outcome.kind === "success-only" || outcome.kind === "mixed" ? outcome.finishedCount : 0,
    failedCount:
      outcome.kind === "failure-only" || outcome.kind === "mixed" ? outcome.failedCount : 0,
  };
}

function collectStrings(value: unknown, result: string[] = []): string[] {
  if (typeof value === "string") {
    result.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, result);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, result);
  }
  return result;
}

const emptyThread = () => makeThread({ id: ThreadId.make("plain"), title: "Plain thread" });

const honestyCases = [
  {
    name: "queued / nothing started has no outcome ratio",
    make: () => {
      const parentId = ThreadId.make("queued-parent");
      return project([
        makeThread({ id: parentId, title: "Queued parent" }),
        makeTask(parentId, { id: ThreadId.make("queued-task"), status: "queued" }),
      ]);
    },
    assert: (model: TaskAgentModel) => {
      const { task } = firstTask(model);
      expect(task.status.kind).toBe("queued");
      expect(task.nativeAgentTurns).toEqual([]);
      expect(JSON.stringify(model)).not.toMatch(/\b0 of 0\b/);
    },
  },
  {
    name: "exactly one agent stays singular and counts one unit",
    make: () => {
      const agent = makeAgent({ taskId: "one-agent", status: "finished" });
      return project([
        makeThread({
          id: ThreadId.make("single-parent"),
          title: "Single parent",
          nativeAgents: [agent],
        }),
      ]);
    },
    assert: (model: TaskAgentModel) => {
      const parent = rollup(model);
      const turn = firstTurn(model);
      expect(parent.rollup.chipLabel).toBe("1 agent");
      expect(turn.label).toBe("Latest turn · 1 agent");
      expect(turn.outcome).toMatchObject({ kind: "success-only", finishedCount: 1 });
      expect(turn.outcome.counters[0]?.label).toBe("✓ 1");
    },
  },
  {
    name: "zero failures has no failure count or failure styling",
    make: () => {
      const agents = [
        makeAgent({ taskId: "success-a", status: "finished" }),
        makeAgent({ taskId: "success-b", status: "finished", turnId: "turn-1" }),
      ];
      return project([
        makeThread({
          id: ThreadId.make("success-parent"),
          title: "Success parent",
          nativeAgents: agents,
        }),
      ]);
    },
    assert: (model: TaskAgentModel) => {
      const outcome = firstTurn(model).outcome;
      expect(outcome.kind).toBe("success-only");
      expect("failedCount" in outcome).toBe(false);
      expect("counter" in outcome && outcome.counter.kind).toBe("finished");
      expect(JSON.stringify(outcome)).not.toContain("danger");
      expect(JSON.stringify(outcome)).not.toContain("failed");
    },
  },
  {
    name: "all failed exposes only failures and never implies partial success",
    make: () => {
      const agents = [
        makeAgent({ taskId: "failed-a", status: "failed", errorMessage: "Budget exceeded" }),
        makeAgent({ taskId: "failed-b", status: "failed", errorMessage: "Provider stopped" }),
      ];
      return project([
        makeThread({
          id: ThreadId.make("failed-parent"),
          title: "Failed parent",
          nativeAgents: agents,
        }),
      ]);
    },
    assert: (model: TaskAgentModel) => {
      const outcome = firstTurn(model).outcome;
      expect(outcome.kind).toBe("failure-only");
      expect("finishedCount" in outcome).toBe(false);
      if (outcome.kind !== "failure-only") return;
      expect(outcome.counter.label).toBe("× 2");
      expect(outcome.counter.failures.map((failure) => failure.reason)).toEqual([
        "Budget exceeded",
        "Provider stopped",
      ]);
      expect(JSON.stringify(outcome)).not.toContain("✓ 0");
    },
  },
  {
    name: "cancelled task is not a failed task",
    make: () => {
      const parentId = ThreadId.make("cancelled-parent");
      return project([
        makeThread({ id: parentId, title: "Cancelled parent" }),
        makeTask(parentId, {
          id: ThreadId.make("cancelled-task"),
          status: "cancelled",
          nativeAgents: [makeAgent({ taskId: "still-finished", status: "finished" })],
        }),
      ]);
    },
    assert: (model: TaskAgentModel) => {
      const { task } = firstTask(model);
      expect(task.status.kind).toBe("cancelled");
      expect(task.status.tone).toBe("cancelled");
      if (task.status.kind !== "cancelled") return;
      expect(task.status.reason).toContain("cancelled");
      expect(task.steering.kind).toBe("unavailable");
      if (task.steering.kind === "unavailable") {
        expect(task.steering.reason).toContain("cancelled");
        expect(task.steering.reason).not.toContain("failed");
      }
      expect(task.nativeAgentTurns[0]?.outcome.kind).toBe("success-only");
    },
  },
  {
    name: "returned unread is marked on both task and parent",
    make: () => {
      const parentId = ThreadId.make("unread-parent");
      const taskId = ThreadId.make("unread-task");
      return project(
        [
          makeThread({
            id: parentId,
            title: "Unread parent",
            taskSummary: {
              total: 1,
              running: 0,
              latestResultAt: deliveredAt,
              latestDeliveredAt: deliveredAt,
            },
          }),
          makeTask(parentId, {
            id: taskId,
            delivered: true,
            status: "finished",
          }),
        ],
        new Map([
          [parentId, requestedAt],
          [taskId, requestedAt],
        ]),
      );
    },
    assert: (model: TaskAgentModel) => {
      const { parent, task } = firstTask(model);
      expect(parent.hasUnreadTaskResults).toBe(true);
      expect(task.hasUnreadTaskResults).toBe(true);
      expect(task.returnedToParent).toBe(true);
    },
  },
  {
    name: "a read result is no longer marked unread on task or parent",
    make: () => {
      const parentId = ThreadId.make("read-parent");
      const taskId = ThreadId.make("read-task");
      return project(
        [
          makeThread({
            id: parentId,
            title: "Read parent",
            taskSummary: {
              total: 1,
              running: 0,
              latestResultAt: deliveredAt,
              latestDeliveredAt: deliveredAt,
            },
          }),
          makeTask(parentId, {
            id: taskId,
            delivered: true,
            status: "finished",
          }),
        ],
        new Map([
          [parentId, deliveredAt],
          [taskId, deliveredAt],
        ]),
      );
    },
    assert: (model: TaskAgentModel) => {
      const { parent, task } = firstTask(model);
      expect(parent.hasUnreadTaskResults).toBe(false);
      expect(task.hasUnreadTaskResults).toBe(false);
    },
  },
  {
    name: "native in-session agent is not steerable with a reason",
    make: () =>
      project([
        makeThread({
          id: ThreadId.make("native-parent"),
          title: "Native parent",
          nativeAgents: [makeAgent({ taskId: "native-agent", status: "running" })],
        }),
      ]),
    assert: (model: TaskAgentModel) => {
      const agent = firstTurn(model).agents[0];
      expect(agent?.steering.kind).toBe("unavailable");
      if (agent?.steering.kind === "unavailable") {
        expect(agent.steering.reason).toBe(NATIVE_AGENT_NOT_STEERABLE_REASON);
        expect(agent.steering.reason.trim()).not.toBe("");
      }
    },
  },
] as const;

describe("task-agent model honesty states", () => {
  it.each(honestyCases)("$name", ({ make, assert }) => {
    const model = make();
    assert(model);
    expect(collectStrings(model).some((value) => /\b0 of 0\b/.test(value))).toBe(false);
  });
});

describe("task-agent model hierarchy", () => {
  it("keeps a thread that owns nothing as an ordinary row with no rollup", () => {
    const model = project([emptyThread()]);
    const row = model.threads[0];

    expect(row).toMatchObject({ kind: "plain-thread", hasUnreadTaskResults: false });
    expect(row && "rollup" in row).toBe(false);
  });

  it("nests tasks under their parent and keeps agents under their turn", () => {
    const parentId = ThreadId.make("hierarchy-parent");
    const taskAgent = makeAgent({ taskId: "task-agent", turnId: "task-turn", status: "finished" });
    const parentAgent = makeAgent({
      taskId: "parent-agent",
      turnId: "parent-turn",
      status: "running",
    });
    const model = project([
      makeThread({ id: parentId, title: "Parent", nativeAgents: [parentAgent] }),
      makeTask(parentId, {
        id: ThreadId.make("child-task"),
        nativeAgents: [taskAgent],
      }),
    ]);

    const parent = rollup(model);
    expect(parent.rollup.tasks).toHaveLength(1);
    expect(parent.rollup.nativeAgentTurns).toHaveLength(1);
    expect(parent.rollup.nativeAgentTurns[0]?.agents[0]?.id).toBe("parent-agent");
    expect(parent.rollup.tasks[0]?.nativeAgentTurns[0]?.agents[0]?.id).toBe("task-agent");
    expect(parent.rollup.tasks[0]?.nativeAgentTurns[0]?.turnId).toBe("task-turn");
  });

  it("degrades an agent group with no recognized outcome without inventing counts", () => {
    const malformedAgent = makeAgent({
      taskId: "unrecognized-agent",
      status: "paused" as never,
    });

    const model = project([
      makeThread({
        id: ThreadId.make("unrecognized-parent"),
        title: "Unrecognized parent",
        nativeAgents: [malformedAgent],
      }),
    ]);
    const turn = firstTurn(model);

    expect(turn.outcome).toEqual({
      kind: "outcome-unavailable",
      label: "Outcome unavailable",
      reason: "No recognized agent outcome was reported.",
      counters: [],
    });
    expect("totalCount" in turn.outcome).toBe(false);
    expect("runningCount" in turn.outcome).toBe(false);
    expect(JSON.stringify(turn.outcome)).not.toMatch(/success|failed|danger/i);
    expect(turn.agents[0]?.status).toEqual({
      kind: "unavailable",
      label: "Status unavailable",
      tone: "neutral",
      reason: "The agent reported an unrecognized outcome status.",
    });
    expect(turn.agents[0]?.statusLine).toBe("Outcome unavailable");
    expect(turn.agents[0]?.body).toEqual({ tone: "pending", text: "Outcome unavailable." });
  });
});

describe("task-agent model shared-rule parity", () => {
  it("matches groupNativeAgentsByTurn for every running/finished/failed count", () => {
    const agents = [
      makeAgent({
        taskId: "old-finished",
        turnId: "old-turn",
        status: "finished",
        updatedAt: "2026-07-29T10:01:00.000Z",
      }),
      makeAgent({
        taskId: "old-failed",
        turnId: "old-turn",
        status: "failed",
        updatedAt: "2026-07-29T10:02:00.000Z",
      }),
      makeAgent({
        taskId: "latest-running",
        turnId: "latest-turn",
        status: "running",
        updatedAt: "2026-07-29T10:09:00.000Z",
      }),
    ];
    const expected = groupNativeAgentsByTurn(agents);
    const model = project([
      makeThread({
        id: ThreadId.make("parity-parent"),
        title: "Parity parent",
        nativeAgents: agents,
      }),
    ]);
    const actual = rollup(model).rollup.nativeAgentTurns;

    expect(actual.map((turn) => turn.turnId)).toEqual(expected.map((group) => group.turnId));
    expect(actual.map((turn) => outcomeCounts(turn.outcome))).toEqual(
      expected.map((group) => ({
        runningCount: group.runningCount,
        finishedCount: group.finishedCount,
        failedCount: group.failedCount,
      })),
    );
  });
});

describe("task-agent model failure attribution", () => {
  it("gives every failed agent a non-empty reason, including missing provider text", () => {
    const agents = [
      makeAgent({ taskId: "reasoned", status: "failed", errorMessage: "Tool budget exceeded" }),
      makeAgent({ taskId: "unattributed", status: "failed", errorMessage: "   " }),
    ];
    const model = project([
      makeThread({
        id: ThreadId.make("reason-parent"),
        title: "Reason parent",
        nativeAgents: agents,
      }),
    ]);
    const turn = firstTurn(model);

    for (const agent of turn.agents) {
      expect(agent.status.kind).toBe("failed");
      if (agent.status.kind === "failed") {
        expect(agent.status.failure.reason.trim()).not.toBe("");
      }
    }
    expect(turn.outcome.kind).toBe("failure-only");
    if (turn.outcome.kind === "failure-only") {
      expect(turn.outcome.counter.failures).toHaveLength(2);
      expect(turn.outcome.counter.failures[1]?.reason).toBe(
        "The agent failed without reporting a reason.",
      );
    }
  });
});

describe("task-agent model bounded window and no impossible ratio", () => {
  it("uses bounded latest/relative turn wording and never emits 0 of 0", () => {
    const agents = [
      makeAgent({
        taskId: "earlier",
        turnId: "earlier-turn",
        status: "finished",
        updatedAt: "2026-07-29T10:01:00.000Z",
      }),
      makeAgent({
        taskId: "latest",
        turnId: "latest-turn",
        status: "finished",
        updatedAt: "2026-07-29T10:09:00.000Z",
      }),
    ];
    const model = project([
      makeThread({
        id: ThreadId.make("bounded-parent"),
        title: "Bounded parent",
        nativeAgents: agents,
      }),
      emptyThread(),
    ]);
    const parent = rollup(model);

    expect(model.nativeAgentWindow).toEqual(NATIVE_AGENT_WINDOW);
    expect(parent.rollup.nativeAgentTurns.map((turn) => turn.label)).toEqual([
      "9m ago · 1 agent",
      "Latest turn · 1 agent",
    ]);
    expect(collectStrings(model).some((value) => /\b0 of 0\b/.test(value))).toBe(false);
  });
});
