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

import { buildTaskAgentModel } from "./taskAgentModel";
import { NATIVE_AGENT_NOT_STEERABLE_REASON } from "./taskAgentNavigation";
import { buildTaskAgentSurfaceRows } from "./taskAgentSurface.logic";
import {
  TASK_AGENT_UNAVAILABLE_COMPOSER_ANCESTOR_OPACITIES,
  buildUnavailableTaskAgentTaskSurface,
  resolveTaskAgentComposer,
  resolveTaskAgentTaskSurface,
  taskAgentUnavailableComposerReasonContrast,
  taskAgentUnavailableComposerReasonMeetsContrast,
} from "./taskAgentTaskSurface.logic";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const parentId = ThreadId.make("parent-thread");
const nowMs = Date.parse("2026-07-31T10:10:00.000Z");
const requestedAt = "2026-07-31T10:00:00.000Z";
const completedAt = "2026-07-31T10:05:00.000Z";

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

function makeAgent(input: {
  readonly id: string;
  readonly status?: "running" | "finished" | "failed";
  readonly reason?: string;
}): ThreadNativeAgent {
  return {
    taskId: input.id,
    turnId: TurnId.make("turn-1"),
    status: input.status ?? "running",
    description: input.id,
    errorMessage: input.reason,
    startedAt: requestedAt,
    updatedAt: completedAt,
  } as ThreadNativeAgent;
}

function makeTask(input: {
  readonly id: ThreadId;
  readonly title: string;
  readonly status: "queued" | "running" | "finished" | "failed" | "cancelled";
  readonly nativeAgents?: ReadonlyArray<ThreadNativeAgent>;
}): EnvironmentThreadShell {
  const terminal =
    input.status === "finished" || input.status === "failed" || input.status === "cancelled";
  return makeThread({
    id: input.id,
    title: input.title,
    parentThreadId: parentId,
    nativeAgents: input.nativeAgents,
    task: {
      parentThreadId: parentId,
      title: input.title,
      prompt: "Do the task",
      context: { kind: "none" },
      contextTruncated: false,
      createdBy: "agent",
      status: input.status,
      requestedAt,
      startedAt: input.status === "queued" ? null : requestedAt,
      finishedAt: terminal ? completedAt : null,
      result: terminal
        ? {
            outcome:
              input.status === "finished"
                ? "succeeded"
                : input.status === "failed"
                  ? "failed"
                  : "cancelled",
            summary: input.status === "failed" ? "Task failure reason" : "Task result",
            summaryTruncated: false,
            assistantMessageId: MessageId.make(`result-${input.id}`),
            completedAt,
          }
        : null,
      delivery: null,
    },
  });
}

function surface(tasks: ReadonlyArray<EnvironmentThreadShell>) {
  return buildTaskAgentSurfaceRows(
    buildTaskAgentModel({
      threads: [makeThread({ id: parentId, title: "Parent" }), ...tasks],
      nowMs,
      readState: { lastVisitedAtByThreadId: new Map() },
    }),
  );
}

function resolveTask(tasks: ReadonlyArray<EnvironmentThreadShell>, taskId: ThreadId) {
  const result = resolveTaskAgentTaskSurface({
    surface: surface(tasks),
    route: { environmentId, threadId: taskId },
  });
  if (result === null) throw new Error(`Expected task ${taskId} to resolve`);
  return result;
}

