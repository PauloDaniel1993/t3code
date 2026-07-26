/**
 * Resolving the model selection a delegated task runs on, and publishing the
 * catalog an agent picks from.
 *
 * `task_create` lets an agent name a model, a reasoning level, or neither. The
 * levels themselves are per-driver and per-model — they come from the live
 * provider snapshot, not from a fixed enum — so a requested level can only be
 * checked against the model it is actually meant for. That check happens here,
 * before the command is dispatched, so an unusable level comes back as a
 * structured error naming the valid ones instead of a session that starts on
 * the wrong effort. `task_models` reads the same snapshot through the same
 * descriptor lookup, so what an agent is told it may pass is by construction
 * what the create path accepts.
 *
 * @module mcp/toolkits/tasks/reasoning
 */
import {
  isProviderAvailable,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProvider,
  type TaskModelsToolOutput,
  type ThreadTaskModelInfo,
  type ThreadTaskProviderInstanceInfo,
  type ThreadTaskReasoningLevel,
} from "@t3tools/contracts";
import {
  createModelSelection,
  findReasoningOptionDescriptor,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  getProviderOptionStringSelectionValue,
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

export type TaskModelCatalogResult =
  | { readonly ok: true; readonly catalog: TaskModelsToolOutput }
  | { readonly ok: false; readonly message: string };

function reasoningLevelsFor(
  model: ServerProvider["models"][number],
): Array<ThreadTaskReasoningLevel> {
  const descriptor = findReasoningOptionDescriptor(
    getProviderOptionDescriptors({ caps: model.capabilities ?? {} }),
  );
  if (descriptor === null) return [];
  const defaultLevel = getProviderOptionCurrentValue(descriptor);
  return descriptor.options.map((option) => ({
    id: option.id,
    label: option.label,
    isDefault: option.id === defaultLevel,
    promptInjected: descriptor.promptInjectedValues?.includes(option.id) ?? false,
  }));
}

function describeInstance(provider: ServerProvider): ThreadTaskProviderInstanceInfo {
  const models: Array<ThreadTaskModelInfo> = provider.models.map((model) => ({
    model: model.slug,
    name: model.name,
    isDefault: model.isDefault === true,
    reasoningLevels: reasoningLevelsFor(model),
  }));
  return {
    instanceId: provider.instanceId,
    provider: provider.driver,
    displayName: provider.displayName ?? provider.instanceId,
    // A configured instance is only worth starting a task on when its driver is
    // installed, switched on, and probing clean. Anything else fails at the
    // turn, so the agent is told before it spends a task on it.
    ready: provider.enabled && provider.installed && provider.status === "ready",
    models,
  };
}

/**
 * The instances, models and reasoning levels a task may be started on, plus
 * what the calling thread itself runs on — the selection a task inherits when
 * the agent names neither.
 */
export function buildTaskModelCatalog(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly instanceId: string | undefined;
}): TaskModelCatalogResult {
  const { current, providers } = input;
  // Instances whose driver this build does not ship are not listed at all:
  // they cannot run anything, so naming them would only invite a failed task.
  const configured = providers.filter(isProviderAvailable);
  const wanted = input.instanceId?.trim();

  const selected =
    wanted === undefined || wanted.length === 0
      ? configured
      : configured.filter((provider) => provider.instanceId === wanted);
  if (selected.length === 0 && wanted !== undefined && wanted.length > 0) {
    return {
      ok: false,
      message: `No provider instance '${wanted}' is configured. Configured instances: ${formatList(
        configured.map((provider) => provider.instanceId),
      )}.`,
    };
  }

  const currentModel = configured
    .find((provider) => provider.instanceId === current.instanceId)
    ?.models.find((model) => model.slug === current.model);
  const currentDescriptor =
    currentModel === undefined
      ? null
      : findReasoningOptionDescriptor(
          getProviderOptionDescriptors({ caps: currentModel.capabilities ?? {} }),
        );
  const currentReasoning =
    currentDescriptor === null
      ? null
      : // What the thread is actually running at: its own selection when it
        // carries one, and the model's default otherwise.
        (getProviderOptionStringSelectionValue(current.options, currentDescriptor.id) ??
        (typeof getProviderOptionCurrentValue(currentDescriptor) === "string"
          ? (getProviderOptionCurrentValue(currentDescriptor) as string)
          : null));

  return {
    ok: true,
    catalog: {
      current: {
        instanceId: current.instanceId,
        model: current.model,
        reasoning: currentReasoning,
      },
      instances: selected.map(describeInstance),
    },
  };
}
