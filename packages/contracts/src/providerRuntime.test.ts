import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderRuntimeEvent, TaskUsageSnapshot } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const decodeTaskUsageSnapshot = Schema.decodeUnknownSync(TaskUsageSnapshot);

describe("ProviderRuntimeEvent", () => {
  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });

  it("normalizes canonical and historical task usage without fabricating counters", () => {
    expect(
      decodeTaskUsageSnapshot({
        totalTokens: 0,
        toolUses: 2,
        durationMs: 0,
      }),
    ).toEqual({
      totalTokens: 0,
      toolUses: 2,
      durationMs: 0,
    });

    expect(decodeTaskUsageSnapshot({ tool_uses: 0 })).toEqual({ toolUses: 0 });
  });

  it("rejects invalid task usage counters", () => {
    expect(() => decodeTaskUsageSnapshot({ total_tokens: -1 })).toThrow();
    expect(() => decodeTaskUsageSnapshot({ toolUses: 1.5 })).toThrow();
  });

  it("decodes legacy and enriched task lifecycle payloads", () => {
    const started = decodeRuntimeEvent({
      type: "task.started",
      eventId: "event-task-started",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:05.000Z",
      threadId: "thread-1",
      payload: { taskId: "task-1" },
    });
    expect(started.type).toBe("task.started");
    if (started.type !== "task.started") {
      throw new Error("expected task.started");
    }
    expect(started.payload).toEqual({ taskId: "task-1" });

    const enrichedStarted = decodeRuntimeEvent({
      type: "task.started",
      eventId: "event-task-started-enriched",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:06.000Z",
      threadId: "thread-1",
      payload: {
        taskId: "task-2",
        retryOfTaskId: "task-1",
        description: "Review the implementation",
        taskType: "agent",
        toolUseId: "tool-task-2",
        subagentType: "code-reviewer",
        workflowName: "parallel-review",
        prompt: "Review the implementation for regressions.",
        skipTranscript: false,
      },
    });
    expect(enrichedStarted.type).toBe("task.started");
    if (enrichedStarted.type !== "task.started") {
      throw new Error("expected task.started");
    }
    expect(enrichedStarted.payload.skipTranscript).toBe(false);
    expect(enrichedStarted.payload.workflowName).toBe("parallel-review");
    expect(enrichedStarted.payload.retryOfTaskId).toBe("task-1");

    const progress = decodeRuntimeEvent({
      type: "task.progress",
      eventId: "event-task-progress",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:07.000Z",
      threadId: "thread-1",
      payload: {
        taskId: "task-2",
        description: "Reviewing the implementation",
        toolUseId: "tool-task-2",
        subagentType: "code-reviewer",
        summary: "Read the changed files",
        usage: { total_tokens: 0, duration_ms: 0 },
        lastToolName: "Read",
      },
    });
    expect(progress.type).toBe("task.progress");
    if (progress.type !== "task.progress") {
      throw new Error("expected task.progress");
    }
    expect(progress.payload.usage).toEqual({ totalTokens: 0, durationMs: 0 });
    expect(progress.payload).not.toHaveProperty("workflowName");
    expect(progress.payload).not.toHaveProperty("skipTranscript");

    const completed = decodeRuntimeEvent({
      type: "task.completed",
      eventId: "event-task-completed",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:08.000Z",
      threadId: "thread-1",
      payload: {
        taskId: "task-2",
        status: "completed",
        toolUseId: "tool-task-2",
        outputFile: "C:/tmp/review.md",
        skipTranscript: false,
        summary: "No regressions found",
        usage: { totalTokens: 0, toolUses: 0, durationMs: 0 },
      },
    });
    expect(completed.type).toBe("task.completed");
    if (completed.type !== "task.completed") {
      throw new Error("expected task.completed");
    }
    expect(completed.payload.outputFile).toBe("C:/tmp/review.md");
    expect(completed.payload.skipTranscript).toBe(false);
    expect(completed.payload.usage).toEqual({ totalTokens: 0, toolUses: 0, durationMs: 0 });

    const failed = decodeRuntimeEvent({
      type: "task.completed",
      eventId: "event-task-failed",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:09.000Z",
      threadId: "thread-1",
      payload: {
        taskId: "task-3",
        status: "failed",
        summary: "Worker stopped unexpectedly",
        error: "Connection to the worker was lost.",
      },
    });
    expect(failed.type).toBe("task.completed");
    if (failed.type !== "task.completed") {
      throw new Error("expected failed task.completed");
    }
    expect(failed.payload.error).toBe("Connection to the worker was lost.");
  });

  it("decodes tool progress without a task and with a nullable parent identity", () => {
    const parsed = decodeRuntimeEvent({
      type: "tool.progress",
      eventId: "event-tool-progress",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:09.000Z",
      threadId: "thread-1",
      payload: {
        toolUseId: "tool-3",
        parentToolUseId: null,
        toolName: "Read",
        summary: "Reading providerRuntime.ts",
        elapsedSeconds: 0,
      },
    });

    expect(parsed.type).toBe("tool.progress");
    if (parsed.type !== "tool.progress") {
      throw new Error("expected tool.progress");
    }
    expect(parsed.payload.taskId).toBeUndefined();
    expect(parsed.payload.parentToolUseId).toBeNull();
    expect(parsed.payload.elapsedSeconds).toBe(0);
  });
});