describe("full task-thread surface decisions", () => {
  it("resolves only the task named by the route and never defaults to another task", () => {
    const firstId = ThreadId.make("first-task");
    const tappedId = ThreadId.make("tapped-task");
    const tasks = [
      makeTask({ id: firstId, title: "First task", status: "running" }),
      makeTask({ id: tappedId, title: "Tapped task", status: "running" }),
    ];

    const resolved = resolveTask(tasks, tappedId);
    expect(resolved.route.threadId).toBe(tappedId);
    expect(resolved.row.id).toBe(tappedId);
    expect(resolved.row.title).toBe("Tapped task");
    expect(
      resolveTaskAgentTaskSurface({
        surface: surface(tasks),
        route: { environmentId, threadId: ThreadId.make("missing-task") },
      }),
    ).toBeNull();

    const unavailable = buildUnavailableTaskAgentTaskSurface({
      route: { environmentId, threadId: ThreadId.make("missing-task") },
      title: "Exact missing task",
    });
    expect(unavailable.route.threadId).toBe("missing-task");
    expect(unavailable.title).toBe("Exact missing task");
  });

  it("gives a steerable task an available composer with no unavailability message", () => {
    const task = resolveTask(
      [makeTask({ id: ThreadId.make("running-task"), title: "Running", status: "running" })],
      ThreadId.make("running-task"),
    );

    expect(task.composer).toEqual({ kind: "available", placeholder: "Steer this task…" });
    expect("reason" in task.composer).toBe(false);
  });

  it("gives a non-steerable task and native agent their projected refusal reasons", () => {
    const queued = resolveTask(
      [makeTask({ id: ThreadId.make("queued-task"), title: "Queued", status: "queued" })],
      ThreadId.make("queued-task"),
    );
    expect(queued.composer.kind).toBe("unavailable");
    if (queued.composer.kind === "unavailable") {
      expect(queued.composer.reason.trim()).not.toBe("");
      expect(queued.composer.reason).toBe(
        "This task has not started yet, so there is no active turn to steer.",
      );
    }

    const running = resolveTask(
      [
        makeTask({
          id: ThreadId.make("task-with-agent"),
          title: "Task with agent",
          status: "running",
          nativeAgents: [makeAgent({ id: "native-agent" })],
        }),
      ],
      ThreadId.make("task-with-agent"),
    );
    const agent = running.turns[0]?.row.agents[0];
    if (agent === undefined) throw new Error("Expected a native agent");
    const composer = resolveTaskAgentComposer(agent);
    expect(composer.kind).toBe("unavailable");
    if (composer.kind === "unavailable") {
      expect(composer.reason).toBe(NATIVE_AGENT_NOT_STEERABLE_REASON);
      expect(composer.reason.trim()).not.toBe("");
    }
  });

  it("makes every presented control either actionable or explicit about refusal", () => {
    const task = resolveTask(
      [
        makeTask({
          id: ThreadId.make("controlled-task"),
          title: "Controlled",
          status: "running",
          nativeAgents: [makeAgent({ id: "controlled-agent", status: "running" })],
        }),
      ],
      ThreadId.make("controlled-task"),
    );

    expect(task.controls.some((control) => control.availability.kind === "action")).toBe(true);
    expect(task.controls.some((control) => control.availability.kind === "unavailable")).toBe(true);
    for (const control of task.controls) {
      if (control.availability.kind === "action") {
        expect(control.availability.action).toBeDefined();
      } else {
        expect(control.availability.reason.trim()).not.toBe("");
      }
    }
  });

  it("presents cancellation as cancellation rather than failure", () => {
    const task = resolveTask(
      [
        makeTask({
          id: ThreadId.make("cancelled-task"),
          title: "Cancelled",
          status: "cancelled",
        }),
      ],
      ThreadId.make("cancelled-task"),
    );

    expect(task.row.status.kind).toBe("cancelled");
    expect(task.row.tone).toBe("cancelled");
    expect(task.row.glyph).toBe("−");
    expect(task.row.failure).toBeNull();
    expect(task.composer.kind).toBe("unavailable");
  });

  it("keeps projected failure reasons reachable through the turn rollup disclosure", () => {
    const task = resolveTask(
      [
        makeTask({
          id: ThreadId.make("failed-agent-task"),
          title: "Failure attribution",
          status: "running",
          nativeAgents: [
            makeAgent({ id: "failed-agent", status: "failed", reason: "Tool budget exceeded" }),
          ],
        }),
      ],
      ThreadId.make("failed-agent-task"),
    );
    const turn = task.turns[0];
    if (turn === undefined) throw new Error("Expected a projected turn");

    expect(turn.row.outcome.kind).toBe("failure-only");
    expect(turn.failureAccess.kind).toBe("reachable");
    if (turn.failureAccess.kind === "reachable") {
      expect(turn.failureAccess.through.availability.action).toEqual({
        kind: "toggle-turn",
        turnKey: turn.row.key,
      });
      expect(turn.failureAccess.failures.map((failure) => failure.reason)).toEqual([
        "Tool budget exceeded",
      ]);
    }
    expect(turn.row.agents[0]?.statusLine).toContain("Tool budget exceeded");
  });

  it.each(["light", "dark"] as const)(
    "keeps the opaque unavailable-composer reason above 4.5:1 in %s mode",
    (mode) => {
      expect(TASK_AGENT_UNAVAILABLE_COMPOSER_ANCESTOR_OPACITIES).toEqual([]);
      expect(taskAgentUnavailableComposerReasonContrast(mode)).toBeGreaterThanOrEqual(4.5);
      expect(taskAgentUnavailableComposerReasonMeetsContrast(mode)).toBe(true);
    },
  );
});
