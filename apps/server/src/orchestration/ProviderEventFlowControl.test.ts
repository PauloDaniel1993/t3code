import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDER_EVENT_FLOW_CONTROL,
  classifyProviderEvent,
  providerEventMergeKey,
  providerEventReplacementKey,
  stableReplaceableActivityId,
  stableToolActivityId,
} from "./ProviderEventFlowControl.ts";

const baseEvent = {
  eventId: EventId.make("event-1"),
  provider: ProviderDriverKind.make("kimi"),
  providerInstanceId: ProviderInstanceId.make("kimi-personal"),
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  createdAt: "2026-07-23T10:00:00.000Z",
} as const;

describe("ProviderEventFlowControl", () => {
  it("defines internally consistent bounded defaults", () => {
    expect(PROVIDER_EVENT_FLOW_CONTROL.acpToolProgressCoalesceIntervalMs).toBeGreaterThan(0);
    expect(PROVIDER_EVENT_FLOW_CONTROL.acpSessionEventQueueCapacity).toBeGreaterThan(
      PROVIDER_EVENT_FLOW_CONTROL.perThreadQueueCapacity,
    );
    expect(PROVIDER_EVENT_FLOW_CONTROL.perThreadQueueCapacity).toBeGreaterThan(
      PROVIDER_EVENT_FLOW_CONTROL.reservedLosslessCapacity,
    );
    expect(PROVIDER_EVENT_FLOW_CONTROL.maximumActivityHistoryPageSize).toBeGreaterThanOrEqual(
      PROVIDER_EVENT_FLOW_CONTROL.activityHistoryPageSize,
    );
    expect(PROVIDER_EVENT_FLOW_CONTROL.terminalToolDataMaxBytes).toBeGreaterThan(
      PROVIDER_EVENT_FLOW_CONTROL.intermediateToolDetailMaxBytes,
    );
  });

  it("classifies terminal, mergeable, and replaceable events", () => {
    const updated: ProviderRuntimeEvent = {
      ...baseEvent,
      type: "item.updated",
      itemId: RuntimeItemId.make("tool-1"),
      payload: { itemType: "command_execution", status: "inProgress" },
    };
    const delta: ProviderRuntimeEvent = {
      ...baseEvent,
      type: "content.delta",
      itemId: RuntimeItemId.make("assistant-1"),
      payload: { streamKind: "assistant_text", delta: "hello" },
    };
    const completed: ProviderRuntimeEvent = {
      ...baseEvent,
      type: "turn.completed",
      payload: { state: "completed" },
    };

    expect(classifyProviderEvent(updated)).toBe("replaceable");
    expect(classifyProviderEvent(delta)).toBe("mergeable");
    expect(classifyProviderEvent(completed)).toBe("lossless");
  });

  it("derives stable, distinct, opaque tool activity identities", () => {
    const first: ProviderRuntimeEvent = {
      ...baseEvent,
      type: "item.updated",
      itemId: RuntimeItemId.make("tool-1"),
      payload: { itemType: "command_execution", status: "inProgress" },
    };
    const latest: ProviderRuntimeEvent = {
      ...first,
      eventId: EventId.make("event-2"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        detail: "new detail",
      },
    };
    const other: ProviderRuntimeEvent = {
      ...first,
      itemId: RuntimeItemId.make("tool-2"),
    };
    const progress: ProviderRuntimeEvent = {
      ...baseEvent,
      type: "tool.progress",
      payload: {
        toolUseId: RuntimeItemId.make("tool-1"),
        toolName: "Bash",
        summary: "Running tests",
      },
    };

    expect(stableToolActivityId(first)).toBe(stableToolActivityId(latest));
    expect(stableToolActivityId(first)).toBe(stableToolActivityId(progress));
    expect(stableToolActivityId(first)).not.toBe(stableToolActivityId(other));
    expect(stableToolActivityId(first)).not.toContain("tool-1");
    expect(providerEventReplacementKey(first)).toBe(providerEventReplacementKey(latest));
  });

  it("does not coalesce tool progress without a logical tool identity", () => {
    const anonymousProgress: ProviderRuntimeEvent = {
      ...baseEvent,
      type: "tool.progress",
      payload: {
        summary: "Working",
      },
    };

    expect(providerEventReplacementKey(anonymousProgress)).toBeUndefined();
    expect(stableToolActivityId(anonymousProgress)).toBeUndefined();
  });

  it("keeps replacement keys separate for identified tools in the same turn", () => {
    const first: ProviderRuntimeEvent = {
      ...baseEvent,
      type: "tool.progress",
      itemId: RuntimeItemId.make("mcp-tool-1"),
      payload: {
        summary: "First",
      },
    };
    const second: ProviderRuntimeEvent = {
      ...first,
      eventId: EventId.make("event-2"),
      itemId: RuntimeItemId.make("mcp-tool-2"),
      payload: {
        summary: "Second",
      },
    };

    expect(providerEventReplacementKey(first)).not.toBe(providerEventReplacementKey(second));
    expect(stableToolActivityId(first)).not.toBe(stableToolActivityId(second));
  });

  it("derives stable activity identities for replaceable task and token snapshots", () => {
    const tokenUsage: ProviderRuntimeEvent = {
      ...baseEvent,
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 10,
        },
      },
    };
    const latestTokenUsage: ProviderRuntimeEvent = {
      ...tokenUsage,
      eventId: EventId.make("event-2"),
      payload: {
        usage: {
          usedTokens: 20,
        },
      },
    };
    const taskProgress: ProviderRuntimeEvent = {
      ...baseEvent,
      type: "task.progress",
      payload: {
        taskId: RuntimeTaskId.make("task-1"),
        description: "Working",
      },
    };

    expect(stableReplaceableActivityId(tokenUsage)).toBe(
      stableReplaceableActivityId(latestTokenUsage),
    );
    expect(stableReplaceableActivityId(taskProgress)).toBeDefined();
    expect(stableReplaceableActivityId(taskProgress)).not.toBe(
      stableReplaceableActivityId(tokenUsage),
    );
  });

  it("keeps assistant streams separate by item and stream coordinates", () => {
    const first: ProviderRuntimeEvent = {
      ...baseEvent,
      type: "content.delta",
      itemId: RuntimeItemId.make("assistant-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "one",
        contentIndex: 0,
      },
    };
    const second: ProviderRuntimeEvent = {
      ...first,
      eventId: EventId.make("event-2"),
      payload: {
        ...first.payload,
        delta: "two",
      },
    };
    const reasoning: ProviderRuntimeEvent = {
      ...first,
      payload: {
        streamKind: "reasoning_text",
        delta: "reasoning",
        contentIndex: 0,
      },
    };

    expect(providerEventMergeKey(first)).toBe(providerEventMergeKey(second));
    expect(providerEventMergeKey(first)).not.toBe(providerEventMergeKey(reasoning));
  });
});
