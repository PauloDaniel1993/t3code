import { useAtomValue } from "@effect/atom-react";
import { createModelSelection } from "@t3tools/shared/model";
import type {
  MessageId,
  ModelSelection,
  ProviderInstanceId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useId, useMemo, useState } from "react";

import { cn } from "../lib/utils";
import { usePrimarySettings } from "../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { type AppModelOption, getAppModelOptionsForInstance } from "../modelSelection";
import { primaryServerProvidersAtom } from "../state/server";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { TraitsPicker } from "./chat/TraitsPicker";
import { useThread } from "../state/entities";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import {
  deriveSelectableMessages,
  deriveTaskTitle,
  EMPTY_NEW_THREAD_TASK_DRAFT,
  formatSelectionSummary,
  NEW_THREAD_TASK_CONTEXT_OPTIONS,
  resolveTaskContextSpec,
  toggleMessageSelection,
  validateNewThreadTaskDraft,
  type NewThreadTaskDraft,
} from "./NewThreadTaskDialog.logic";

/**
 * Manual task creation. The agent can spawn tasks on its own; this is the
 * user's equivalent, and the only place the context a task starts from is
 * chosen explicitly.
 *
 * The draft is kept here rather than reset on failure: a rejected create
 * (caps, an archived parent) is something to fix and retry, not to retype.
 */
