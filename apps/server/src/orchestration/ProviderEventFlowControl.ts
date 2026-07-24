import * as NodeCrypto from "node:crypto";

import {
  EventId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeEventV2,
} from "@t3tools/contracts";

export const PROVIDER_EVENT_FLOW_CONTROL = {
  acpToolProgressCoalesceIntervalMs: 100,
  acpSessionEventQueueCapacity: 512,
  perThreadQueueCapacity: 256,
  reservedLosslessCapacity: 64,
  mergedAssistantDeltaMaxBytes: 32 * 1024,
  intermediateToolDetailMaxBytes: 4 * 1024,
  terminalToolDataMaxBytes: 64 * 1024,
  initialActivityPageSize: 200,
  activityHistoryPageSize: 200,
  maximumActivityHistoryPageSize: 500,
  logicalCompactionBatchSize: 250,
} as const;

export type ProviderEventDeliveryClass = "lossless" | "mergeable" | "replaceable";

const REPLACEABLE_EVENT_TYPES: ReadonlySet<ProviderRuntimeEventV2["type"]> = new Set([
  "thread.token-usage.updated",
  "item.updated",
  "task.progress",
  "hook.progress",
  "tool.progress",
  "account.updated",
  "account.rate-limits.updated",
  "mcp.status.updated",
]);

const MERGEABLE_EVENT_TYPES: ReadonlySet<ProviderRuntimeEventV2["type"]> = new Set([
  "content.delta",
  "turn.proposed.delta",
]);

export function classifyProviderEvent(event: ProviderRuntimeEvent): ProviderEventDeliveryClass {
  if (REPLACEABLE_EVENT_TYPES.has(event.type)) {
    return "replaceable";
  }
  if (MERGEABLE_EVENT_TYPES.has(event.type)) {
    return "mergeable";
  }
  return "lossless";
}

const encodeIdentityParts = (parts: ReadonlyArray<string>): string =>
  parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("|");

const hashedIdentity = (namespace: string, parts: ReadonlyArray<string>): string =>
  NodeCrypto.createHash("sha256")
    .update(`${namespace}|${encodeIdentityParts(parts)}`)
    .digest("hex")
    .slice(0, 32);

const providerIdentity = (event: ProviderRuntimeEvent): string =>
  event.providerInstanceId ?? event.provider;

const toolItemIdentity = (event: ProviderRuntimeEvent): string | undefined => {
  if (event.type === "tool.progress") {
    return (
      event.payload.toolUseId ??
      event.itemId ??
      event.providerRefs?.providerItemId ??
      event.payload.taskId
    );
  }
  return event.itemId ?? event.providerRefs?.providerItemId;
};

export function stableToolActivityId(event: ProviderRuntimeEvent): EventId | undefined {
  const itemIdentity = toolItemIdentity(event);
  if (event.turnId === undefined || itemIdentity === undefined) {
    return undefined;
  }

  return EventId.make(
    `tool-activity:${hashedIdentity("tool-activity", [
      providerIdentity(event),
      event.threadId,
      event.turnId,
      itemIdentity,
    ])}`,
  );
}

export function stableReplaceableActivityId(event: ProviderRuntimeEvent): EventId | undefined {
  const toolActivityId = stableToolActivityId(event);
  if (toolActivityId !== undefined) {
    return toolActivityId;
  }

  switch (event.type) {
    case "thread.token-usage.updated":
      return EventId.make(
        `context-window-activity:${hashedIdentity("context-window-activity", [
          providerIdentity(event),
          event.threadId,
        ])}`,
      );
    case "task.progress":
      return EventId.make(
        `task-progress-activity:${hashedIdentity("task-progress-activity", [
          providerIdentity(event),
          event.threadId,
          event.turnId ?? "",
          event.payload.taskId,
        ])}`,
      );
    default:
      return undefined;
  }
}

export function providerEventReplacementKey(event: ProviderRuntimeEvent): string | undefined {
  if (classifyProviderEvent(event) !== "replaceable") {
    return undefined;
  }

  switch (event.type) {
    case "item.updated": {
      const activityId = stableToolActivityId(event);
      return activityId === undefined ? undefined : `item:${activityId}`;
    }
    case "thread.token-usage.updated":
      return `token-usage:${hashedIdentity("token-usage", [
        providerIdentity(event),
        event.threadId,
      ])}`;
    case "task.progress":
      return `task:${hashedIdentity("task-progress", [
        providerIdentity(event),
        event.threadId,
        event.turnId ?? "",
        event.payload.taskId,
      ])}`;
    case "hook.progress":
      return `hook:${hashedIdentity("hook-progress", [
        providerIdentity(event),
        event.threadId,
        event.turnId ?? "",
        event.payload.hookId,
      ])}`;
    case "tool.progress": {
      const logicalTool =
        event.payload.toolUseId ??
        event.payload.taskId ??
        event.itemId ??
        event.providerRefs?.providerItemId;
      if (logicalTool === undefined) {
        return undefined;
      }
      return `tool-progress:${hashedIdentity("tool-progress", [
        providerIdentity(event),
        event.threadId,
        event.turnId ?? "",
        logicalTool,
      ])}`;
    }
    case "account.updated":
    case "account.rate-limits.updated":
    case "mcp.status.updated":
      return `provider-state:${hashedIdentity(event.type, [
        providerIdentity(event),
        event.threadId,
      ])}`;
  }
}

export function providerEventMergeKey(event: ProviderRuntimeEvent): string | undefined {
  if (classifyProviderEvent(event) !== "mergeable") {
    return undefined;
  }

  if (event.type === "content.delta") {
    return `content:${hashedIdentity("content-delta", [
      providerIdentity(event),
      event.threadId,
      event.turnId ?? "",
      event.itemId ?? "",
      event.payload.streamKind,
      String(event.payload.contentIndex ?? ""),
      String(event.payload.summaryIndex ?? ""),
    ])}`;
  }

  return `proposed-plan:${hashedIdentity("turn-proposed-delta", [
    providerIdentity(event),
    event.threadId,
    event.turnId ?? "",
  ])}`;
}
