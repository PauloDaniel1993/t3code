import { useAtomValue } from "@effect/atom-react";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  OrchestrationV2DispatchCommandError,
  type ModelSelection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ListPlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import { newMessageId, randomUUID } from "../lib/utils";
import { shortcutLabelForCommand } from "../keybindings";
import { onOpenNewThreadTaskDialog } from "../newThreadTaskBus";
import { useNewThreadTaskAvailability } from "../hooks/useNewThreadTaskAvailability";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../state/server";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { useAtomCommand } from "../state/use-atom-command";
import { NewThreadTaskDialog } from "./NewThreadTaskDialog";
import {
  buildDelegationTurnInput,
  getNewThreadTaskUnavailableReason,
  type NewThreadTaskDraft,
} from "./NewThreadTaskDialog.logic";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const isRejectedCommand = Schema.is(OrchestrationV2DispatchCommandError);

/** Owns the header action and dialog requests addressed to this one thread. */
export function NewThreadTaskAction({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { problem } = useNewThreadTaskAvailability(threadRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [initialModel, setInitialModel] = useState<ModelSelection | null>(null);
  const previousRequest = useRef<{ key: string; input: StartThreadTurnInput } | null>(null);
  const open = useCallback(() => {
    const projection =
      appAtomRegistry.get(environmentThreadDetails.threadAtom(threadRef))?.projection ?? null;
    if (problem === null && projection !== null) {
      previousRequest.current = null;
      setInitialModel(projection.thread.modelSelection);
    }
  }, [problem, threadRef]);
  useEffect(
    () =>
      onOpenNewThreadTaskDialog((requestedRef) => {
        if (
          requestedRef.environmentId === threadRef.environmentId &&
          requestedRef.threadId === threadRef.threadId
        )
          open();
      }),
    [open, threadRef],
  );
  async function request(draft: NewThreadTaskDraft, childModelSelection: ModelSelection) {
    const currentThread = appAtomRegistry.get(environmentThreadDetails.threadAtom(threadRef));
    const status = appAtomRegistry.get(environmentThreadDetails.statusAtom(threadRef));
    const environment = appAtomRegistry.get(
      environmentPresentations.presentationAtom(threadRef.environmentId),
    );
    const config = appAtomRegistry.get(serverEnvironment.configValueAtom(threadRef.environmentId));
    const currentProblem = getNewThreadTaskUnavailableReason({
      projection: currentThread?.projection ?? null,
      status,
      connected: environment?.connection.phase === "connected",
      providers: config?.providers ?? [],
    });
    if (currentProblem !== null || !currentThread)
      return currentProblem ?? "The thread is unavailable.";
    const key = JSON.stringify({ draft, childModelSelection });
    if (previousRequest.current?.key !== key) {
      previousRequest.current = {
        key,
        input: buildDelegationTurnInput({
          thread: currentThread.projection.thread,
          draft,
          childModelSelection,
          commandId: CommandId.make(randomUUID()),
          messageId: newMessageId(),
          createdAt: new Date().toISOString(),
        }),
      };
    }
    const result = await startTurn({
      environmentId: threadRef.environmentId,
      input: previousRequest.current.input,
    });
    if (result._tag === "Success") return null;
    if (isAtomCommandInterrupted(result))
      return "The request was interrupted. Retry to check the same request.";
    const error = squashAtomCommandFailure(result);
    // Rejected commands have durable receipts; retry after fixing the cause needs a new command.
    if (isRejectedCommand(error)) previousRequest.current = null;
    return error instanceof Error ? error.message : "Could not request a task.";
  }

  const shortcut = shortcutLabelForCommand(keybindings, "thread.newTask");
  return (
    <div className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={problem !== null}
              onClick={open}
            />
          }
        >
          <ListPlusIcon data-icon="inline-start" />
          New task
        </TooltipTrigger>
        <TooltipPopup>{problem ?? (shortcut ? `New task (${shortcut})` : "New task")}</TooltipPopup>
      </Tooltip>
      {initialModel ? (
        <NewThreadTaskDialog
          parentThreadRef={threadRef}
          initialModelSelection={initialModel}
          onClose={() => setInitialModel(null)}
          onRequest={request}
        />
      ) : null}
    </div>
  );
}
