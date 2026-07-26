/**
 * Resolving the model selection a delegated task runs on.
 *
 * `task_create` lets an agent name a model, a reasoning level, or neither. The
 * levels themselves are per-driver and per-model — they come from the live
 * provider snapshot, not from a fixed enum — so a requested level can only be
 * checked against the model it is actually meant for. That check happens here,
 * before the command is dispatched, so an unusable level comes back as a
 * structured error naming the valid ones instead of a session that starts on
 * the wrong effort.
 *
 * @module mcp/toolkits/tasks/reasoning
 */
import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionSelection,
  ServerProvider,
} from "@t3tools/contracts";
import {
  createModelSelection,
  findReasoningOptionDescriptor,
  getProviderOptionDescriptors,
  resolveReasoningOptionChoiceId,
} from "@t3tools/shared/model";

export interface TaskModelOverride {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}

export type TaskModelSelectionResolution =
  | {
      readonly ok: true;
      /** Absent means "inherit the parent thread's selection untouched". */
      readonly modelSelection?: ModelSelection;
    }
  | { readonly ok: false; readonly message: string };

/** Enough of a list to be actionable without flooding the tool result. */
const MAX_LISTED = 12;

function formatList(values: ReadonlyArray<string>): string {
  const listed = values.slice(0, MAX_LISTED);
  const suffix = values.length > listed.length ? `, … (${values.length} total)` : "";
  return `${listed.join(", ")}${suffix}`;
}

export function resolveTaskModelSelection(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly parentSelection: ModelSelection;
  readonly override: TaskModelOverride | undefined;
  readonly reasoning: string | undefined;
}): TaskModelSelectionResolution {
  const { override, parentSelection, providers, reasoning } = input;
  const requested = reasoning?.trim();

  if (!requested) {
    return override === undefined
      ? { ok: true }
      : { ok: true, modelSelection: createModelSelection(override.instanceId, override.model) };
  }

  // Without an override the level lands on the model the task would have
  // inherited anyway, so the parent's own options are the baseline to edit.
  const instanceId = override?.instanceId ?? parentSelection.instanceId;
  const model = override?.model ?? parentSelection.model;
  const baseOptions: ReadonlyArray<ProviderOptionSelection> =
    override === undefined ? (parentSelection.options ?? []) : [];

  const instance = providers.find((provider) => provider.instanceId === instanceId);
  if (instance === undefined) {
    return {
      ok: false,
      message: `No provider instance '${instanceId}' is configured. Configured instances: ${formatList(
        providers.map((provider) => provider.instanceId),
      )}.`,
    };
  }

  const snapshotModel = instance.models.find((candidate) => candidate.slug === model);
  if (snapshotModel === undefined) {
    return {
      ok: false,
      message: `Provider instance '${instanceId}' has no model '${model}', so its reasoning levels are unknown. Available models: ${formatList(
        instance.models.map((candidate) => candidate.slug),
      )}.`,
    };
  }

  const descriptor = findReasoningOptionDescriptor(
    getProviderOptionDescriptors({ caps: snapshotModel.capabilities ?? {} }),
  );
  if (descriptor === null) {
    return {
      ok: false,
      message: `Model '${model}' on provider instance '${instanceId}' has no reasoning level to set. Omit 'reasoning' for this model.`,
    };
  }

  const choiceId = resolveReasoningOptionChoiceId(descriptor, requested);
  if (choiceId === null) {
    return {
      ok: false,
      message: `'${requested}' is not a ${descriptor.label.toLowerCase()} level for model '${model}' on provider instance '${instanceId}'. Valid levels: ${formatList(
        descriptor.options.map((option) => option.id),
      )}.`,
    };
  }

  return {
    ok: true,
    modelSelection: createModelSelection(instanceId, model, [
      ...baseOptions.filter((option) => option.id !== descriptor.id),
      { id: descriptor.id, value: choiceId },
    ]),
  };
}
