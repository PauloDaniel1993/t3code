import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
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

import { buildTaskAgentModel, type TaskAgentModel } from "./taskAgentModel";
import {
  buildTaskAgentListEntries,
  buildNativeAgentRow,
  buildTaskAgentRow,
  buildTaskAgentSurfaceRows,
  taskAgentListPresentationStateEqual,
  taskAgentThreadRowsRenderEqual,
  type TaskAgentSurfaceViewModel,
} from "./taskAgentSurface.logic";
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

function surface(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  lastVisitedAtByThreadId: ReadonlyMap<ThreadId, string> = new Map(),
): TaskAgentSurfaceViewModel {
  return buildTaskAgentSurfaceRows(project(threads, lastVisitedAtByThreadId));
}

function rollup(surfaceModel: TaskAgentSurfaceViewModel, index = 0) {
  const row = surfaceModel.threads[index];
  expect(row?.kind).toBe("rollup-thread");
  if (row?.kind !== "rollup-thread") throw new Error("expected a rollup thread");
  return row;
}

function firstTask(surfaceModel: TaskAgentSurfaceViewModel) {
  const parent = rollup(surfaceModel);
  const task = parent.rollup.tasks[0];
  if (task === undefined) throw new Error("expected a task row");
  return { parent, task };
}

function firstTurn(surfaceModel: TaskAgentSurfaceViewModel) {
  const parent = rollup(surfaceModel);
  const turn = parent.rollup.nativeAgentTurns[0] ?? parent.rollup.tasks[0]?.turns[0];
  if (turn === undefined) throw new Error("expected a turn row");
  return turn;
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

const stateCases = [
  {
    name: "queued has no outcome ratio",
    make: () => {
      const parentId = ThreadId.make("queued-parent");
      return surface([
        makeThread({ id: parentId, title: "Queued parent" }),
        makeTask(parentId, { id: ThreadId.make("queued-task"), status: "queued" }),
      ]);
    },
    assert: (model: TaskAgentSurfaceViewModel) => {
      const { task } = firstTask(model);
      expect(task.status.kind).toBe("queued");
      expect(task.turns).toEqual([]);
    },
  },
  {
    name: "exactly one agent uses singular wording and one-unit counters",
    make: () =>
      surface([
        makeThread({
          id: ThreadId.make("single-parent"),
          title: "Single parent",
          nativeAgents: [makeAgent({ taskId: "one-agent", status: "finished" })],
        }),
      ]),
    assert: (model: TaskAgentSurfaceViewModel) => {
      const parent = rollup(model);
      const turn = firstTurn(model);
      expect(parent.rollup.chipLabel).toBe("1 agent");
      expect(turn.label).toBe("Latest turn · 1 agent");
      expect(turn.outcome).toMatchObject({ kind: "success-only", finishedCount: 1 });
      expect(turn.outcome.counters[0]?.label).toBe("✓ 1");
    },
  },
  {
    name: "zero failures has no failure count or failure styling signal",
    make: () =>
      surface([
        makeThread({
          id: ThreadId.make("success-parent"),
          title: "Success parent",
          nativeAgents: [
            makeAgent({ taskId: "success-a", status: "finished" }),
            makeAgent({ taskId: "success-b", status: "finished", turnId: "turn-1" }),
          ],
        }),
      ]),
    assert: (model: TaskAgentSurfaceViewModel) => {
      const outcome = firstTurn(model).outcome;
      expect(outcome.kind).toBe("success-only");
      expect("failedCount" in outcome).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain("danger");
      expect(JSON.stringify(outcome)).not.toContain("failed");
      expect(firstTurn(model).agents.every((agent) => agent.failure === null)).toBe(true);
    },
  },
  {
    name: "all failed exposes only failures and no partial-success signal",
    make: () =>
      surface([
        makeThread({
          id: ThreadId.make("failed-parent"),
          title: "Failed parent",
          nativeAgents: [
            makeAgent({ taskId: "failed-a", status: "failed", errorMessage: "Budget exceeded" }),
            makeAgent({
              taskId: "failed-b",
              status: "failed",
              errorMessage: "Provider stopped",
              turnId: "turn-1",
            }),
          ],
        }),
      ]),
    assert: (model: TaskAgentSurfaceViewModel) => {
      const outcome = firstTurn(model).outcome;
      expect(outcome.kind).toBe("failure-only");
      if (outcome.kind !== "failure-only") return;
      expect("finishedCount" in outcome).toBe(false);
      expect(outcome.counter.label).toBe("× 2");
      expect(outcome.counter.failures.map((failure) => failure.reason)).toEqual([
        "Budget exceeded",
        "Provider stopped",
      ]);
      expect(firstTurn(model).agents.map((agent) => agent.statusLine)).toEqual([
        expect.stringContaining(" — Budget exceeded"),
        expect.stringContaining(" — Provider stopped"),
      ]);
      expect(JSON.stringify(outcome)).not.toContain("✓ 0");
    },
  },
  {
    name: "cancelled mid-flight is a task state, not an agent failure",
    make: () => {
      const parentId = ThreadId.make("cancelled-parent");
      return surface([
        makeThread({ id: parentId, title: "Cancelled parent" }),
        makeTask(parentId, {
          id: ThreadId.make("cancelled-task"),
          status: "cancelled",
          nativeAgents: [
            makeAgent({ taskId: "finished-before-cancel", status: "finished" }),
            makeAgent({
              taskId: "running-when-cancelled",
              status: "running",
              turnId: "turn-1",
            }),
          ],
        }),
      ]);
    },
    assert: (model: TaskAgentSurfaceViewModel) => {
      const { task } = firstTask(model);
      expect(task.status.kind).toBe("cancelled");
      expect(task.tone).toBe("cancelled");
      expect(task.glyph).toBe("−");
      expect(task.statusLine).toContain("Cancelled — The task was cancelled");
      expect(task.failure).toBeNull();
      const agents = task.turns[0]?.agents ?? [];
      expect(agents.map((agent) => agent.status.kind)).toEqual(["finished", "running"]);
      expect(agents.every((agent) => agent.status.kind !== "failed")).toBe(true);
    },
  },
  {
    name: "returned but unread signals unread on task and parent",
    make: () => {
      const parentId = ThreadId.make("unread-parent");
      const taskId = ThreadId.make("unread-task");
      return surface(
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
          makeTask(parentId, { id: taskId, delivered: true, status: "finished" }),
        ],
        new Map([
          [parentId, requestedAt],
          [taskId, requestedAt],
        ]),
      );
    },
    assert: (model: TaskAgentSurfaceViewModel) => {
      const { parent, task } = firstTask(model);
      expect(parent.unread).toBe(true);
      expect(task.unread).toBe(true);
      expect(task.returnedToParent).toBe(true);
    },
  },
  {
    name: "native in-session agent refuses steering with a reason",
    make: () =>
      surface([
        makeThread({
          id: ThreadId.make("native-parent"),
          title: "Native parent",
          nativeAgents: [makeAgent({ taskId: "native-agent", status: "running" })],
        }),
      ]),
    assert: (model: TaskAgentSurfaceViewModel) => {
      const agent = firstTurn(model).agents[0];
      expect(agent?.kind).toBe("native-agent");
      expect(agent?.steering.kind).toBe("unavailable");
      if (agent?.steering.kind === "unavailable") {
        expect(agent.steering.reason).toBe(NATIVE_AGENT_NOT_STEERABLE_REASON);
        expect(agent.steering.reason.trim()).not.toBe("");
      }
      const navigation = agent?.navigation;
      expect(navigation && "kind" in navigation ? navigation.kind : undefined).toBe("unavailable");
      if (navigation !== undefined && "reason" in navigation) {
        expect(navigation.reason.trim()).not.toBe("");
      }
    },
  },
] as const;

