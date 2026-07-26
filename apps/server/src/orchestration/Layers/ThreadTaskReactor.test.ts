/**
 * Settlement and delivery rules for the thread task reactor.
 *
 * The reactor is driven through `makeThreadTaskEvaluator` rather than its event
 * stream: the rules under test are what one evaluation pass decides, and
 * driving them directly keeps the assertions free of stream timing.
 *
 * The engine and projection stubs model just enough of the decider to make the
 * two-step pass real — `thread.task.finish` arms a pending delivery, and
 * `thread.task.delivery.set` settles it — so a test observes the same state
 * transitions the reactor sees in production.
 */
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type ThreadTaskDelivery,
  type ThreadTaskMetadata,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "../Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadTaskReactor } from "../Services/ThreadTaskReactor.ts";
import { makeThreadTaskEvaluator, ThreadTaskReactorLive } from "./ThreadTaskReactor.ts";

const NOW = "2026-07-25T00:00:00.000Z";
const PARENT = ThreadId.make("parent-1");
const TASK = ThreadId.make("task-1");

type Dispatched = OrchestrationCommand;

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

const turn = (
  state: "completed" | "running" | "error" | "interrupted",
  overrides: Record<string, unknown> = {},
) =>
  ({
    turnId: TurnId.make("turn-1"),
    state,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: state === "running" ? null : "2026-07-25T00:01:00.000Z",
    assistantMessageId: null,
    ...overrides,
  }) as NonNullable<OrchestrationThread["latestTurn"]>;

const assistantMessage = (text: string, overrides: Record<string, unknown> = {}) =>
  ({
    id: MessageId.make("assistant-1"),
    role: "assistant",
    text,
    turnId: TurnId.make("turn-1"),
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }) as OrchestrationThread["messages"][number];

const activity = (input: {
  readonly kind: string;
  readonly tone?: string;
  readonly summary?: string;
  readonly payload?: Record<string, unknown>;
}) =>
  ({
    id: `activity-${input.kind}-${JSON.stringify(input.payload ?? {})}`,
    kind: input.kind,
    tone: input.tone ?? "info",
    summary: input.summary ?? input.kind,
    payload: input.payload ?? {},
    turnId: null,
    createdAt: NOW,
  }) as OrchestrationThread["activities"][number];

/**
 * Applies the decider's task-command outcomes to the stub's thread table so a
 * pass that records a result then sees the pending delivery it created.
 */
function applyToProjection(threads: Map<ThreadId, OrchestrationThread>, command: Dispatched): void {
  if (command.type !== "thread.task.finish" && command.type !== "thread.task.delivery.set") return;
  const target = threads.get(command.taskThreadId);
  if (target?.task == null) return;
  const nextTask: ThreadTaskMetadata =
    command.type === "thread.task.finish"
      ? ({
          ...target.task,
          status: command.status,
          result: command.result,
          delivery: { state: "pending", updatedAt: NOW } satisfies ThreadTaskDelivery,
          finishedAt: NOW,
        } as ThreadTaskMetadata)
      : ({ ...target.task, delivery: command.delivery } as ThreadTaskMetadata);
  threads.set(command.taskThreadId, { ...target, task: nextTask } as OrchestrationThread);
}

function makeHarness(input: {
  readonly threads: ReadonlyArray<OrchestrationThread>;
  /** Simulates a rejected wake-up, e.g. a parent that lost its provider. */
  readonly failWakeUp?: boolean;
}) {
  const threads = new Map(input.threads.map((entry) => [entry.id, entry] as const));
  const dispatched: Array<Dispatched> = [];

  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.suspend(() => {
        if (input.failWakeUp === true && command.type === "thread.turn.start") {
          return Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "provider instance is not ready",
            }),
          );
        }
        dispatched.push(command);
        applyToProjection(threads, command);
        return Effect.succeed({ sequence: dispatched.length });
      }),
    streamDomainEvents: Stream.empty,
  } as unknown as OrchestrationEngineShape;

  const snapshotQuery = {
    getThreadDetailById: (threadId: ThreadId) =>
      Effect.sync(() => {
        const found = threads.get(threadId);
        return found === undefined ? Option.none() : Option.some(found);
      }),
    getShellSnapshot: () =>
      Effect.sync(() => ({
        snapshotSequence: 0,
        projects: [],
        threads: [...threads.values()],
      })),
  } as unknown as ProjectionSnapshotQueryShape;

  const layer = Layer.mergeAll(
    Layer.succeed(OrchestrationEngineService, engine),
    Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
    NodeServices.layer,
  );

  const evaluate = (threadId: ThreadId = TASK) =>
    makeThreadTaskEvaluator.pipe(
      Effect.flatMap((evaluator) => evaluator.evaluateTaskThread(threadId)),
      Effect.provide(layer),
    );

  const commandsOf = <T extends Dispatched["type"]>(type: T) =>
    dispatched.filter(
      (command): command is Extract<Dispatched, { type: T }> => command.type === type,
    );

  return { threads, dispatched, evaluate, commandsOf, layer };
}

