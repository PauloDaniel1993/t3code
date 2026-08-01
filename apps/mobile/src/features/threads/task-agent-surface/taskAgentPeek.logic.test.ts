import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ThreadNativeAgent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { NATIVE_AGENT_NOT_STEERABLE_REASON } from "./taskAgentNavigation";
import { buildTaskAgentModel } from "./taskAgentModel";
import { buildTaskAgentSurfaceRows } from "./taskAgentSurface.logic";
import {
  buildTaskAgentPeek,
  resolveTaskAgentPeekRoute,
  type TaskPeekAgentRouteParams,
  type TaskPeekTaskRouteParams,
} from "./taskAgentPeek.logic";

const environmentId = EnvironmentId.make("peek-environment");
const projectId = ProjectId.make("peek-project");
const nowMs = Date.parse("2026-07-29T10:10:00.000Z");
const requestedAt = "2026-07-29T10:00:00.000Z";
const finishedAt = "2026-07-29T10:05:00.000Z";

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
    readonly title: string;
    readonly nativeAgents?: ReadonlyArray<ThreadNativeAgent>;
  },
): EnvironmentThreadShell {
  return makeThread({
    id: input.id,
    title: input.title,
    parentThreadId,
    task: {
      parentThreadId,
      title: input.title,
      prompt: "Inspect this task",
      context: { kind: "none" },
      contextTruncated: false,
      createdBy: "agent",
      status: "running",
      requestedAt,
      startedAt: requestedAt,
      finishedAt: null,
      result: null,
      delivery: null,
    },
    nativeAgents: input.nativeAgents,
  });
}

function makeAgent(input: {
  readonly taskId: string;
  readonly status: "running" | "finished" | "failed";
  readonly description: string;
  readonly errorMessage?: string;
}): ThreadNativeAgent {
  return {
    taskId: input.taskId,
    turnId: TurnId.make("peek-turn"),
    status: input.status,
    description: input.description,
    startedAt: requestedAt,
    updatedAt: finishedAt,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  } as ThreadNativeAgent;
}

function surface() {
  const parentId = ThreadId.make("peek-parent");
  const taskAId = ThreadId.make("peek-task-a");
  const taskBId = ThreadId.make("peek-task-b");
  const agentId = "peek-agent-b";
  const model = buildTaskAgentModel({
    threads: [
      makeThread({ id: parentId, title: "Peek parent" }),
      makeTask(parentId, { id: taskAId, title: "Task A" }),
      makeTask(parentId, {
        id: taskBId,
        title: "Task B",
        nativeAgents: [
          makeAgent({
            taskId: agentId,
            status: "failed",
            description: "Agent B",
            errorMessage: "The provider budget was exhausted.",
          }),
        ],
      }),
    ],
    nowMs,
    readState: { lastVisitedAtByThreadId: new Map() },
  });

  return { agentId, surface: buildTaskAgentSurfaceRows(model), taskAId, taskBId };
}

describe("task-agent peek logic", () => {
  it("builds a task peek with the shared task and agent row anatomy", () => {
    const fixture = surface();
    const params = {
      environmentId,
      threadId: fixture.taskBId,
    } as const satisfies TaskPeekTaskRouteParams;
    const resolved = resolveTaskAgentPeekRoute({ surface: fixture.surface, params });
    if (resolved === null || resolved.kind !== "task") throw new Error("expected task B");

    const peek = buildTaskAgentPeek(resolved);
    const agent = peek.turns[0]?.agents[0];
    if (agent === undefined) throw new Error("expected the task's native agent");

    expect(peek.row).toBe(resolved.row);
    expect(peek.row.kind).toBe("task");
    expect(agent.kind).toBe("native-agent");
    expect(Object.keys(peek.row).sort()).toEqual(Object.keys(agent).sort());
    expect(peek.turns[0]?.outcome.counters).toEqual(resolved.row.turns[0]?.outcome.counters);
  });

  it("builds a native-agent peek with the same anatomy and an explicit transcript refusal", () => {
    const fixture = surface();
    const params = {
      agentId: fixture.agentId,
      environmentId,
      threadId: fixture.taskBId,
    } as const satisfies TaskPeekAgentRouteParams;
    const resolved = resolveTaskAgentPeekRoute({ surface: fixture.surface, params });
    if (resolved === null || resolved.kind !== "native-agent") {
      throw new Error("expected native agent B");
    }

    const peek = buildTaskAgentPeek(resolved);
    const transcript = peek.controls.find((control) => control.id === "show-in-transcript");
    if (transcript?.availability.kind !== "unavailable") {
      throw new Error("expected an explicit transcript refusal");
    }

    expect(peek.row).toBe(resolved.row);
    expect(peek.row.kind).toBe("native-agent");
    expect(Object.keys(peek.row).sort()).toEqual(
      Object.keys(peek.turns[0]?.agents[0] ?? {}).sort(),
    );
    expect(transcript.availability.reason.trim()).not.toBe("");
    expect(peek.controls).toContainEqual(
      expect.objectContaining({
        id: "steer",
        availability: {
          kind: "unavailable",
          reason: NATIVE_AGENT_NOT_STEERABLE_REASON,
        },
      }),
    );
  });

  it("gives every rendered control either an action or a non-empty refusal reason", () => {
    const fixture = surface();
    const task = resolveTaskAgentPeekRoute({
      surface: fixture.surface,
      params: { environmentId, threadId: fixture.taskBId },
    });
    const agent = resolveTaskAgentPeekRoute({
      surface: fixture.surface,
      params: { agentId: fixture.agentId, environmentId, threadId: fixture.taskBId },
    });
    if (task === null || agent === null) throw new Error("expected both peek targets");

    for (const peek of [buildTaskAgentPeek(task), buildTaskAgentPeek(agent)]) {
      for (const control of peek.controls) {
        expect(
          control.availability.kind === "action" || control.availability.reason.trim().length > 0,
        ).toBe(true);
      }
    }
  });

  it("resolves task B exactly, never task A or a default target", () => {
    const fixture = surface();
    const taskBParams = {
      environmentId,
      threadId: fixture.taskBId,
    } as const satisfies TaskPeekTaskRouteParams;
    const resolvedTaskB = resolveTaskAgentPeekRoute({
      surface: fixture.surface,
      params: taskBParams,
    });
    if (resolvedTaskB === null || resolvedTaskB.kind !== "task") {
      throw new Error("expected task B");
    }

    expect(resolvedTaskB.row.id).toBe(fixture.taskBId);
    expect(resolvedTaskB.row.id).not.toBe(fixture.taskAId);
    expect(resolvedTaskB.row.title).toBe("Task B");
    expect(
      resolveTaskAgentPeekRoute({
        surface: fixture.surface,
        params: { environmentId, threadId: ThreadId.make("unknown-task") },
      }),
    ).toBeNull();

    // @ts-expect-error A task peek cannot be constructed without its exact task id.
    const missingIdentity: TaskPeekTaskRouteParams = { environmentId };
    expect(missingIdentity).toBeDefined();
  });
});
