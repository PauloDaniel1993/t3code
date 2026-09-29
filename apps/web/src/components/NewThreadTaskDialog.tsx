import { Field } from "@base-ui/react/field";
import type { ModelSelection, ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useId, useMemo, useRef, useState } from "react";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { type AppModelOption, getAppModelOptionsForInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { useNewThreadTaskAvailability } from "../hooks/useNewThreadTaskAvailability";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { TraitsPicker } from "./chat/TraitsPicker";
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
import { Textarea } from "./ui/textarea";
import {
  deriveTaskTitle,
  TASK_PROMPT_MAX_LENGTH,
  TASK_TITLE_MAX_LENGTH,
  validateNewThreadTaskDraft,
  type NewThreadTaskDraft,
} from "./NewThreadTaskDialog.logic";

export function NewThreadTaskDialog(props: {
  readonly parentThreadRef: ScopedThreadRef;
  readonly initialModelSelection: ModelSelection;
  readonly onClose: () => void;
  readonly onRequest: (draft: NewThreadTaskDraft, model: ModelSelection) => Promise<string | null>;
}) {
  const { parentThreadRef, initialModelSelection, onClose, onRequest } = props;
  const { providers, problem: parentProblem } = useNewThreadTaskAvailability(parentThreadRef);
  const settings = useEnvironmentSettings(parentThreadRef.environmentId);
  const [draft, setDraft] = useState<NewThreadTaskDraft>({ title: "", prompt: "" });
  const [model, setModel] = useState(initialModelSelection);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const formId = useId();
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(
    () =>
      new Map(
        entries.map((entry) => [
          entry.instanceId,
          getAppModelOptionsForInstance(
            settings,
            entry,
            entry.instanceId === model.instanceId ? model.model : null,
          ),
        ]),
      ),
    [entries, settings, model.instanceId, model.model],
  );
  const selectedEntry = entries.find((entry) => entry.instanceId === model.instanceId);
  const selectedModel = modelOptionsByInstance
    .get(model.instanceId)
    ?.find((option) => option.slug === model.model);
  const draftProblem = validateNewThreadTaskDraft(draft);
  const problem =
    parentProblem ??
    draftProblem ??
    (!selectedEntry ||
    !isProviderInstancePickerReady(selectedEntry) ||
    !selectedModel ||
    selectedModel.isUnavailable
      ? "Choose an available provider instance and model."
      : null);

  async function submit() {
    if (problem !== null || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const error = await onRequest(draft, model);
      if (error === null) onClose();
      else setFailure(error);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not request a task.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submittingRef.current) onClose();
      }}
    >
      <DialogPopup data-testid="new-thread-task-dialog" showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Ask this thread's agent to delegate a task. This uses a parent turn and queues behind
            any active work.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset disabled={submitting} className="flex min-w-0 flex-col gap-4">
              <legend className="sr-only">Task details</legend>
              <Field.Root className="flex flex-col gap-1.5">
                <Field.Label className="text-sm font-medium">Title (optional)</Field.Label>
                <Input
                  value={draft.title}
                  maxLength={TASK_TITLE_MAX_LENGTH}
                  placeholder={deriveTaskTitle(draft) || "Taken from the task prompt"}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, title: event.target.value }))
                  }
                />
              </Field.Root>
              <Field.Root
                className="flex flex-col gap-1.5"
                invalid={draftProblem !== null && draft.prompt.length > 0}
              >
                <Field.Label className="text-sm font-medium">What should this task do?</Field.Label>
                <Textarea
                  autoFocus
                  value={draft.prompt}
                  maxLength={TASK_PROMPT_MAX_LENGTH}
                  aria-invalid={draftProblem !== null && draft.prompt.length > 0}
                  placeholder="Inventory every provider handler and report the ones without tests."
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, prompt: event.target.value }))
                  }
                />
                <Field.Description className="text-xs text-muted-foreground">
                  Prompt only. Parent history is not copied; include any context the task needs
                  here.
                </Field.Description>
              </Field.Root>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Model</span>
                <ProviderModelPicker
                  activeInstanceId={model.instanceId}
                  model={model.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  disabled={submitting}
                  isComposerOwned={false}
                  onInstanceModelChange={(instanceId, nextModel) =>
                    setModel(createModelSelection(instanceId, nextModel))
                  }
                />
                {selectedEntry ? (
                  <TraitsPicker
                    provider={selectedEntry.driverKind}
                    instanceId={selectedEntry.instanceId}
                    models={selectedEntry.models}
                    model={model.model}
                    modelOptions={model.options}
                    planModeEnabled={settings.planModeEnabled}
                    isComposerOwned={false}
                    prompt={draft.prompt}
                    onPromptChange={(prompt) => setDraft((current) => ({ ...current, prompt }))}
                    onModelOptionsChange={(options) =>
                      setModel(createModelSelection(model.instanceId, model.model, options ?? []))
                    }
                  />
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setModel(initialModelSelection)}
                >
                  Reset
                </Button>
              </div>
            </fieldset>
            {(failure ?? problem) ? (
              <p
                role={failure ? "alert" : "status"}
                className={failure ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
              >
                {failure ?? problem}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={problem !== null || submitting}>
            {submitting ? "Requesting…" : "Request task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