const settledTask = (overrides: Partial<OrchestrationThread> = {}) =>
  thread({
    id: TASK,
    task: task(),
    latestTurn: turn("completed"),
    messages: [assistantMessage("Four handlers have no tests.")],
    ...overrides,
  } as Partial<OrchestrationThread> & { id: ThreadId });

const liveParent = () => thread({ id: PARENT });

describe("thread task reactor — settlement", () => {
  it.effect("records a result once the task's turn has ended and nothing is pending", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ threads: [liveParent(), settledTask()] });
      yield* harness.evaluate();

      const [finish] = harness.commandsOf("thread.task.finish");
      expect(finish?.taskThreadId).toBe(TASK);
      expect(finish?.parentThreadId).toBe(PARENT);
      expect(finish?.status).toBe("finished");
      expect(finish?.result.outcome).toBe("succeeded");
      expect(finish?.result.summary).toBe("Four handlers have no tests.");
    }),
  );

  it.effect("leaves a running turn alone", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        threads: [liveParent(), settledTask({ latestTurn: turn("running") })],
      });
      yield* harness.evaluate();

      expect(harness.dispatched).toHaveLength(0);
    }),
  );

  it.effect("leaves a task that has not run a turn alone", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        threads: [liveParent(), settledTask({ latestTurn: null })],
      });
      yield* harness.evaluate();

      expect(harness.dispatched).toHaveLength(0);
    }),
  );

  // A turn that ends awaiting a human is not finished work. Reporting back here
  // would deliver a half-done result and abandon the request.
  it.effect("waits while an approval or user-input request is still open", () =>
    Effect.gen(function* () {
      for (const kind of ["approval.requested", "user-input.requested"]) {
        const harness = makeHarness({
          threads: [
            liveParent(),
            settledTask({
              activities: [activity({ kind, payload: { requestId: "request-1" } })],
            }),
          ],
        });
        yield* harness.evaluate();
        expect(harness.dispatched).toHaveLength(0);
      }
    }),
  );

  it.effect("reports back once the open request has been resolved", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        threads: [
          liveParent(),
          settledTask({
            activities: [
              activity({ kind: "approval.requested", payload: { requestId: "request-1" } }),
              activity({ kind: "approval.resolved", payload: { requestId: "request-1" } }),
            ],
          }),
        ],
      });
      yield* harness.evaluate();

      expect(harness.commandsOf("thread.task.finish")).toHaveLength(1);
    }),
  );

  it.effect("waits while the session still names an active turn", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        threads: [
          liveParent(),
          settledTask({
            session: { threadId: TASK, activeTurnId: TurnId.make("turn-2") },
          } as Partial<OrchestrationThread>),
        ],
      });
      yield* harness.evaluate();

      expect(harness.dispatched).toHaveLength(0);
    }),
  );

  it.effect("records a failed turn with the provider's error detail", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        threads: [
          liveParent(),
          settledTask({
            latestTurn: turn("error"),
            activities: [
              activity({
                kind: "runtime.error",
                tone: "error",
                payload: { detail: "rate limited" },
              }),
            ],
          }),
        ],
      });
      yield* harness.evaluate();

      const [finish] = harness.commandsOf("thread.task.finish");
      expect(finish?.status).toBe("failed");
      expect(finish?.result.outcome).toBe("failed");
      expect(finish?.result.summary).toBe("rate limited");
    }),
  );

  it.effect("falls back to a plain sentence when a failed turn left no detail", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        threads: [liveParent(), settledTask({ latestTurn: turn("error"), activities: [] })],
      });
      yield* harness.evaluate();

      const [finish] = harness.commandsOf("thread.task.finish");
      expect(finish?.result.summary).toBe("The task ended with an error and produced no output.");
    }),
  );

  it.effect("records an interrupted turn as cancelled", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        threads: [liveParent(), settledTask({ latestTurn: turn("interrupted") })],
      });
      yield* harness.evaluate();

      const [finish] = harness.commandsOf("thread.task.finish");
      expect(finish?.status).toBe("cancelled");
      expect(finish?.result.outcome).toBe("cancelled");
    }),
  );

  it.effect("summarizes a turn that produced no assistant output", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ threads: [liveParent(), settledTask({ messages: [] })] });
      yield* harness.evaluate();

      const [finish] = harness.commandsOf("thread.task.finish");
      expect(finish?.result.summary).toBe("The task finished without producing any output.");
    }),
  );

  // A half-written message is not the answer; the previous complete one is.
  it.effect("summarizes from the latest settled assistant message", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        threads: [
          liveParent(),
          settledTask({
            messages: [
              assistantMessage("first pass", { id: MessageId.make("a-1") }),
              assistantMessage("final answer", {
                id: MessageId.make("a-2"),
                createdAt: "2026-07-25T00:00:30.000Z",
              }),
              assistantMessage("still typing", {
                id: MessageId.make("a-3"),
                createdAt: "2026-07-25T00:00:45.000Z",
                streaming: true,
              }),
            ],
          }),
        ],
      });
      yield* harness.evaluate();

      const [finish] = harness.commandsOf("thread.task.finish");
      expect(finish?.result.summary).toBe("final answer");
      expect(finish?.result.assistantMessageId).toBe("a-2");
    }),
  );

  // Cancellation already recorded the outcome; re-recording would overwrite it.
  it.effect("does not record a result for a cancelled task", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        threads: [liveParent(), settledTask({ task: task({ status: "cancelled" }) })],
      });
      yield* harness.evaluate();

      expect(harness.commandsOf("thread.task.finish")).toHaveLength(0);
    }),
  );

  it.effect("records a result exactly once across repeated passes", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ threads: [liveParent(), settledTask()] });
      yield* harness.evaluate();
      yield* harness.evaluate();
      yield* harness.evaluate();

      expect(harness.commandsOf("thread.task.finish")).toHaveLength(1);
      expect(harness.commandsOf("thread.turn.start")).toHaveLength(1);
    }),
  );
});

