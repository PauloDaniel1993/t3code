import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ListPlusIcon } from "lucide-react";
import { useId } from "react";
import { shortcutLabelForCommand } from "../keybindings";
import { openNewThreadTaskDialog } from "../newThreadTaskBus";
import { useNewThreadTaskAvailability } from "../hooks/useNewThreadTaskAvailability";
import { primaryServerKeybindingsAtom } from "../state/server";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Header entry point; the app-level host owns the dialog and its parent identity. */
export function NewThreadTaskAction({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { problem } = useNewThreadTaskAvailability(threadRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const descriptionId = useId();
  const shortcut = shortcutLabelForCommand(keybindings, "thread.newTask");
  const button = (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={problem !== null}
      aria-describedby={problem ? descriptionId : undefined}
      onClick={() => openNewThreadTaskDialog({ threadRef })}
    >
      <ListPlusIcon data-icon="inline-start" />
      New task
    </Button>
  );
  return (
    <div className="shrink-0">
      <Tooltip>
        {problem ? (
          <TooltipTrigger render={<span className="inline-flex" />} tabIndex={-1}>
            {button}
          </TooltipTrigger>
        ) : (
          <TooltipTrigger render={button} />
        )}
        <TooltipPopup>{problem ?? (shortcut ? `New task (${shortcut})` : "New task")}</TooltipPopup>
      </Tooltip>
      {problem ? (
        <span id={descriptionId} className="sr-only">
          {problem}
        </span>
      ) : null}
    </div>
  );
}
