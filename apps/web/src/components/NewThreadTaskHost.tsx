/**
 * Mount once alongside the app's command palette. Call openNewThreadTaskDialog
 * from ../newThreadTaskBus with { threadRef, initialDraft?: { title, prompt } }.
 * The requested parent stream is mounted only while its dialog is open; it need
 * not be the route thread. Header, palette, shortcut, sidebar and map share this host.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, type ModelSelection, type ScopedThreadRef } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { matchesShortcut, resolveShortcutCommand } from "../keybindings";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { newMessageId, randomUUID } from "../lib/utils";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { useComposerHandleContext } from "../composerHandleContext";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useTerminalUiStateStore, selectThreadTerminalUiState } from "../terminalUiStateStore";
import { useRightPanelStore, selectActiveRightPanel } from "../rightPanelStore";
import {
  onOpenNewThreadTaskDialog,
  openNewThreadTaskDialog,
  type OpenNewThreadTaskRequest,
} from "../newThreadTaskBus";
import {
  useNewThreadTaskAvailability,
  useNewThreadTaskParent,
} from "../hooks/useNewThreadTaskAvailability";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../state/server";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { useAtomCommand } from "../state/use-atom-command";
import { NewThreadTaskDialog } from "./NewThreadTaskDialog";
import {
  getNewThreadTaskUnavailableReason,
  type NewThreadTaskDraft,
} from "./NewThreadTaskDialog.logic";
import {
  prepareNewThreadTaskRequest,
  retainNewThreadTaskRequestForRetry,
  type NewThreadTaskRequest,
} from "./NewThreadTaskHost.logic";
import { toastManager } from "./ui/toast";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";

function currentParentProblem(threadRef: ScopedThreadRef) {
  const environment = appAtomRegistry.get(
    environmentPresentations.presentationAtom(threadRef.environmentId),
  );
  return getNewThreadTaskUnavailableReason({
    projection:
      appAtomRegistry.get(environmentThreadDetails.threadAtom(threadRef))?.projection ?? null,
    status: appAtomRegistry.get(environmentThreadDetails.statusAtom(threadRef)),
    connected: environment?.connection.phase === "connected",
    providers:
      appAtomRegistry.get(serverEnvironment.configValueAtom(threadRef.environmentId))?.providers ??
      [],
  });
}

export function NewThreadTaskHost() {
  const [request, setRequest] = useState<OpenNewThreadTaskRequest | null>(null);
  const openRef = useRef(false);
  const routeTarget = useParams({ strict: false, select: resolveThreadRouteTarget });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const composerHandle = useComposerHandleContext();
  useEffect(
    () =>
      onOpenNewThreadTaskDialog((next) => {
        if (openRef.current) {
          toastManager.add({
            title: "A task draft is already open",
            description: "Finish or close it before opening another task.",
            type: "info",
          });
          return;
        }
        openRef.current = true;
        setRequest({
          ...next,
          threadRef: { ...next.threadRef },
          ...(next.initialDraft ? { initialDraft: { ...next.initialDraft } } : {}),
        });
      }),
    [],
  );

  useEffect(() => {
    const taskShortcuts = keybindings
      .filter((binding) => binding.command === "thread.newTask")
      .map((binding) => binding.shortcut);
    const platform = navigator.platform;
    const handler = (event: KeyboardEvent) => {
      if (!taskShortcuts.some((shortcut) => matchesShortcut(event, shortcut, platform))) return;
      if (event.defaultPrevented || event.repeat || event.isComposing || isCommandPaletteOpen())
        return;
      const threadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
      const projection = threadRef
        ? appAtomRegistry.get(environmentThreadDetails.threadAtom(threadRef))?.projection
        : null;
      const terminalState = threadRef
        ? selectThreadTerminalUiState(
            useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
            threadRef,
          )
        : null;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          terminalOpen: Boolean(terminalState?.terminalOpen),
          previewFocus: isPreviewFocused(),
          previewOpen: threadRef
            ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) ===
              "preview"
            : false,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: composerHandle?.current?.isModelPickerOpen() ?? false,
          composerFocus: document.activeElement?.getAttribute("data-testid") === "composer-editor",
          draftThreadRoute: routeTarget?.kind === "draft",
          turnRunning: projection?.runs.some((run) => run.status === "running") ?? false,
          isWeb: !isElectron,
          isDesktop: isElectron,
        },
      });
      if (command !== "thread.newTask" || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      const problem = threadRef
        ? currentParentProblem(threadRef)
        : "Open an existing thread to request a task.";
      if (problem !== null)
        toastManager.add({ title: "New task unavailable", description: problem, type: "info" });
      else if (threadRef) openNewThreadTaskDialog({ threadRef });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [routeTarget, keybindings, composerHandle]);

  return request ? (
    <NewThreadTaskSession
      request={request}
      onClose={() => {
        openRef.current = false;
        setRequest(null);
      }}
    />
  ) : null;
}

function NewThreadTaskSession({
  request,
  onClose,
}: {
  readonly request: OpenNewThreadTaskRequest;
  readonly onClose: () => void;
}) {
  const { threadRef } = request;
  const parent = useNewThreadTaskParent(threadRef);
  const status = useAtomValue(environmentThreadDetails.statusAtom(threadRef));
  const { problem } = useNewThreadTaskAvailability(threadRef);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const previous = useRef<NewThreadTaskRequest | null>(null);
  const [initialModel, setInitialModel] = useState<ModelSelection | null>(null);
  // Freeze the initial picker value as soon as this unopened parent's stream arrives.
  if (initialModel === null && parent !== null) setInitialModel(parent.modelSelection);

  async function submit(draft: NewThreadTaskDraft, childModelSelection: ModelSelection) {
    const problem = currentParentProblem(threadRef);
    const thread = appAtomRegistry.get(environmentThreadDetails.threadAtom(threadRef))?.projection
      .thread;
    if (problem !== null || !thread) return problem ?? "The thread is unavailable.";
    previous.current = prepareNewThreadTaskRequest(
      previous.current,
      { thread, draft, childModelSelection },
      () => ({
        commandId: CommandId.make(randomUUID()),
        messageId: newMessageId(),
        createdAt: new Date().toISOString(),
      }),
    );
    const result = await startTurn({
      environmentId: threadRef.environmentId,
      input: previous.current.input,
    });
    if (result._tag === "Success") return null;
    if (isAtomCommandInterrupted(result))
      return "The request was interrupted. Retry to check the same request.";
    const error = squashAtomCommandFailure(result);
    previous.current = retainNewThreadTaskRequestForRetry(previous.current, error);
    return error instanceof Error ? error.message : "Could not request a task.";
  }

  const parentUnavailable = status === "deleted" || (parent?.deletedAt ?? null) !== null;
  return initialModel && !parentUnavailable ? (
    <NewThreadTaskDialog
      parentThreadRef={threadRef}
      initialModelSelection={initialModel}
      {...(request.initialDraft ? { initialDraft: request.initialDraft } : {})}
      onClose={onClose}
      onRequest={submit}
    />
  ) : (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup showCloseButton={!parentUnavailable}>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>{problem ?? "Loading the parent thread…"}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
