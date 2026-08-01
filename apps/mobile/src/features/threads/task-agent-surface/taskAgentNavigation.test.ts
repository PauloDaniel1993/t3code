import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_TRANSCRIPT_UNAVAILABLE_REASON,
  DEFAULT_TASK_AGENT_NAVIGATION_CONFIG,
  NATIVE_AGENT_NOT_STEERABLE_REASON,
  TASK_ROW_CONTEXTS,
  resolveAgentTranscriptAffordance,
  resolveSteeringAvailability,
  resolveTaskRowAffordances,
  resolveTaskRowTapDestination,
  type NativeAgentIdentity,
  type TaskIdentity,
} from "./taskAgentNavigation";

const taskA = {
  environmentId: EnvironmentId.make("environment-a"),
  taskId: ThreadId.make("task-a"),
} as const satisfies TaskIdentity;

const taskB = {
  environmentId: EnvironmentId.make("environment-b"),
  taskId: ThreadId.make("task-b"),
} as const satisfies TaskIdentity;

const ownerThread = {
  environmentId: taskA.environmentId,
  threadId: ThreadId.make("parent-thread"),
};

const mappingCases = [["peek", "peek"] as const, ["push", "thread"] as const];

describe("task-row destination mapping", () => {
  it.each(mappingCases)(
    "uses one %s destination kind in every task-row context",
    (mode, expectedKind) => {
      const destinationsByContext = TASK_ROW_CONTEXTS.map((context) => ({
        context,
        destination: resolveTaskRowTapDestination(taskB, { taskRowTap: mode }),
      }));

      expect(destinationsByContext.map(({ destination }) => destination.kind)).toEqual(
        TASK_ROW_CONTEXTS.map(() => expectedKind),
      );
      expect(new Set(destinationsByContext.map(({ destination }) => destination.kind)).size).toBe(
        1,
      );
    },
  );

  it("uses the documented provisional peek mapping by default", () => {
    expect(DEFAULT_TASK_AGENT_NAVIGATION_CONFIG.taskRowTap).toBe("peek");
    expect(resolveTaskRowTapDestination(taskA, DEFAULT_TASK_AGENT_NAVIGATION_CONFIG).kind).toBe(
      "peek",
    );
  });

  it.each([
    ["task A", taskA],
    ["task B", taskB],
  ] as const)("preserves the exact identity for %s", (_label, task) => {
    for (const [mode] of mappingCases) {
      const destination = resolveTaskRowTapDestination(task, { taskRowTap: mode });

      expect(destination.params).toEqual({
        environmentId: task.environmentId,
        threadId: task.taskId,
      });
      expect(destination.params.threadId).toBe(task.taskId);
    }

    const taskBDestination = resolveTaskRowTapDestination(taskB, { taskRowTap: "push" });
    expect(taskBDestination.params.threadId).not.toBe(taskA.taskId);
    expect(taskBDestination.params.threadId).not.toBe("default");
  });

  it.each([
    ["peek", "thread", "open-thread", "Open thread"] as const,
    ["push", "peek", "peek-task", "Peek at task"] as const,
  ])(
    "keeps the losing destination reachable when tap is %s",
    (mode, expectedAlternativeKind, expectedAction, expectedLabel) => {
      for (const task of [taskA, taskB]) {
        const affordances = resolveTaskRowAffordances(task, { taskRowTap: mode });

        expect(affordances.tap.kind).toBe(mode === "peek" ? "peek" : "thread");
        expect(affordances.alternative).toEqual(
          expect.objectContaining({
            kind: "alternative-affordance",
            action: expectedAction,
            label: expectedLabel,
          }),
        );
        expect(affordances.alternative.destination.kind).toBe(expectedAlternativeKind);
        expect(affordances.alternative.destination.params).toEqual({
          environmentId: task.environmentId,
          threadId: task.taskId,
        });
      }
    },
  );
});

describe("agent transcript affordance", () => {
  const agentCases: ReadonlyArray<readonly [string, NativeAgentIdentity]> = [
    ["with a spawning turn", { taskId: "provider-agent-1", turnId: TurnId.make("turn-1") }],
    ["without a reported turn", { taskId: "provider-agent-2", turnId: null }],
  ];

  it.each(agentCases)(
    "does not overclaim an exact transcript route for an agent %s",
    (_label, agent) => {
      const affordance = resolveAgentTranscriptAffordance({
        owningThread: ownerThread,
        agent,
      });

      expect(affordance.kind).toBe("unavailable");
      if (affordance.kind === "unavailable") {
        expect(affordance.reason).toBe(AGENT_TRANSCRIPT_UNAVAILABLE_REASON);
        expect(affordance.reason.trim()).not.toBe("");
      }
    },
  );
});

describe("steering availability", () => {
  const taskStateCases = [
    ["queued", "unavailable"] as const,
    ["running", "available"] as const,
    ["finished", "available"] as const,
    ["failed", "unavailable"] as const,
    ["cancelled", "unavailable"] as const,
  ];

  it.each(taskStateCases)("reports %s task steering as %s", (status, expectedKind) => {
    const availability = resolveSteeringAvailability({
      kind: "task",
      task: taskB,
      status,
    });

    expect(availability.kind).toBe(expectedKind);
    if (availability.kind === "unavailable") {
      expect(availability.reason.trim()).not.toBe("");
    } else {
      expect(availability).toEqual({ kind: "available" });
    }
  });

  const nativeAgentCases: ReadonlyArray<readonly [string, NativeAgentIdentity]> = [
    ["with a turn id", { taskId: "provider-agent-1", turnId: TurnId.make("turn-1") }],
    ["with no turn id", { taskId: "provider-agent-2", turnId: null }],
  ];

  it.each(nativeAgentCases)(
    "always refuses steering for a native agent %s with a reason",
    (_label, agent) => {
      const availability = resolveSteeringAvailability({
        kind: "native-agent",
        agent,
      });

      expect(availability.kind).toBe("unavailable");
      if (availability.kind === "unavailable") {
        expect(availability.reason).toBe(NATIVE_AGENT_NOT_STEERABLE_REASON);
        expect(availability.reason.trim()).not.toBe("");
      }
    },
  );
});
