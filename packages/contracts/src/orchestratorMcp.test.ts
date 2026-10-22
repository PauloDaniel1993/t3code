import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
  OrchestratorMcpProviderCapability,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpScheduledTask,
  OrchestratorMcpUpdateScheduledTaskInput,
} from "./orchestratorMcp.ts";

const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeFailure = Schema.decodeUnknownSync(OrchestratorMcpFailure);
const encodeFailure = Schema.encodeSync(OrchestratorMcpFailure);
const decodeSchedule = Schema.decodeUnknownSync(OrchestratorMcpScheduleTaskInput);
const decodeScheduleUpdate = Schema.decodeUnknownSync(OrchestratorMcpUpdateScheduledTaskInput);
const decodeScheduledTask = Schema.decodeUnknownSync(OrchestratorMcpScheduledTask);

describe("orchestrator MCP contracts", () => {
  it("accepts compact model choices and omitted-model counts without requiring labels", () => {
    const capability = {
      providerInstanceId: "codex",
      driverKind: "codex",
      displayName: null,
      models: [
        {
          id: "gpt-5.4",
          options: [
            { id: "reasoningEffort", values: ["low", "xhigh"], default: "low" },
            { id: "fastMode", values: [false, true] },
          ],
        },
      ],
      omittedModels: 12,
      canRunChildTask: true,
      canRunCrossProviderChildTask: true,
      constraints: [],
    };
    expect(Schema.decodeUnknownSync(OrchestratorMcpProviderCapability)(capability)).toEqual(
      capability,
    );
  });

  it.each([
    { type: "root" },
    { type: "worktree", baseRef: "dev", branch: "schedule/audit", startFromOrigin: false },
    { type: "existing_worktree", worktreePath: "/sets/audit", branch: "schedule/audit" },
  ])("preserves an optional scheduled workspace strategy: $type", (workspaceStrategy) => {
    const input = {
      prompt: "Audit",
      schedule: { type: "interval", everyMs: 60_000 },
      bindToCurrentThread: false,
    };
    expect(decodeSchedule({ ...input, workspaceStrategy }).workspaceStrategy).toEqual(
      workspaceStrategy,
    );
    expect(decodeSchedule(input).workspaceStrategy).toBeUndefined();
    expect(
      decodeScheduleUpdate({ scheduledTaskId: "schedule:audit", workspaceStrategy })
        .workspaceStrategy,
    ).toEqual(workspaceStrategy);
  });

  it("returns strategy and nullable dispatch errors in schedule summaries", () => {
    const summary = {
      scheduledTaskId: "schedule:audit",
      title: "Audit",
      prompt: "Audit",
      enabled: true,
      projectId: "project:audit",
      boundThreadId: null,
      workspaceStrategy: { type: "root" },
      schedule: { type: "interval", everyMs: 60_000 },
      nextRunAt: "2026-10-11T12:00:00.000Z",
      lastRunStatus: "failed",
      lastRunError: "Workspace file not found.",
    };
    expect(decodeScheduledTask(summary)).toEqual(summary);
    expect(decodeScheduledTask({ ...summary, lastRunError: null }).lastRunError).toBeNull();
  });

  it("preserves workspace diagnostics and conflict IDs while accepting older failures", () => {
    const diagnostic = {
      code: "conflict" as const,
      message: "This workspace file is already linked.",
      path: "C:\\team\\team.code-workspace",
    };
    const failure = decodeFailure({
      _tag: "OrchestratorMcpFailure",
      code: "invalid_request",
      message: diagnostic.message,
      diagnostic,
      conflictingProjectId: "project:existing",
    });
    expect(encodeFailure(failure)).toMatchObject({
      diagnostic,
      conflictingProjectId: "project:existing",
    });
    expect(
      decodeFailure({
        _tag: "OrchestratorMcpFailure",
        code: "invalid_request",
        message: "Old failure",
      }).diagnostic,
    ).toBeUndefined();
    expect(
      decodeFailure({
        ...encodeFailure(failure),
        diagnostic: { ...diagnostic, code: "future-diagnostic" },
      }).diagnostic,
    ).toBeUndefined();
  });

  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(result.hasPendingQuestion).toBe(false);
    expect(result.pendingApproval).toBeNull();
    expect(
      decodeDelegateTaskResult({ ...result, status: "waiting", hasPendingQuestion: true })
        .hasPendingQuestion,
    ).toBe(true);
    const pendingApproval = {
      requestId: "request-approval-1",
      kind: "command",
      runId: "run-child-1",
    };
    expect(
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, input: { command: "private command" } },
      }).pendingApproval,
    ).toEqual(pendingApproval);
    expect(() =>
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, kind: "user_input" },
      }),
    ).toThrow();
  });
});
