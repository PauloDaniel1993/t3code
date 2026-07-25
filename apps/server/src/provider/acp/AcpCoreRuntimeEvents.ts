import {
  type RuntimeEventRawSource,
  RuntimeItemId,
  type CanonicalRequestType,
  type EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type RuntimeRequestId,
  type ThreadId,
  type ToolLifecycleItemType,
  type TurnId,
} from "@t3tools/contracts";

import type { AcpPermissionRequest, AcpPlanUpdate, AcpToolCallState } from "./AcpRuntimeModel.ts";
import { PROVIDER_EVENT_FLOW_CONTROL } from "../../orchestration/ProviderEventFlowControl.ts";
import { normalizeAcpToolActivity } from "./AcpToolActivityNormalizer.ts";

type AcpAdapterRawSource = Extract<
  RuntimeEventRawSource,
  "acp.jsonrpc" | `acp.${string}.extension`
>;

interface AcpEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

type AcpCanonicalRequestType = Extract<
  CanonicalRequestType,
  "exec_command_approval" | "file_read_approval" | "file_change_approval" | "unknown"
>;

function canonicalRequestTypeFromAcpKind(kind: string | "unknown"): AcpCanonicalRequestType {
  switch (kind) {
    case "execute":
      return "exec_command_approval";
    case "read":
      return "file_read_approval";
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function canonicalItemTypeFromAcpToolKind(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAcpToolRawInput(toolCall: AcpToolCallState): Record<string, unknown> | undefined {
  const rawInput = toolCall.data.rawInput;
  if (isRecord(rawInput)) {
    return rawInput;
  }
  if (typeof rawInput !== "string" || !rawInput.trim().startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(rawInput) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function acpSubagentPresentation(toolCall: AcpToolCallState):
  | {
      readonly title: string;
      readonly detail?: string;
    }
  | undefined {
  const input = parseAcpToolRawInput(toolCall);
  if (input === undefined) {
    return undefined;
  }
  const title = toolCall.title?.trim().toLowerCase();
  const hasAgentIdentity =
    title === "agent" ||
    typeof input.subagent_type === "string" ||
    typeof input.subagentType === "string" ||
    typeof input.resume === "string";
  const hasAgentSwarmIdentity =
    (typeof input.prompt_template === "string" && Array.isArray(input.items)) ||
    isRecord(input.resume_agent_ids);
  const hasAgentTask =
    (typeof input.prompt === "string" || hasAgentSwarmIdentity) &&
    (typeof input.description === "string" || hasAgentIdentity || hasAgentSwarmIdentity);
  if ((!hasAgentIdentity && !hasAgentSwarmIdentity) || !hasAgentTask) {
    return undefined;
  }
  const description =
    typeof input.description === "string" ? input.description.trim() || undefined : undefined;
  const subagentType =
    typeof input.subagent_type === "string"
      ? input.subagent_type.trim() || undefined
      : typeof input.subagentType === "string"
        ? input.subagentType.trim() || undefined
        : undefined;
  const detail =
    description === undefined
      ? subagentType
      : subagentType === undefined
        ? description
        : `${subagentType}: ${description}`;
  return {
    title: input.run_in_background === true ? "Launched background subagent" : "Subagent task",
    ...(detail !== undefined ? { detail } : {}),
  };
}

function runtimeItemStatusFromAcpToolStatus(
  status: AcpToolCallState["status"],
): "inProgress" | "completed" | "failed" | undefined {
  switch (status) {
    case "pending":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

export function makeAcpRequestOpenedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly permissionRequest: AcpPermissionRequest;
  readonly detail: string;
  readonly args: unknown;
  readonly source: AcpAdapterRawSource;
  readonly method: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "request.opened",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      requestType: canonicalRequestTypeFromAcpKind(input.permissionRequest.kind),
      detail: input.detail,
      args: input.args,
    },
    raw: {
      source: input.source,
      method: input.method,
      payload: input.rawPayload,
    },
  };
}

export function makeAcpRequestResolvedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly permissionRequest: AcpPermissionRequest;
  readonly decision: ProviderApprovalDecision;
}): ProviderRuntimeEvent {
  return {
    type: "request.resolved",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      requestType: canonicalRequestTypeFromAcpKind(input.permissionRequest.kind),
      decision: input.decision,
    },
  };
}

export function makeAcpPlanUpdatedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly payload: AcpPlanUpdate;
  readonly source: AcpAdapterRawSource;
  readonly method: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "turn.plan.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: input.payload,
    raw: {
      source: input.source,
      method: input.method,
      payload: input.rawPayload,
    },
  };
}

export function makeAcpToolCallEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly toolCall: AcpToolCallState;
}): ProviderRuntimeEvent {
  const runtimeStatus = runtimeItemStatusFromAcpToolStatus(input.toolCall.status);
  const subagentPresentation = acpSubagentPresentation(input.toolCall);
  const itemType =
    subagentPresentation === undefined
      ? canonicalItemTypeFromAcpToolKind(input.toolCall.kind)
      : "collab_agent_tool_call";
  const normalized = normalizeAcpToolActivity(input.toolCall, {
    detailMaximumBytes: PROVIDER_EVENT_FLOW_CONTROL.intermediateToolDetailMaxBytes,
    terminalDataMaximumBytes: PROVIDER_EVENT_FLOW_CONTROL.terminalToolDataMaxBytes,
  });
  return {
    type:
      input.toolCall.status === "completed" || input.toolCall.status === "failed"
        ? "item.completed"
        : "item.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.make(input.toolCall.toolCallId),
    payload: {
      itemType,
      ...(runtimeStatus ? { status: runtimeStatus } : {}),
      ...(subagentPresentation?.title
        ? { title: subagentPresentation.title }
        : normalized.title
          ? { title: normalized.title }
          : {}),
      ...(subagentPresentation?.detail
        ? { detail: subagentPresentation.detail }
        : normalized.detail
          ? { detail: normalized.detail }
          : {}),
      ...(normalized.data ? { data: normalized.data } : {}),
    },
  };
}

export function makeAcpAssistantItemEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly itemId: string;
  readonly lifecycle: "item.started" | "item.completed";
}): ProviderRuntimeEvent {
  return {
    type: input.lifecycle,
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.make(input.itemId),
    payload: {
      itemType: "assistant_message",
      status: input.lifecycle === "item.completed" ? "completed" : "inProgress",
    },
  };
}

/**
 * ACP `agent_thought_chunk` updates carry the agent's user-visible reasoning.
 * They map to `reasoning_summary_text` because that is the stream kind the
 * orchestration layer buffers into a `turn.reasoning.summary` activity;
 * `reasoning_text` has no consumer today.
 */
export function makeAcpReasoningDeltaEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly text: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: {
      streamKind: "reasoning_summary_text",
      delta: input.text,
    },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}

export function makeAcpContentDeltaEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly itemId?: string;
  readonly text: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    payload: {
      streamKind: "assistant_text",
      delta: input.text,
    },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}