describe("thread task reactor — delivery", () => {
  it.effect("wakes the parent with a task-result message and marks the delivery", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ threads: [liveParent(), settledTask()] });
      yield* harness.evaluate();

      const [start] = harness.commandsOf("thread.turn.start");
      expect(start?.threadId).toBe(PARENT);
      expect(start?.message.role).toBe("user");
      // The wake-up is not something the user typed; the parent transcript
      // relies on this to render a lifecycle row instead of a user bubble.
      expect(start?.message.source).toBe("task-result");
      expect(start?.message.text).toContain("Four handlers have no tests.");

      const [delivery] = harness.commandsOf("thread.task.delivery.set");
      expect(delivery?.delivery.state).toBe("delivered");
      expect(delivery?.delivery).toMatchObject({ parentMessageId: start?.message.messageId });
    }),
  );

  // Delivery into a busy parent is an ordinary turn start, which the provider
  // path turns into a steer. The reactor must not hold the result back for it.
  it.effect("delivers into a parent whose own turn is still running", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        threads: [
          thread({
            id: PARENT,
            latestTurn: turn("running"),
            session: { threadId: PARENT, activeTurnId: TurnId.make("parent-turn") },
          } as Partial<OrchestrationThread> & { id: ThreadId }),
          settledTask(),
        ],
      });
      yield* harness.evaluate();

      expect(harness.commandsOf("thread.turn.start")).toHaveLength(1);
      expect(harness.commandsOf("thread.task.delivery.set")[0]?.delivery.state).toBe("delivered");
    }),
  );

  const pendingDeliveryTask = () =>
    settledTask({
      task: task({
        status: "finished",
        result: {
          outcome: "succeeded",
          summary: "Four handlers have no tests.",
          summaryTruncated: false,
          assistantMessageId: null,
          completedAt: NOW,
        },
        delivery: { state: "pending", updatedAt: NOW },
      } as Partial<ThreadTaskMetadata>),
    });

  it.effect("retries a delivery left pending by an earlier pass", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ threads: [liveParent(), pendingDeliveryTask()] });
      yield* harness.evaluate();

      // The result was already durable, so only the wake-up is retried.
      expect(harness.commandsOf("thread.task.finish")).toHaveLength(0);
      expect(harness.commandsOf("thread.turn.start")).toHaveLength(1);
      expect(harness.commandsOf("thread.task.delivery.set")[0]?.delivery.state).toBe("delivered");
    }),
  );

  const skipCases = [
    {
      name: "parent-missing",
      threads: () => [settledTask()],
    },
    {
      name: "parent-deleted",
      threads: () => [thread({ id: PARENT, deletedAt: NOW }), settledTask()],
    },
    {
      name: "parent-archived",
      threads: () => [thread({ id: PARENT, archivedAt: NOW }), settledTask()],
    },
    {
      name: "task-deleted",
      threads: () => [liveParent(), settledTask({ deletedAt: NOW })],
    },
    {
      name: "task-archived",
      threads: () => [liveParent(), settledTask({ archivedAt: NOW })],
    },
  ] as const;

  for (const skipCase of skipCases) {
    it.effect(`skips delivery as ${skipCase.name} and still records the result`, () =>
      Effect.gen(function* () {
        const harness = makeHarness({ threads: skipCase.threads() });
        yield* harness.evaluate();

        expect(harness.commandsOf("thread.task.finish")).toHaveLength(1);
        expect(harness.commandsOf("thread.turn.start")).toHaveLength(0);
        expect(harness.commandsOf("thread.task.delivery.set")[0]?.delivery).toMatchObject({
          state: "skipped",
          reason: skipCase.name,
        });
      }),
    );
  }

  // A rejected wake-up must settle the delivery rather than fail the pass —
  // otherwise the task retries forever against a parent that cannot accept it.
  it.effect("records a rejected wake-up as dispatch-failed", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ threads: [liveParent(), settledTask()], failWakeUp: true });
      yield* harness.evaluate();

      expect(harness.commandsOf("thread.turn.start")).toHaveLength(0);
      expect(harness.commandsOf("thread.task.delivery.set")[0]?.delivery).toMatchObject({
        state: "skipped",
        reason: "dispatch-failed",
      });
    }),
  );

  it.effect("ignores a thread that is not a task", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ threads: [liveParent()] });
      yield* harness.evaluate(PARENT);

      expect(harness.dispatched).toHaveLength(0);
    }),
  );

  // A shutdown between recording a result and waking the parent leaves the
  // delivery pending, and no further event will arrive to trigger it. Startup
  // has to go looking.
  const runStartedReactor = (harness: ReturnType<typeof makeHarness>) =>
    Effect.gen(function* () {
      const reactor = yield* ThreadTaskReactor;
      yield* reactor.start();
      yield* reactor.drain;
    }).pipe(
      // The worker fiber is forked into the layer's scope, so the layer has to
      // stay built for the whole run — not just long enough to read the service.
      Effect.provide(ThreadTaskReactorLive.pipe(Layer.provide(harness.layer))),
      Effect.scoped,
    );

  it.effect("re-enqueues pending deliveries when it starts", () => {
    const harness = makeHarness({ threads: [liveParent(), pendingDeliveryTask()] });
    return runStartedReactor(harness).pipe(
      Effect.map(() => {
        expect(harness.commandsOf("thread.turn.start")).toHaveLength(1);
        expect(harness.commandsOf("thread.task.delivery.set")[0]?.delivery.state).toBe("delivered");
      }),
    );
  });

  it.effect("leaves a task with nothing outstanding alone when it starts", () => {
    const harness = makeHarness({ threads: [liveParent(), settledTask()] });
    return runStartedReactor(harness).pipe(
      Effect.map(() => {
        expect(harness.dispatched).toHaveLength(0);
      }),
    );
  });
});
