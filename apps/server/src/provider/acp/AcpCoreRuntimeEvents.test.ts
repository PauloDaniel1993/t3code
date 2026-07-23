import { ProviderDriverKind, RuntimeRequestId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";

describe("AcpCoreRuntimeEvents", () => {
  it("maps ACP permission requests to canonical runtime events", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");
    const permissionRequest = {
      kind: "execute" as const,
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending" as const,
        command: "cat package.json",
        detail: "cat package.json",
        data: { toolCallId: "tool-1", kind: "execute" },
      },
    };

    expect(
      makeAcpRequestOpenedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        detail: "cat package.json",
        args: { command: ["cat", "package.json"] },
        source: "acp.jsonrpc",
        method: "session/request_permission",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "request.opened",
      payload: {
        requestType: "exec_command_approval",
        detail: "cat package.json",
      },
    });

    expect(
      makeAcpRequestResolvedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        decision: "accept",
      }),
    ).toMatchObject({
      type: "request.resolved",
      payload: {
        requestType: "exec_command_approval",
        decision: "accept",
      },
    });
  });

  it("maps ACP core plan, tool-call, and content updates", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");

    expect(
      makeAcpPlanUpdatedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        payload: {
          plan: [{ step: "Inspect state", status: "inProgress" }],
        },
        source: "acp.cursor.extension",
        method: "cursor/update_todos",
        rawPayload: { todos: [] },
      }),
    ).toMatchObject({
      type: "turn.plan.updated",
      raw: {
        method: "cursor/update_todos",
      },
    });

    expect(
      makeAcpToolCallEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          status: "completed",
          title: "Terminal",
          detail: "bun run test",
          data: { command: "bun run test" },
        },
      }),
    ).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
      },
    });

    expect(
      makeAcpContentDeltaEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        text: "hello",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "content.delta",
      itemId: "assistant:session-1:segment:0",
      payload: {
        delta: "hello",
      },
    });

    expect(
      makeAcpAssistantItemEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        lifecycle: "item.started",
      }),
    ).toMatchObject({
      type: "item.started",
      itemId: "assistant:session-1:segment:0",
      payload: {
        itemType: "assistant_message",
        status: "inProgress",
      },
    });
  });

  it("classifies ACP Agent calls without exposing the full delegated prompt", () => {
    const event = makeAcpToolCallEvent({
      stamp: { eventId: "event-agent" as never, createdAt: "2026-07-23T00:00:00.000Z" },
      provider: ProviderDriverKind.make("kimi"),
      threadId: "thread-agent" as never,
      turnId: TurnId.make("turn-agent"),
      toolCall: {
        toolCallId: "tool-agent",
        status: "completed",
        title: "Tool",
        detail: '{"description":"Verify backend","prompt":"long private delegation prompt"}',
        data: {
          rawInput:
            '{"description":"Verify backend","prompt":"long private delegation prompt","subagent_type":"explore","run_in_background":true}',
          rawOutput: "status: running",
        },
      },
    });

    expect(event).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        title: "Launched background subagent",
        detail: "explore: Verify backend",
      },
    });
    if (event.type === "item.completed") {
      expect(event.payload.detail).not.toContain("long private delegation prompt");
    }

    expect(
      makeAcpToolCallEvent({
        stamp: { eventId: "event-agent-foreground" as never, createdAt: "2026-07-23T00:00:01Z" },
        provider: ProviderDriverKind.make("kimi"),
        threadId: "thread-agent" as never,
        turnId: TurnId.make("turn-agent"),
        toolCall: {
          toolCallId: "tool-agent-foreground",
          status: "inProgress",
          title: "Agent",
          data: {
            rawInput: {
              description: "Review UI",
              prompt: "Review the UI implementation",
              subagent_type: "explore",
            },
          },
        },
      }),
    ).toMatchObject({
      type: "item.updated",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        title: "Subagent task",
        detail: "explore: Review UI",
      },
    });
  });
});
