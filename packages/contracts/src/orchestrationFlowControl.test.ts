import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetActivityHistoryInput,
  OrchestrationSession,
  OrchestrationThread,
  PendingTurnRecoveryFailure,
} from "./orchestration.ts";

const now = "2026-07-23T10:00:00.000Z";
const decodeCommand = Schema.decodeUnknownSync(OrchestrationCommand);
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const decodeHistoryInput = Schema.decodeUnknownSync(OrchestrationGetActivityHistoryInput);
const decodePendingTurnRecoveryFailure = Schema.decodeUnknownSync(PendingTurnRecoveryFailure);
const decodeSession = Schema.decodeUnknownSync(OrchestrationSession);
const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);

describe("orchestration flow-control contracts", () => {
  it("decodes historical snapshots without recovery or activity-page metadata", () => {
    const session = decodeSession({
      threadId: "thread-1",
      status: "running",
      providerName: "Kimi",
      providerInstanceId: "kimi",
      runtimeMode: "full-access",
      activeTurnId: "turn-1",
      lastError: null,
      updatedAt: now,
    });
    const thread = decodeThread({
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      modelSelection: { instanceId: "kimi", model: "kimi-k2" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session,
    });

    expect(session.recovery).toBeUndefined();
    expect(thread.activityHistory).toBeUndefined();
  });

  it("decodes activity upsert commands and events", () => {
    const activity = {
      id: "tool-activity:abc",
      tone: "tool",
      kind: "tool.updated",
      summary: "Running command",
      payload: { status: "inProgress" },
      turnId: "turn-1",
      createdAt: now,
    };
    const command = decodeCommand({
      type: "thread.activity.upsert",
      commandId: "command-1",
      threadId: "thread-1",
      activity,
      createdAt: now,
    });
    const event = decodeEvent({
      sequence: 1,
      eventId: "event-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: now,
      commandId: "command-1",
      causationEventId: null,
      correlationId: "command-1",
      metadata: {},
      type: "thread.activity-upserted",
      payload: {
        threadId: "thread-1",
        activity,
      },
    });

    expect(command.type).toBe("thread.activity.upsert");
    expect(event.type).toBe("thread.activity-upserted");
  });

  it("validates opaque history cursors and typed recovery failures", () => {
    const request = decodeHistoryInput({
      threadId: "thread-1",
      before: "opaque-cursor",
      limit: 100,
    });
    const failure = decodePendingTurnRecoveryFailure({
      threadId: "thread-1",
      providerInstanceId: "kimi",
      code: "provider-unavailable",
      message: "Kimi is unavailable.",
      occurredAt: now,
    });

    expect(request.before).toBe("opaque-cursor");
    expect(failure.code).toBe("provider-unavailable");
    expect(() =>
      decodeHistoryInput({
        threadId: "thread-1",
        before: "   ",
      }),
    ).toThrow();
  });
});
