import {
  type EnvironmentId,
  isProviderDriverKind,
  ProjectId,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { type ChatAttachment, type ChatMessage, type SessionPhase, type Thread } from "../types";
import { type ComposerAttachment, type DraftThreadState } from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;
export const MAX_HIDDEN_MOUNTED_PREVIEW_THREADS = 3;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    createdAt: draftThread.createdAt,
    updatedAt: draftThread.createdAt,
    archivedAt: null,
    deletedAt: null,
    latestTurn: null,
    handoff: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    checkpoints: [],
    activities: [],
    proposedPlans: [],
  };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  serverThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.serverThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.serverThread.environmentId === input.routeThreadRef.environmentId &&
    input.serverThread.id === input.targetThreadId,
  );
}

export function buildThreadTurnInterruptInput(thread: Pick<Thread, "id" | "session">): {
  threadId: ThreadId;
  turnId?: TurnId;
} {
  const runningTurnId = thread.session?.status === "running" ? thread.session.activeTurnId : null;
  return {
    threadId: thread.id,
    ...(runningTurnId !== null ? { turnId: runningTurnId } : {}),
  };
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  return reconcileRetainedMountedThreadIds({
    currentThreadIds: input.currentThreadIds,
    openThreadIds: input.openThreadIds,
    activeThreadId: input.activeThreadId,
    activeThreadOpen: input.activeThreadTerminalOpen,
    maxHiddenThreadCount: input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  });
}

export function reconcileRetainedMountedThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadOpen: boolean;
  maxHiddenThreadCount: number;
  retainInactiveActiveThread?: boolean;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) =>
      (threadId !== input.activeThreadId || input.retainInactiveActiveThread === true) &&
      openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(0, input.maxHiddenThreadCount);
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  revokeUserMessagePreviewUrlsExcept(message, new Set());
}

export function revokeUserMessagePreviewUrlsExcept(
  message: ChatMessage,
  retainedUrls: ReadonlySet<string>,
): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    const url = attachment.type === "image" ? attachment.previewUrl : attachment.assetUrl;
    if (!url || retainedUrls.has(url)) {
      continue;
    }
    revokeBlobPreviewUrl(url);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export function revokeUserMessageDocumentAssetUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type === "document") {
      revokeBlobPreviewUrl(attachment.assetUrl);
    }
  }
}

export function applyResolvedAttachmentAssetUrls(
  messages: ReadonlyArray<ChatMessage>,
  assetUrlById: ReadonlyMap<string, string>,
): ReadonlyArray<ChatMessage> {
  return messages.map((message) => {
    if (!message.attachments || message.attachments.length === 0) {
      return message;
    }
    let changed = false;
    const attachments = message.attachments.map((attachment) => {
      const assetUrl = assetUrlById.get(attachment.id);
      if (!assetUrl) return attachment;
      changed = true;
      return attachment.type === "image"
        ? { ...attachment, previewUrl: assetUrl }
        : { ...attachment, assetUrl };
    });
    return changed ? { ...message, attachments } : message;
  });
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read attachment data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read attachment."));
    });
    reader.readAsDataURL(file);
  });
}

export async function serializeComposerAttachments(
  attachments: ReadonlyArray<ComposerAttachment>,
  readFile: (file: File) => Promise<string> = readFileAsDataUrl,
): Promise<UploadChatAttachment[]> {
  return await Promise.all(
    attachments.map(async (attachment): Promise<UploadChatAttachment> => {
      const dataUrl = await readFile(attachment.file);
      return attachment.type === "image"
        ? {
            type: "image",
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            dataUrl,
          }
        : {
            type: "document",
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            dataUrl,
          };
    }),
  );
}

export function buildOptimisticComposerAttachments(
  attachments: ReadonlyArray<ComposerAttachment>,
): ChatAttachment[] {
  return attachments.map((attachment) =>
    attachment.type === "image"
      ? {
          type: "image",
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          previewUrl: attachment.previewUrl,
        }
      : {
          type: "document",
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          assetUrl: attachment.assetUrl,
        },
  );
}

/** Keep a newer in-flight draft intact while restoring text from a failed send. */
export function mergeFailedComposerPrompt(currentPrompt: string, failedPrompt: string): string {
  if (failedPrompt.length === 0 || currentPrompt === failedPrompt) {
    return currentPrompt;
  }
  if (currentPrompt.length === 0) {
    return failedPrompt;
  }
  return `${failedPrompt}\n\n${currentPrompt}`;
}