describe("task-agent surface row honesty", () => {
  it.each(stateCases)("$name", ({ make, assert }) => {
    const model = make();
    assert(model);
    expect(collectStrings(model).some((value) => /\b0 of 0\b/.test(value))).toBe(false);
  });
});

describe("task-agent surface hierarchy", () => {
  it("keeps a thread that owns nothing as a plain thread without a rollup", () => {
    const model = surface([makeThread({ id: ThreadId.make("plain"), title: "Plain thread" })]);
    const row = model.threads[0];

    expect(row).toEqual({
      kind: "plain-thread",
      key: `${environmentId}:plain`,
      thread: expect.objectContaining({ id: ThreadId.make("plain") }),
      unread: false,
    });
    expect(row && "rollup" in row).toBe(false);
  });

  it("keeps tasks under a thread and agents under their turn", () => {
    const parentId = ThreadId.make("hierarchy-parent");
    const model = surface([
      makeThread({
        id: parentId,
        title: "Parent",
        nativeAgents: [makeAgent({ taskId: "parent-agent", status: "running" })],
      }),
      makeTask(parentId, {
        id: ThreadId.make("child-task"),
        nativeAgents: [
          makeAgent({ taskId: "task-agent", turnId: "task-turn", status: "finished" }),
        ],
      }),
    ]);

    const parent = rollup(model);
    expect(parent.rollup.tasks).toHaveLength(1);
    expect(parent.rollup.nativeAgentTurns).toHaveLength(1);
    expect(parent.rollup.nativeAgentTurns[0]?.agents[0]?.id).toBe("parent-agent");
    expect(parent.rollup.tasks[0]?.turns[0]?.agents[0]?.id).toBe("task-agent");
    expect(parent.rollup.tasks[0]?.turns[0]?.turnId).toBe("task-turn");
  });

  it("flattens tasks, turns, and agents into stable nesting without changing row anatomy", () => {
    const parentId = ThreadId.make("list-parent");
    const model = surface([
      makeThread({
        id: parentId,
        title: "List parent",
        nativeAgents: [makeAgent({ taskId: "parent-agent", status: "running" })],
      }),
      makeTask(parentId, {
        id: ThreadId.make("list-task"),
        nativeAgents: [
          makeAgent({ taskId: "task-agent", turnId: "task-turn", status: "finished" }),
        ],
      }),
    ]);
    const parent = rollup(model);
    const taskTurn = parent.rollup.tasks[0]?.turns[0];
    const parentTurn = parent.rollup.nativeAgentTurns[0];
    if (taskTurn === undefined || parentTurn === undefined) throw new Error("expected turns");

    const entries = buildTaskAgentListEntries(
      parent,
      new Map([
        [taskTurn.key, true],
        [parentTurn.key, true],
      ]),
    );

    expect(
      entries.map((entry) => [
        entry.kind,
        entry.nestingLevel,
        entry.kind === "entity-row" ? entry.row.kind : entry.turn.kind,
      ]),
    ).toEqual([
      ["entity-row", 0, "task"],
      ["turn-row", 1, "native-agent-turn"],
      ["entity-row", 2, "native-agent"],
      ["turn-row", 0, "native-agent-turn"],
      ["entity-row", 1, "native-agent"],
    ]);
    expect(buildTaskAgentListEntries(parent, new Map()).map((entry) => entry.key)).toEqual(
      buildTaskAgentListEntries(parent, new Map()).map((entry) => entry.key),
    );
  });

  it("keeps agents behind a collapsed turn while leaving its projected rollup reachable", () => {
    const model = surface([
      makeThread({
        id: ThreadId.make("collapsed-turn-parent"),
        title: "Collapsed turn parent",
        nativeAgents: [makeAgent({ taskId: "hidden-agent", status: "failed" })],
      }),
    ]);
    const parent = rollup(model);
    const turn = parent.rollup.nativeAgentTurns[0];
    if (turn === undefined) throw new Error("expected turn");

    const entries = buildTaskAgentListEntries(parent, new Map([[turn.key, false]]));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "turn-row",
      expanded: false,
      turn: { outcome: { kind: "failure-only", counter: { label: "× 1" } } },
    });
  });

  it("invalidates render equality for unread and projected-row changes", () => {
    const parentId = ThreadId.make("memo-parent");
    const parent = rollup(
      surface([
        makeThread({ id: parentId, title: "Memo parent" }),
        makeTask(parentId, { id: ThreadId.make("memo-task") }),
      ]),
    );
    const sameRenderData = { ...parent, rollup: { ...parent.rollup } };
    const unreadChanged = { ...parent, unread: !parent.unread };
    const projectedRowsChanged = {
      ...parent,
      rollup: { ...parent.rollup, tasks: [...parent.rollup.tasks] },
    };

    expect(taskAgentThreadRowsRenderEqual(parent, sameRenderData)).toBe(true);
    expect(taskAgentThreadRowsRenderEqual(parent, unreadChanged)).toBe(false);
    expect(taskAgentThreadRowsRenderEqual(parent, projectedRowsChanged)).toBe(false);
    expect(
      taskAgentListPresentationStateEqual(
        { row: parent, expanded: false },
        { row: sameRenderData, expanded: false },
      ),
    ).toBe(true);
    expect(
      taskAgentListPresentationStateEqual(
        { row: parent, expanded: false },
        { row: parent, expanded: true },
      ),
    ).toBe(false);
  });
});

