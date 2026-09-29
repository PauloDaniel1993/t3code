import {
  OrchestratorMcpFailure,
  ThreadId,
  type ForkTaskCancelInput,
  type ForkTaskCreateInput,
  type ForkTaskModelsInput,
  type ForkTaskModelsResult,
  type ModelSelection,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import type { OrchestratorMcpServiceShape } from "./OrchestratorMcpService.ts";
import { summarizeForkTask } from "./OrchestratorTaskList.ts";

const fold = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, "");

function reasoningDescriptor(descriptors: readonly ProviderOptionDescriptor[] = []) {
  const selects = descriptors.filter((descriptor) => descriptor.type === "select");
  return (
    selects.find((descriptor) =>
      ["reasoningeffort", "effort", "thinking", "variant"].includes(fold(descriptor.id)),
    ) ??
    selects.find((descriptor) =>
      /reason|effort|thinking/.test(fold(descriptor.id) + fold(descriptor.label)),
    )
  );
}

const readParent = Effect.fn("ForkTaskAliases.readParent")(function* (scope: McpInvocationScope) {
  const threads = yield* ThreadManagementService;
  return yield* threads.getThreadRecords(scope.threadId, ["subagents"]).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Could not read the calling thread's task settings.",
        }),
    ),
  );
});

export const forkTaskModels = Effect.fn("ForkTaskAliases.models")(function* (
  scope: McpInvocationScope,
  input: ForkTaskModelsInput,
  service: OrchestratorMcpServiceShape,
) {
  // Native capabilities enforce scope and adapter readiness; retain the fork's field names.
  const capabilities = yield* service.capabilities(scope);
  const parent = yield* readParent(scope);
  const registry = yield* ProviderRegistry;
  const providers = yield* registry.getProviders;
  const selection = parent.thread.modelSelection;
  const currentModel = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((model) => model.slug === selection.model);
  const descriptor = reasoningDescriptor(currentModel?.capabilities?.optionDescriptors);
  const currentReasoning =
    descriptor === undefined
      ? null
      : (selection.options?.find((option) => option.id === descriptor.id)?.value ??
        getProviderOptionCurrentValue(descriptor) ??
        null);
  const selected = capabilities.providers.filter(
    (provider) =>
      input.instanceId === undefined || provider.providerInstanceId === input.instanceId.trim(),
  );
  if (input.instanceId !== undefined && selected.length === 0) {
    return yield* new OrchestratorMcpFailure({
      code: "provider_unavailable",
      message: `No provider instance '${input.instanceId}' is configured.`,
    });
  }
  return {
    current: {
      instanceId: selection.instanceId,
      model: selection.model,
      reasoning: typeof currentReasoning === "string" ? currentReasoning : null,
    },
    instances: selected.map((instance) => {
      const provider = providers.find(
        (provider) => provider.instanceId === instance.providerInstanceId,
      );
      return {
        instanceId: instance.providerInstanceId,
        provider: instance.driverKind,
        displayName: instance.displayName ?? instance.providerInstanceId,
        ready: instance.canRunChildTask && provider?.status === "ready",
        models: instance.models.map((model) => {
          const descriptor = reasoningDescriptor(model.options);
          return {
            model: model.id,
            name: model.label ?? model.id,
            isDefault:
              provider?.models.find((entry) => entry.slug === model.id)?.isDefault === true,
            reasoningLevels:
              descriptor?.type === "select"
                ? descriptor.options.map((choice) => ({
                    id: choice.id,
                    label: choice.label,
                    isDefault: choice.id === getProviderOptionCurrentValue(descriptor),
                    promptInjected: descriptor.promptInjectedValues?.includes(choice.id) ?? false,
                  }))
                : [],
          };
        }),
      };
    }),
  } satisfies ForkTaskModelsResult;
});

export const forkTaskCreate = Effect.fn("ForkTaskAliases.create")(function* (
  scope: McpInvocationScope,
  input: ForkTaskCreateInput,
  service: OrchestratorMcpServiceShape,
) {
  const capabilities = yield* service.capabilities(scope);
  if (input.context !== "none") {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `V2 cannot pass a conversation slice for context '${input.context}'. The supported context value is 'none'; include needed context in prompt.`,
    });
  }
  const parent = yield* readParent(scope);
  const inherited = parent.thread.modelSelection;
  const instanceId = input.model?.instanceId ?? inherited.instanceId;
  const model = input.model?.model ?? inherited.model;
  const targetModel = capabilities.providers
    .find((provider) => provider.providerInstanceId === instanceId)
    ?.models.find((entry) => entry.id === model);
  let options: ModelSelection["options"];
  let prompt = input.prompt;
  if (input.reasoning !== undefined) {
    if (targetModel === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "model_unavailable",
        message: `Model '${model}' on instance '${instanceId}' is not advertised by task_models.`,
      });
    }
    const descriptor = reasoningDescriptor(targetModel.options);
    if (descriptor?.type !== "select") {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Model '${model}' has no reasoning levels. Omit reasoning for this model.`,
      });
    }
    const choice = descriptor.options.find(
      (choice) =>
        fold(choice.id) === fold(input.reasoning!) || fold(choice.label) === fold(input.reasoning!),
    );
    if (choice === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Unsupported reasoning '${input.reasoning}' for model '${model}'. Valid levels: ${descriptor.options.map((choice) => choice.id).join(", ")}.`,
      });
    }
    const base =
      instanceId === inherited.instanceId && model === inherited.model
        ? (inherited.options ?? [])
        : (buildProviderOptionSelectionsFromDescriptors(targetModel.options) ?? []);
    options = [
      ...base.filter((option) => option.id !== descriptor.id),
      { id: descriptor.id, value: choice.id },
    ];
    if (descriptor.promptInjectedValues?.includes(choice.id)) prompt = `${choice.id}\n\n${prompt}`;
  }
  const status = yield* service.delegateTask(scope, {
    task: prompt,
    title: input.title,
    target: {
      providerInstanceId: instanceId,
      model,
      ...(options === undefined ? {} : { options }),
    },
    ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
  });
  const createdParent = yield* readParent(scope);
  const task = createdParent.subagents.find((task) => task.id === status.taskId);
  if (task === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "task_not_found",
      message: "Created task could not be read.",
    });
  return summarizeForkTask(task, status);
});

export const forkTaskCancel = Effect.fn("ForkTaskAliases.cancel")(function* (
  scope: McpInvocationScope,
  input: ForkTaskCancelInput,
  service: OrchestratorMcpServiceShape,
) {
  // Leave native taskId calls on the native path, with the native result shape.
  if (input.threadId === undefined && input.taskId !== undefined)
    return yield* service.cancelTask(scope, { ...input, taskId: input.taskId });
  yield* service.capabilities(scope);
  const parent = yield* readParent(scope);
  const task = parent.subagents.find(
    (task) =>
      task.origin === "app_owned" &&
      task.threadId === scope.threadId &&
      task.childThreadId === ThreadId.make(input.threadId!),
  );
  if (task === undefined || (input.taskId !== undefined && input.taskId !== task.id)) {
    return yield* new OrchestratorMcpFailure({
      code: "task_not_found",
      message: "The requested task is not owned by this thread, or taskId and threadId disagree.",
    });
  }
  yield* service.cancelTask(scope, {
    taskId: task.id,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
  });
  // Native cancellation already disposed automatic delivery before this status read.
  return summarizeForkTask(task, yield* service.taskStatus(scope, task.id));
});
