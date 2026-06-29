import type { ModelSelection } from "@t3tools/contracts";
import { ArrowRightIcon, CheckIcon } from "lucide-react";
import { memo } from "react";

import type { HandoffTargetOption } from "../../threadHandoff/handoff";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export const ThreadHandoffDialog = memo(function ThreadHandoffDialog(props: {
  readonly open: boolean;
  readonly sourceProviderName: string;
  readonly importableMessageCount: number;
  readonly targetOptions: ReadonlyArray<HandoffTargetOption>;
  readonly selectedModelSelection: ModelSelection | null;
  readonly isSubmitting: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onTargetChange: (selection: ModelSelection) => void;
  readonly onSubmit: () => void;
}) {
  const selectedOption =
    props.selectedModelSelection === null
      ? null
      : (props.targetOptions.find(
          (option) => option.entry.instanceId === props.selectedModelSelection?.instanceId,
        ) ?? null);
  const selectedModels =
    selectedOption === null
      ? []
      : selectedOption.entry.models.length > 0
        ? selectedOption.entry.models
        : [
            {
              slug: selectedOption.modelSelection.model,
              name: selectedOption.modelSelection.model,
            },
          ];
  const canSubmit =
    props.selectedModelSelection !== null &&
    selectedOption !== null &&
    selectedOption.disabledReason === null &&
    !props.isSubmitting;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Hand off thread</DialogTitle>
          <DialogDescription>
            {props.sourceProviderName} <ArrowRightIcon className="mx-1 inline size-3" /> target
            provider
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <div className="grid gap-1 text-sm">
            <span className="font-medium text-foreground">Imported messages</span>
            <span className="text-muted-foreground">
              {props.importableMessageCount.toLocaleString()} completed messages
            </span>
          </div>
          <div className="grid gap-2">
            <span className="font-medium text-foreground text-sm">Target provider</span>
            <div className="grid max-h-72 gap-1 overflow-y-auto pr-1">
              {props.targetOptions.length === 0 ? (
                <div className="rounded-md border border-border/70 px-3 py-2 text-muted-foreground text-sm">
                  No provider targets available.
                </div>
              ) : (
                props.targetOptions.map((option) => {
                  const selected =
                    props.selectedModelSelection?.instanceId === option.entry.instanceId;
                  const disabled = option.disabledReason !== null;
                  return (
                    <button
                      key={option.entry.instanceId}
                      type="button"
                      disabled={disabled}
                      onClick={() => props.onTargetChange(option.modelSelection)}
                      className={cn(
                        "grid min-h-12 grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                        selected
                          ? "border-primary/70 bg-primary/10"
                          : "border-border/70 hover:border-border hover:bg-accent/60",
                        disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
                      )}
                    >
                      <ProviderInstanceIcon
                        driverKind={option.entry.driverKind}
                        displayName={option.entry.displayName}
                        accentColor={option.entry.accentColor}
                        showBadge={false}
                        className="size-5"
                        iconClassName="size-4"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{option.entry.displayName}</span>
                        <span className="block truncate text-muted-foreground text-xs">
                          {option.disabledReason ?? option.modelSelection.model}
                        </span>
                      </span>
                      {selected ? <CheckIcon className="size-4 text-primary" /> : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
          {selectedOption !== null ? (
            <div className="grid gap-2">
              <span className="font-medium text-foreground text-sm">Target model</span>
              <Select
                value={props.selectedModelSelection?.model ?? selectedOption.modelSelection.model}
                onValueChange={(model) => {
                  if (!model) return;
                  props.onTargetChange({
                    ...selectedOption.modelSelection,
                    model,
                  });
                }}
              >
                <SelectTrigger
                  className="w-full justify-between"
                  disabled={selectedOption.disabledReason !== null}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {selectedModels.map((model) => (
                    <SelectItem key={model.slug} value={model.slug}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={props.isSubmitting}
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={props.onSubmit}>
            Hand off
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
