import type {
  ModelSelection,
  OrchestrationSession,
  OrchestrationLatestTurn,
  ProviderInstanceId,
} from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../providerInstances";

export interface HandoffMessage {
  readonly text: string;
  readonly streaming: boolean;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
}

export interface HandoffSourceThread {
  readonly id: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly messages: ReadonlyArray<HandoffMessage>;
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
}

export function isImportableHandoffMessage(message: HandoffMessage): boolean {
  if (message.streaming) {
    return false;
  }
  return message.text.trim().length > 0 || (message.attachments?.length ?? 0) > 0;
}

export function countImportableHandoffMessages(messages: ReadonlyArray<HandoffMessage>): number {
  return messages.filter(isImportableHandoffMessage).length;
}

export function getHandoffSourceDisabledReason(input: {
  readonly isServerThread: boolean;
  readonly thread: HandoffSourceThread | null | undefined;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
}): string | null {
  if (!input.isServerThread || !input.thread) {
    return "Hand off is available for server threads only.";
  }
  if (input.thread.deletedAt !== null) {
    return "Deleted threads cannot be handed off.";
  }
  if (input.thread.archivedAt !== null) {
    return "Archived threads cannot be handed off.";
  }
  if (
    input.thread.session?.status === "running" ||
    input.thread.session?.activeTurnId != null ||
    input.thread.latestTurn?.state === "running"
  ) {
    return "Wait for the current turn to finish before handing off.";
  }
  if (input.hasPendingApproval) {
    return "Resolve the pending approval before handing off.";
  }
  if (input.hasPendingUserInput) {
    return "Answer the pending provider prompt before handing off.";
  }
  if (countImportableHandoffMessages(input.thread.messages) === 0) {
    return "This thread has no completed messages to import.";
  }
  return null;
}

export function getHandoffTargetDisabledReason(input: {
  readonly entry: ProviderInstanceEntry;
  readonly sourceInstanceId: ProviderInstanceId;
  readonly modelCount: number;
}): string | null {
  if (input.entry.instanceId === input.sourceInstanceId) {
    return "Already using this provider instance.";
  }
  if (!input.entry.enabled) {
    return "Provider instance is disabled.";
  }
  if (!input.entry.isAvailable || !input.entry.installed) {
    return "Provider driver is unavailable in this build.";
  }
  if (input.entry.status !== "ready") {
    return "Provider instance is not ready.";
  }
  if (input.modelCount === 0) {
    return "Provider instance has no selectable models.";
  }
  return null;
}

export interface HandoffTargetOption {
  readonly entry: ProviderInstanceEntry;
  readonly modelSelection: ModelSelection;
  readonly disabledReason: string | null;
}

export function buildHandoffTargetOptions(input: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly sourceInstanceId: ProviderInstanceId;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<{ slug: string }>>;
  readonly stickyModelSelectionByProvider?: Partial<Record<ProviderInstanceId, ModelSelection>>;
}): HandoffTargetOption[] {
  return input.entries
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const modelOptions = input.modelOptionsByInstance.get(entry.instanceId) ?? [];
      const stickySelection = input.stickyModelSelectionByProvider?.[entry.instanceId];
      const selectedModel =
        stickySelection && modelOptions.some((option) => option.slug === stickySelection.model)
          ? stickySelection.model
          : (modelOptions[0]?.slug ?? entry.models[0]?.slug ?? "");
      return {
        entry,
        modelSelection: {
          instanceId: entry.instanceId,
          model: selectedModel,
          ...(stickySelection?.options !== undefined ? { options: stickySelection.options } : {}),
        },
        disabledReason: getHandoffTargetDisabledReason({
          entry,
          sourceInstanceId: input.sourceInstanceId,
          modelCount: modelOptions.length || entry.models.length,
        }),
      };
    });
}

export function resolveInitialHandoffTarget(
  options: ReadonlyArray<HandoffTargetOption>,
  preferredInstanceId: ProviderInstanceId | null | undefined,
): HandoffTargetOption | null {
  if (preferredInstanceId) {
    const preferred = options.find(
      (option) => option.entry.instanceId === preferredInstanceId && option.disabledReason === null,
    );
    if (preferred) {
      return preferred;
    }
  }
  return options.find((option) => option.disabledReason === null) ?? null;
}

export interface HandoffDraftCopy {
  readonly prompt: string;
}

export function buildHandoffDraftCopy(input: {
  readonly prompt: string | null | undefined;
}): HandoffDraftCopy | null {
  const prompt = input.prompt?.trimEnd() ?? "";
  return prompt.length > 0 ? { prompt } : null;
}