export function NewThreadTaskDialog(props: {
  parentThreadRef: ScopedThreadRef;
  onClose: () => void;
  onCreate: (input: {
    readonly parentThreadId: ThreadId;
    readonly taskThreadId: ThreadId;
    readonly title: string;
    readonly prompt: string;
    readonly context: ReturnType<typeof resolveTaskContextSpec>;
    readonly modelSelection?: ModelSelection;
  }) => Promise<string | null>;
}) {
  const { onClose, onCreate, parentThreadRef } = props;
  const thread = useThread(parentThreadRef);
  const [draft, setDraft] = useState<NewThreadTaskDraft>(EMPTY_NEW_THREAD_TASK_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [selectionRejected, setSelectionRejected] = useState(false);
  const formId = useId();

  const selectableMessages = useMemo(
    () => deriveSelectableMessages(thread?.messages ?? []),
    [thread?.messages],
  );

  // The model override defaults to the parent's, so leaving it alone means
  // "same as this thread" and the command carries no override at all.
  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const providerInstanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(
    () =>
      new Map(
        providerInstanceEntries.map((entry) => [
          entry.instanceId,
          getAppModelOptionsForInstance(settings, entry),
        ]),
      ),
    [providerInstanceEntries, settings],
  );
  const [modelOverride, setModelOverride] = useState<ModelSelection | null>(null);
  const effectiveModel = modelOverride ?? thread?.modelSelection ?? null;
  // Reasoning level and the rest of the model's traits come from the instance
  // the task will actually run on, which is the override once one is picked.
  const effectiveInstanceEntry = useMemo(
    () =>
      providerInstanceEntries.find((entry) => entry.instanceId === effectiveModel?.instanceId) ??
      null,
    [effectiveModel?.instanceId, providerInstanceEntries],
  );
  const problem = validateNewThreadTaskDraft(draft);
  const selectedIds = draft.selectedMessageIds;

  const onToggleMessage = useCallback((messageId: MessageId) => {
    setDraft((current) => {
      const next = toggleMessageSelection({
        selected: current.selectedMessageIds,
        messageId,
      });
      setSelectionRejected(next.rejected);
      return next.rejected ? current : { ...current, selectedMessageIds: next.selected };
    });
  }, []);

  const submit = useCallback(() => {
    if (problem !== null || submitting) return;
    void (async () => {
      setSubmitting(true);
      setFailure(null);
      const error = await onCreate({
        parentThreadId: parentThreadRef.threadId,
        taskThreadId: crypto.randomUUID() as ThreadId,
        title: deriveTaskTitle(draft),
        prompt: draft.prompt.trim(),
        context: resolveTaskContextSpec(draft),
        ...(modelOverride !== null ? { modelSelection: modelOverride } : {}),
      });
      setSubmitting(false);
      if (error === null) {
        onClose();
        return;
      }
      setFailure(error);
    })();
  }, [draft, modelOverride, onClose, onCreate, parentThreadRef.threadId, problem, submitting]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-xl" data-testid="new-thread-task-dialog">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            A task runs as its own thread. When it finishes, its results come back here and this
            thread picks up where it left off.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          <form
            id={formId}
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="space-y-1.5">
              <label htmlFor={`${formId}-title`} className="text-sm font-medium text-foreground">
                Title <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Input
                id={`${formId}-title`}
                data-testid="new-thread-task-title"
                value={draft.title}
                placeholder={deriveTaskTitle(draft) || "Taken from the first line of the prompt"}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.target.value }))
                }
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor={`${formId}-prompt`} className="text-sm font-medium text-foreground">
                What should this task do?
              </label>
              <textarea
                id={`${formId}-prompt`}
                data-testid="new-thread-task-prompt"
                value={draft.prompt}
                rows={4}
                autoFocus
                placeholder="Inventory every provider handler and report the ones without tests."
                onChange={(event) =>
                  setDraft((current) => ({ ...current, prompt: event.target.value }))
                }
                className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring/70"
              />
            </div>

            {effectiveModel === null ? null : (
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">Model</span>
                <ProviderModelPicker
                  activeInstanceId={effectiveModel.instanceId}
                  model={effectiveModel.model}
                  lockedProvider={null}
                  instanceEntries={providerInstanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerVariant="outline"
                  onInstanceModelChange={(instanceId, model) =>
                    // A different model has different traits, so the previous
                    // model's options are dropped rather than carried onto it.
                    setModelOverride(createModelSelection(instanceId, model))
                  }
                />
                {effectiveInstanceEntry === null ? null : (
                  <span data-testid="new-thread-task-traits">
                    <TraitsPicker
                      provider={effectiveInstanceEntry.driverKind}
                      instanceId={effectiveInstanceEntry.instanceId}
                      models={effectiveInstanceEntry.models}
                      model={effectiveModel.model}
                      modelOptions={effectiveModel.options}
                      prompt={draft.prompt}
                      onPromptChange={(prompt) => setDraft((current) => ({ ...current, prompt }))}
                      onModelOptionsChange={(nextOptions) =>
                        setModelOverride(
                          createModelSelection(
                            effectiveModel.instanceId,
                            effectiveModel.model,
                            nextOptions ?? [],
                          ),
                        )
                      }
                      triggerVariant="outline"
                    />
                  </span>
                )}
                {modelOverride === null ? (
                  <span className="text-[12px] text-muted-foreground">Same as this thread</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setModelOverride(null)}
                    className="cursor-pointer text-[12px] text-muted-foreground underline-offset-2 hover:underline"
                  >
                    Reset
                  </button>
                )}
              </div>
            )}

            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium text-foreground">Context</legend>
              <div className="grid gap-1.5">
                {NEW_THREAD_TASK_CONTEXT_OPTIONS.map((option) => (
                  <label
                    key={option.kind}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition-colors",
                      draft.contextKind === option.kind
                        ? "border-primary/60 bg-primary/[0.06]"
                        : "border-border/60 hover:bg-accent/30",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${formId}-context`}
                      value={option.kind}
                      checked={draft.contextKind === option.kind}
                      onChange={() => {
                        setSelectionRejected(false);
                        setDraft((current) => ({ ...current, contextKind: option.kind }));
                      }}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm text-foreground">{option.label}</span>
                      <span className="block text-[12px] text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {draft.contextKind === "selected-messages" ? (
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">Messages</span>
                  <span
                    data-testid="new-thread-task-selection-count"
                    className={cn(
                      "text-[12px]",
                      selectionRejected
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground",
                    )}
                  >
                    {formatSelectionSummary(selectedIds.length)}
                  </span>
                </div>
                {selectionRejected ? (
                  <p className="text-[12px] text-amber-600 dark:text-amber-400">
                    That is as many messages as one task can carry. Deselect one to pick another.
                  </p>
                ) : null}
                <div
                  data-testid="new-thread-task-message-list"
                  className="max-h-56 space-y-px overflow-y-auto rounded-md border border-border/60 p-1"
                >
                  {selectableMessages.length === 0 ? (
                    <p className="px-2 py-3 text-[12px] text-muted-foreground">
                      This thread has no messages to carry over yet.
                    </p>
                  ) : (
                    selectableMessages.map((message) => (
                      <label
                        key={message.id}
                        className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/30"
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(message.id)}
                          onChange={() => onToggleMessage(message.id)}
                          className="mt-1"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px] uppercase tracking-wide text-muted-foreground/70">
                            {message.role}
                          </span>
                          <span className="block truncate text-[12px] text-foreground/85">
                            {message.preview}
                          </span>
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            ) : null}

            {failure !== null ? (
              <p data-testid="new-thread-task-error" className="text-sm text-destructive">
                {failure}
              </p>
            ) : problem !== null ? (
              <p className="text-sm text-muted-foreground">{problem}</p>
            ) : null}
          </form>
        </DialogPanel>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            data-testid="new-thread-task-submit"
            disabled={problem !== null || submitting}
          >
            {submitting ? "Creating…" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
