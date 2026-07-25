import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadTaskMetadata,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-07-25T00:00:00.000Z";
const PARENT = ThreadId.make("parent-1");
const TASK = ThreadId.make("task-1");

function thread(overrides: Partial<OrchestrationThread> & { id: ThreadId }): OrchestrationThread {
  return {
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } as OrchestrationThread;
}

function readModel(threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel {
  return { snapshotSequence: 0, projects: [], threads, updatedAt: NOW };
}

const task = (overrides: Partial<ThreadTaskMetadata> = {}): ThreadTaskMetadata =>
  ({
    parentThreadId: PARENT,
    title: "Inventory handlers",
    prompt: "List every handler.",
    context: { kind: "full-thread" },
    contextTruncated: false,
    createdBy: "agent",
    status: "running",
    requestedAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    result: null,
    delivery: null,
    ...overrides,
  }) as ThreadTaskMetadata;

const decide = (
  command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
  model: OrchestrationReadModel,
) =>
  decideOrchestrationCommand({ command, readModel: model }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
    Effect.provide(NodeServices.layer),
  );

const createCommand = {
  type: "thread.task.create",
  commandId: CommandId.make("cmd-1"),
  parentThreadId: PARENT,
  taskThreadId: TASK,
  title: "Inventory handlers",
  prompt: "List every handler.",
  context: { kind: "full-thread" },
  createdBy: "agent",
  createdAt: NOW,
} as const;

it.effect("creates the task thread, links it, and starts its first turn", () =>
  Effect.gen(function* () {
    const events = yield* decide(createCommand, readModel([thread({ id: PARENT })]));
    const types = events.map((event) => event.type);

    expect(types).toContain("thread.created");
    expect(types).toContain("thread.task-created");
    expect(types).toContain("thread.message-sent");
    expect(types).toContain("thread.turn-start-requested");

    const created = events.find((event) => event.type === "thread.task-created");
    expect(created?.aggregateId).toBe(TASK);
    expect((created?.payload as { parentThreadId: ThreadId }).parentThreadId).toBe(PARENT);
    expect((created?.payload as { status: string }).status).toBe("queued");

    // The parent gets a timeline row even though it does not own the aggregate.
    const activity = events.find(
      (event) => event.type === "thread.activity-appended" && event.aggregateId === PARENT,
    );
    expect((activity?.payload as { activity: { kind: string } }).activity.kind).toBe(
      "task.created",
    );
  }),
);

it.effect("inherits the parent's execution surface", () =>
  Effect.gen(function* () {
    const events = yield* decide(
      createCommand,
      readModel([
        thread({
          id: PARENT,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          branch: "feature/x",
          worktreePath: "/tmp/wt",
        }),
      ]),
    );
    const created = events.find((event) => event.type === "thread.created");
    expect(created?.payload).toMatchObject({
      runtimeMode: "approval-required",
      interactionMode: "plan",
      branch: "feature/x",
      worktreePath: "/tmp/wt",
      projectId: ProjectId.make("project-1"),
    });
  }),
);

it.effect("rejects nesting beyond one level", () =>
  Effect.gen(function* () {
    const result = yield* decide(
      createCommand,
      readModel([thread({ id: PARENT, parentThreadId: ThreadId.make("grandparent") })]),
    ).pipe(Effect.flip);
    expect(result._tag).toBe("OrchestrationCommandInvariantError");
  }),
);

it.effect("rejects creation on an archived parent", () =>
  Effect.gen(function* () {
    const result = yield* decide(
      createCommand,
      readModel([thread({ id: PARENT, archivedAt: NOW })]),
    ).pipe(Effect.flip);
    expect(result._tag).toBe("OrchestrationCommandInvariantError");
  }),
);

it.effect("rejects a task thread id that already exists", () =>
  Effect.gen(function* () {
    const result = yield* decide(
      createCommand,
      readModel([thread({ id: PARENT }), thread({ id: TASK })]),
    ).pipe(Effect.flip);
    expect(result._tag).toBe("OrchestrationCommandInvariantError");
  }),
);

it.effect("rejects creation once five tasks are in flight", () =>
  Effect.gen(function* () {
    const running = Array.from({ length: 5 }, (_, index) =>
      thread({
        id: ThreadId.make(`running-${index}`),
        parentThreadId: PARENT,
        task: task({ status: "running" }),
      }),
    );
    const result = yield* decide(
      createCommand,
      readModel([thread({ id: PARENT }), ...running]),
    ).pipe(Effect.flip);
    expect(result._tag).toBe("OrchestrationCommandInvariantError");
  }),
);

it.effect("cancels a running task and interrupts its turn", () =>
  Effect.gen(function* () {
    const events = yield* decide(
      {
        type: "thread.task.cancel",
        commandId: CommandId.make("cmd-2"),
        parentThreadId: PARENT,
        taskThreadId: TASK,
        createdAt: NOW,
      },
      readModel([
        thread({ id: PARENT }),
        thread({
          id: TASK,
          parentThreadId: PARENT,
          task: task(),
          latestTurn: {
            turnId: "turn-1",
            state: "running",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: null,
            assistantMessageId: null,
          } as OrchestrationThread["latestTurn"],
        }),
      ]),
    );
    const types = events.map((event) => event.type);
    expect(types).toContain("thread.turn-interrupt-requested");
    const updated = events.find((event) => event.type === "thread.task-updated");
    expect((updated?.payload as { status: string }).status).toBe("cancelled");
  }),
);

it.effect("treats cancelling an already-finished task as a no-op", () =>
  Effect.gen(function* () {
    const events = yield* decide(
      {
        type: "thread.task.cancel",
        commandId: CommandId.make("cmd-3"),
        parentThreadId: PARENT,
        taskThreadId: TASK,
        createdAt: NOW,
      },
      readModel([
        thread({ id: PARENT }),
        thread({ id: TASK, parentThreadId: PARENT, task: task({ status: "finished" }) }),
      ]),
    );
    expect(events).toEqual([]);
  }),
);

it.effect("records a result with delivery pending so a crash retries only the delivery", () =>
  Effect.gen(function* () {
    const events = yield* decide(
      {
        type: "thread.task.finish",
        commandId: CommandId.make("cmd-4"),
        parentThreadId: PARENT,
        taskThreadId: TASK,
        status: "finished",
        result: {
          outcome: "succeeded",
          summary: "4 findings",
          summaryTruncated: false,
          assistantMessageId: null,
          completedAt: NOW,
        },
        createdAt: NOW,
      },
      readModel([
        thread({ id: PARENT }),
        thread({ id: TASK, parentThreadId: PARENT, task: task() }),
      ]),
    );
    const finished = events.find((event) => event.type === "thread.task-finished");
    expect((finished?.payload as { delivery: { state: string } }).delivery.state).toBe("pending");
  }),
);

it.effect("rejects a second result recording for the same task", () =>
  Effect.gen(function* () {
    const events = yield* decide(
      {
        type: "thread.task.finish",
        commandId: CommandId.make("cmd-5"),
        parentThreadId: PARENT,
        taskThreadId: TASK,
        status: "finished",
        result: {
          outcome: "succeeded",
          summary: "again",
          summaryTruncated: false,
          assistantMessageId: null,
          completedAt: NOW,
        },
        createdAt: NOW,
      },
      readModel([
        thread({ id: PARENT }),
        thread({
          id: TASK,
          parentThreadId: PARENT,
          task: task({
            status: "finished",
            result: {
              outcome: "succeeded",
              summary: "4 findings",
              summaryTruncated: false,
              assistantMessageId: null,
              completedAt: NOW,
            },
          }),
        }),
      ]),
    );
    expect(events).toEqual([]);
  }),
);

it.effect("emits the parent wake-up row only once delivery settles", () =>
  Effect.gen(function* () {
    const withResult = thread({
      id: TASK,
      parentThreadId: PARENT,
      task: task({
        status: "finished",
        result: {
          outcome: "succeeded",
          summary: "4 findings",
          summaryTruncated: false,
          assistantMessageId: null,
          completedAt: NOW,
        },
        delivery: { state: "pending", updatedAt: NOW },
      }),
    });

    const pending = yield* decide(
      {
        type: "thread.task.delivery.set",
        commandId: CommandId.make("cmd-6"),
        parentThreadId: PARENT,
        taskThreadId: TASK,
        delivery: { state: "pending", updatedAt: NOW },
        createdAt: NOW,
      },
      readModel([thread({ id: PARENT }), withResult]),
    );
    expect(pending.map((event) => event.type)).toEqual(["thread.task-updated"]);

    const delivered = yield* decide(
      {
        type: "thread.task.delivery.set",
        commandId: CommandId.make("cmd-7"),
        parentThreadId: PARENT,
        taskThreadId: TASK,
        delivery: { state: "delivered", updatedAt: NOW },
        createdAt: NOW,
      },
      readModel([thread({ id: PARENT }), withResult]),
    );
    const row = delivered.find(
      (event: Omit<OrchestrationEvent, "sequence">) =>
        event.type === "thread.activity-appended" && event.aggregateId === PARENT,
    );
    expect((row?.payload as { activity: { kind: string; tone: string } }).activity).toMatchObject({
      kind: "task.finished",
      tone: "info",
    });
  }),
);

it.effect("cancels running tasks and archives them with the parent", () =>
  Effect.gen(function* () {
    const events = yield* decide(
      { type: "thread.archive", commandId: CommandId.make("cmd-8"), threadId: PARENT },
      readModel([
        thread({ id: PARENT }),
        thread({ id: TASK, parentThreadId: PARENT, task: task({ status: "running" }) }),
      ]),
    );
    const types = events.map((event) => event.type);
    expect(types).toContain("thread.task-updated");
    // Both the task and the parent end up archived, and the expansion stops.
    expect(
      events.filter((event) => event.type === "thread.archived").map((e) => e.aggregateId),
    ).toEqual([TASK, PARENT]);
  }),
);

it.effect("cascades deletion to task threads", () =>
  Effect.gen(function* () {
    const events = yield* decide(
      { type: "thread.delete", commandId: CommandId.make("cmd-9"), threadId: PARENT },
      readModel([
        thread({ id: PARENT }),
        thread({ id: TASK, parentThreadId: PARENT, task: task() }),
      ]),
    );
    expect(
      events.filter((event) => event.type === "thread.deleted").map((e) => e.aggregateId),
    ).toEqual([TASK, PARENT]);
  }),
);

it.effect("leaves tasks running when the parent settles", () =>
  Effect.gen(function* () {
    const events = yield* decide(
      { type: "thread.settle", commandId: CommandId.make("cmd-10"), threadId: PARENT },
      readModel([
        thread({ id: PARENT }),
        thread({ id: TASK, parentThreadId: PARENT, task: task({ status: "running" }) }),
      ]),
    );
    expect(events.map((event) => event.type)).not.toContain("thread.task-updated");
  }),
);