describe("task-agent row anatomy", () => {
  it("gives task and native-agent rows the identical structural shape", () => {
    const parentId = ThreadId.make("shape-parent");
    const taskProjection = project([
      makeThread({ id: parentId, title: "Shape parent" }),
      makeTask(parentId, { id: ThreadId.make("shape-task"), status: "finished" }),
    ]).threads[0];
    const agentModel = project([
      makeThread({
        id: ThreadId.make("agent-parent"),
        title: "Agent parent",
        nativeAgents: [makeAgent({ taskId: "shape-agent", status: "running" })],
      }),
    ]);

    if (taskProjection?.kind !== "rollup-thread") throw new Error("expected task rollup");
    const taskProjectionRow = taskProjection.rollup.tasks[0];
    const turnProjection = agentModel.threads[0];
    if (taskProjectionRow === undefined || turnProjection?.kind !== "rollup-thread") {
      throw new Error("expected projections");
    }
    const turn = turnProjection.rollup.nativeAgentTurns[0];
    const agentProjection = turn?.agents[0];
    if (turn === undefined || agentProjection === undefined) throw new Error("expected agent");

    const taskRow = buildTaskAgentRow({
      projection: taskProjectionRow,
      unread: taskProjectionRow.hasUnreadTaskResults,
    });
    const agentRow = buildNativeAgentRow({
      projection: agentProjection,
      turn,
      unread: false,
    });

    expect(Object.keys(taskRow).sort()).toEqual(Object.keys(agentRow).sort());
    expect(taskRow.kind).toBe("task");
    expect(agentRow.kind).toBe("native-agent");
    expect(taskRow.nativeAgent).toBeNull();
    expect(agentRow.nativeAgent).toBe(agentProjection);
  });
});