/** Merge failed-send context snapshots after newer draft items without duplicating ids. */
export function mergeComposerDraftItemsById<T extends { readonly id: string }>(
  currentItems: ReadonlyArray<T>,
  failedItems: ReadonlyArray<T>,
): T[] {
  const ids = new Set(currentItems.map((item) => item.id));
  const merged = [...currentItems];
  for (const item of failedItems) {
    if (ids.has(item.id)) continue;
    ids.add(item.id);
    merged.push(item);
  }
  return merged;
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function cloneComposerAttachmentForRetry(
  attachment: ComposerAttachment,
): ComposerAttachment {
  const objectUrl = attachment.type === "image" ? attachment.previewUrl : attachment.assetUrl;
  if (typeof URL === "undefined" || !objectUrl.startsWith("blob:")) {
    return attachment;
  }
  try {
    const nextObjectUrl = URL.createObjectURL(attachment.file);
    return attachment.type === "image"
      ? { ...attachment, previewUrl: nextObjectUrl }
      : { ...attachment, assetUrl: nextObjectUrl };
  } catch {
    return attachment;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  attachmentCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  /**
   * Optional element-pick attachment count. Element contexts contribute to
   * "sendable content" exactly like attachments and (text-bearing) terminal
   * contexts do: a prompt of just element chips is still a valid send.
   */
  elementContextCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const elementContextCount = options.elementContextCount ?? 0;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.attachmentCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      elementContextCount > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

// `threadProvider` is the open branded driver kind carried by the session.
// Unknown driver kinds degrade to `null` (i.e. "unlocked"), which is the safe
// rollback / fork behavior — the routing layer is the right place to surface
// "driver not installed" errors, not the lock state.
//
// `selectedProvider` takes the same open-string shape because the composer
// now tracks the picker selection as a `ProviderInstanceId` (e.g.
// `codex_personal`). Custom instance ids that don't directly match a
// registered driver resolve to `null` here, which matches the existing
// "unknown driver -> unlocked" semantics. Callers that want the lock to track
// a custom instance's underlying driver kind should resolve the instance id
// upstream and pass the correlated kind.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  const sessionProvider = input.thread?.session?.providerName ?? null;
  if (sessionProvider && isProviderDriverKind(sessionProvider)) {
    return sessionProvider;
  }
  const narrowedThreadProvider =
    input.threadProvider && isProviderDriverKind(input.threadProvider)
      ? input.threadProvider
      : null;
  const narrowedSelectedProvider =
    input.selectedProvider && isProviderDriverKind(input.selectedProvider)
      ? input.selectedProvider
      : null;
  return narrowedThreadProvider ?? narrowedSelectedProvider ?? null;
}

export function getStartedThreadModelChangeBlockReason(input: {
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "requiresNewThreadForModelChange">>;
  hasStartedSession: boolean;
  currentModelSelection: ModelSelection;
  currentProviderInstanceId?: ModelSelection["instanceId"] | null | undefined;
  nextModelSelection: ModelSelection;
}): { title: string; description: string } | null {
  if (!input.hasStartedSession) {
    return null;
  }
  const currentModelSelection = {
    ...input.currentModelSelection,
    instanceId: input.currentProviderInstanceId ?? input.currentModelSelection.instanceId,
  };
  if (
    currentModelSelection.instanceId === input.nextModelSelection.instanceId &&
    currentModelSelection.model === input.nextModelSelection.model
  ) {
    return null;
  }
  const currentProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === currentModelSelection.instanceId,
  );
  const nextProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === input.nextModelSelection.instanceId,
  );
  if (
    currentProvider?.requiresNewThreadForModelChange !== true &&
    nextProvider?.requiresNewThreadForModelChange !== true
  ) {
    return null;
  }
  return {
    title: "Start a new chat to change models",
    description: "This provider does not allow switching models after a conversation has started.",
  };
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const threadAtom = environmentThreadDetails.detailAtom(threadRef);
  const getThread = () => appAtomRegistry.get(threadAtom);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = appAtomRegistry.subscribe(threadAtom, (thread) => {
      if (!threadHasStarted(thread)) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

/**
 * How long a steer dispatch may stay "busy" before we force-clear it, even if
 * no acknowledgement signal is observed. This is a safety net so the composer
 * can never wedge: the message-landed/session-advanced signals normally win
 * this race well before the timeout elapses.
 */
export const STEER_DISPATCH_FALLBACK_MS = 2_000;

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  /**
   * True when this dispatch is a steer: it was submitted while a turn was
   * already running and continues that same turn. A steer never changes the
   * turn's identity/timestamps, so it cannot be acknowledged via
   * `latestTurnChanged` like a turn-starting dispatch can.
   */
  wasSteer: boolean;
  /** Server-recorded user message count captured at dispatch time. */
  userMessageCount: number;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionStatus: NonNullable<Thread["session"]>["status"] | null;
  sessionUpdatedAt: string | null;
}

function countUserMessages(thread: Thread | undefined): number {
  if (!thread) return 0;
  let count = 0;
  for (const message of thread.messages) {
    if (message.role === "user") count += 1;
  }
  return count;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean; phase?: SessionPhase },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  // A steer continues an already-running turn: the session's active turn is
  // the latest turn. Prefer the explicit phase when provided, otherwise fall
  // back to the session status.
  const running = options?.phase ? options.phase === "running" : session?.status === "running";
  const wasSteer =
    running &&
    latestTurn?.turnId != null &&
    session?.activeTurnId != null &&
    session.activeTurnId === latestTurn.turnId;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    wasSteer,
    userMessageCount: countUserMessages(activeThread),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionStatus: session?.status ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  userMessageCount: number;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;

  // A steer continues the same running turn, so the turn's identity and
  // timestamps never change — `latestTurnChanged` would stay false for the rest
  // of the turn and wedge the composer. Acknowledge a steer as soon as the
  // server records the steered message (user count advances) or the session
  // advances. A bounded fallback timer (see STEER_DISPATCH_FALLBACK_MS) clears
  // the dispatch in the rare case neither signal is observed.
  if (input.localDispatch.wasSteer) {
    const messageLanded = input.userMessageCount > input.localDispatch.userMessageCount;
    const sessionAdvanced = input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null);
    return messageLanded || sessionAdvanced;
  }

  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== null &&
      session?.activeTurnId !== undefined &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionStatus !== (session?.status ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}
