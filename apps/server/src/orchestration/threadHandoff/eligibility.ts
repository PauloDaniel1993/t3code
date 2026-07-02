import {
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";

export function makeImportedHandoffMessageId(input: {
  readonly targetThreadId: ThreadId;
  readonly sourceMessageId: MessageId;
}): MessageId {
  return MessageId.make(`handoff:${input.targetThreadId}:${input.sourceMessageId}`);
}

export function isImportableHandoffMessage(message: OrchestrationMessage): boolean {
  if (message.streaming) {
    return false;
  }
  const hasText = message.text.trim().length > 0;
  const hasAttachments = (message.attachments?.length ?? 0) > 0;
  return hasText || hasAttachments;
}

export function hasNativeMessageAfterPreviousImports(thread: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
}): boolean {
  const lastImportedIndex = thread.messages.findLastIndex(
    (message) => message.source === "handoff-import",
  );
  if (lastImportedIndex < 0) {
    return true;
  }
  return thread.messages
    .slice(lastImportedIndex + 1)
    .some((message) => message.source !== "handoff-import");
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  const leftSequence = left.sequence ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.sequence ?? Number.MAX_SAFE_INTEGER;
  if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  const createdAt = left.createdAt.localeCompare(right.createdAt);
  if (createdAt !== 0) {
    return createdAt;
  }
  return left.id.localeCompare(right.id);
}

function activityPayloadRecord(
  activity: OrchestrationThreadActivity,
): Record<string, unknown> | null {
  return activity.payload && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function requestIdFromActivity(activity: OrchestrationThreadActivity): string | null {
  const payload = activityPayloadRecord(activity);
  return typeof payload?.requestId === "string" ? payload.requestId : null;
}

function detailFromActivity(activity: OrchestrationThreadActivity): string | undefined {
  const payload = activityPayloadRecord(activity);
  return typeof payload?.detail === "string" ? payload.detail : undefined;
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  if (!detail) {
    return false;
  }
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request") ||
    normalized.includes("unknown pending user input request") ||
    normalized.includes("unknown pending codex user input request")
  );
}

export function hasPendingHandoffSourceApproval(thread: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}): boolean {
  const openRequestIds = new Set<string>();
  for (const activity of [...thread.activities].toSorted(compareActivitiesByOrder)) {
    const requestId = requestIdFromActivity(activity);
    if (!requestId) {
      continue;
    }
    if (activity.kind === "approval.requested") {
      openRequestIds.add(requestId);
      continue;
    }
    if (activity.kind === "approval.resolved") {
      openRequestIds.delete(requestId);
      continue;
    }
    if (
      activity.kind === "provider.approval.respond.failed" &&
      isStalePendingRequestFailureDetail(detailFromActivity(activity))
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size > 0;
}

export function hasPendingHandoffSourceUserInput(thread: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}): boolean {
  const openRequestIds = new Set<string>();
  for (const activity of [...thread.activities].toSorted(compareActivitiesByOrder)) {
    const requestId = requestIdFromActivity(activity);
    if (!requestId) {
      continue;
    }
    if (activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
      continue;
    }
    if (activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
      continue;
    }
    if (
      activity.kind === "provider.user-input.respond.failed" &&
      isStalePendingRequestFailureDetail(detailFromActivity(activity))
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size > 0;
}

export function getHandoffSourceRejectionDetail(thread: OrchestrationThread): string | null {
  if (thread.deletedAt !== null) {
    return `Thread '${thread.id}' is deleted and cannot be handed off.`;
  }
  if (thread.archivedAt !== null) {
    return `Thread '${thread.id}' is archived and cannot be handed off.`;
  }
  if (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.session?.activeTurnId != null
  ) {
    return `Thread '${thread.id}' has an active turn and cannot be handed off.`;
  }
  if (hasPendingHandoffSourceApproval(thread)) {
    return `Thread '${thread.id}' has a pending approval and cannot be handed off.`;
  }
  if (hasPendingHandoffSourceUserInput(thread)) {
    return `Thread '${thread.id}' is waiting for provider input and cannot be handed off.`;
  }
  if (thread.handoff !== null && !hasNativeMessageAfterPreviousImports(thread)) {
    return `Thread '${thread.id}' needs a native message before another handoff.`;
  }
  if (!thread.messages.some(isImportableHandoffMessage)) {
    return `Thread '${thread.id}' has no importable messages for handoff.`;
  }
  return null;
}

export type HandoffTargetModelValidation =
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly detail: string;
    };

export function validateReadyHandoffTargetModel(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelSelection: ModelSelection;
}): HandoffTargetModelValidation {
  const provider = input.providers.find(
    (snapshot) => snapshot.instanceId === input.modelSelection.instanceId,
  );
  if (provider === undefined) {
    return {
      ok: false,
      detail: `Target provider instance '${input.modelSelection.instanceId}' is not configured and cannot receive handoff.`,
    };
  }
  if (!isProviderAvailable(provider)) {
    return {
      ok: false,
      detail: `Target provider instance '${input.modelSelection.instanceId}' is unavailable and cannot receive handoff.`,
    };
  }
  if (!provider.enabled) {
    return {
      ok: false,
      detail: `Target provider instance '${input.modelSelection.instanceId}' is disabled and cannot receive handoff.`,
    };
  }
  if (!provider.installed) {
    return {
      ok: false,
      detail: `Target provider instance '${input.modelSelection.instanceId}' is not installed and cannot receive handoff.`,
    };
  }
  if (provider.status !== "ready") {
    return {
      ok: false,
      detail: `Target provider instance '${input.modelSelection.instanceId}' is not ready and cannot receive handoff.`,
    };
  }
  if (provider.models.length === 0) {
    return {
      ok: false,
      detail: `Target provider instance '${input.modelSelection.instanceId}' has no selectable models and cannot receive handoff.`,
    };
  }
  if (!provider.models.some((model) => model.slug === input.modelSelection.model)) {
    return {
      ok: false,
      detail: `Target provider instance '${input.modelSelection.instanceId}' does not expose model '${input.modelSelection.model}' for handoff.`,
    };
  }
  return { ok: true };
}
