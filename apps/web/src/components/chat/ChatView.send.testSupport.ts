import * as NodeModule from "node:module";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Runtime from "@t3tools/client-runtime/state/runtime";
import * as Model from "@t3tools/shared/model";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { truncate } from "@t3tools/shared/String";
import {
  MessageId,
  type ScopedThreadRef,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { vi } from "vite-plus/test";

import * as DraftStore from "../../composerDraftStore";
import * as ComposerLogic from "../../composer-logic";
import * as ContextReferences from "../../lib/composerContextReferences";
import * as ContextRecords from "../../lib/composerContextRecords";
import * as Uploads from "../../lib/attachmentUploadQueue";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { ChatMessage } from "../../types";
import * as ChatLogic from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import { stackedThreadToast } from "../ui/toastHelpers";
import * as Recovery from "./failedSendRecovery";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./composerPromptHistory";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import chatViewSource from "../ChatView.tsx?raw";

// Run the production handler itself, including its awaits and failure branches.
// Only the surrounding view's hook bindings are supplied by this headless harness;
// it avoids mounting unrelated timelines, terminals and browser panels.
const handlerStart = chatViewSource.indexOf("  const onSend = async (");
const handlerEnd = chatViewSource.indexOf("\n  const onRespondToApproval", handlerStart);
if (handlerStart < 0 || handlerEnd < 0) throw new Error("ChatView send handler was not found");
const handler = NodeModule.stripTypeScriptTypes(chatViewSource.slice(handlerStart, handlerEnd));

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function createSendHarness(
  threadRef: ScopedThreadRef,
  target: DraftStore.ComposerThreadTarget = threadRef,
) {
  const store = DraftStore.useComposerDraftStore.getState();
  const routeThreadKey = scopedThreadKey(threadRef);
  const refs = {
    promptRef: { current: store.getComposerDraft(target)?.prompt ?? "" },
    composerImagesRef: { current: store.getComposerDraft(target)?.images ?? [] },
    composerFilesRef: { current: store.getComposerDraft(target)?.files ?? [] },
    composerTerminalContextsRef: {
      current: store.getComposerDraft(target)?.terminalContexts ?? [],
    },
    currentRouteThreadKeyRef: { current: routeThreadKey },
    sendInFlightRef: { current: false },
    composerSendGenerationRef: { current: 0 },
  };
  let messages: ChatMessage[] = [];
  const failure = Runtime.settlePromise(() => {
    throw new Error("Send rejected");
  });
  const started = deferred<void>();
  const result = deferred<Awaited<typeof failure>>();
  const settingsStarted = deferred<void>();
  const settingsResult = deferred<Awaited<typeof failure>>();
  const startThreadTurn = vi.fn(() => {
    started.resolve();
    return result.promise;
  });
  const persistSettings = vi.fn<() => Promise<Runtime.AtomCommandResult<unknown, unknown>>>(
    async () => AsyncResult.success(undefined),
  );
  const resetCursorState = vi.fn<(...args: unknown[]) => void>();
  const setThreadError = vi.fn<(...args: unknown[]) => void>();
  const base = {
    ...DraftStore,
    ...ComposerLogic,
    ...ContextReferences,
    ...ContextRecords,
    ...ChatLogic,
    ...Runtime,
    ...Model,
    ...Recovery,
    ...Uploads,
    ...refs,
    appAtomRegistry,
    toastManager,
    stackedThreadToast,
    scopeThreadRef,
    scopedThreadKey,
    fileAttachmentCapabilityBlockReason,
    assistantCitationsToPlainText,
    truncate,
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    environmentId: threadRef.environmentId,
    routeThreadKey,
    composerDraftTarget: target,
    draftId: typeof target === "string" ? target : null,
    draftThread: typeof target === "string" ? store.getDraftSession(target) : null,
    activeThread: {
      id: threadRef.threadId,
      environmentId: threadRef.environmentId,
      worktreePath: null,
      createdAt: "2026-09-29T00:00:00Z",
    },
    activeProject: {
      id: "project",
      environmentId: threadRef.environmentId,
      workspaceRoot: "I:/fixture",
    },
    activeProjectDefaultModelSelection: null,
    activeThreadBranch: "main",
    activeThreadKey: routeThreadKey,
    isServerThread: typeof target !== "string",
    isLocalDraftThread: typeof target === "string",
    usageLimitsOffered: false,
    composerHasNonPromptContent: false,
    isSendBusy: false,
    isConnecting: false,
    isRevertingCheckpoint: false,
    clientSettingsHydrated: true,
    threadDetailLoading: false,
    needsLoadBalancing: false,
    activeEnvironmentUnavailable: false,
    activePendingProgress: null,
    editingQueuedRun: null,
    showPlanFollowUpPrompt: false,
    activeMessageCount: 1,
    sendEnvMode: "local",
    startFromOrigin: false,
    supportsAttachmentUploads: true,
    isDraftHeroState: false,
    phase: "idle",
    localCheckoutBranchMismatch: null,
    feedbackUploadsInFlightRef: { current: new Set<string>() },
    serverConfig: { environment: { capabilities: { attachmentUploads: true } } },
    settings: { planModeEnabled: false },
    runtimeMode: "full-access",
    environmentServerConfigsAtom: "configs",
    newMessageId: () => MessageId.make(`message-${refs.composerSendGenerationRef.current + 1}`),
    formatOutgoingPrompt: ({ text }: { text: string }) => text,
    buildMessageContext: () => undefined,
    shouldDockDraftHeroForSubmission: () => false,
    beginLocalDispatch: vi.fn(),
    setWorktreeSetupRef: vi.fn(),
    resetLocalDispatch: vi.fn(),
    setDockedDraftHeroThreadKey: vi.fn(),
    clearUsageLimitsFor: vi.fn(),
    acknowledgeActiveThreadWoke: vi.fn(),
    isAtEndRef: { current: false },
    timelineScrollModeRef: { current: "" },
    liveFollowUserScrollGenerationRef: { current: 0 },
    anchorUserScrollGenerationRef: { current: 0 },
    pendingTimelineAnchorRef: { current: null },
    activeTimelineAnchorIndexRef: { current: null },
    showScrollDebouncer: { current: { cancel: vi.fn() } },
    setShowScrollToBottom: vi.fn(),
    setTimelineLiveFollowEnabled: vi.fn(),
    setTimelineAnchor: vi.fn(),
    setThreadError,
    startThreadTurn,
    persistThreadSettingsForNextTurn: persistSettings,
    setOptimisticUserMessages: (update: (existing: ChatMessage[]) => ChatMessage[]) => {
      messages = update(messages);
    },
    clearComposerDraftContent: store.clearComposerContent,
    setComposerDraftPrompt: store.setPrompt,
    addComposerDraftImages: store.addImages,
    addComposerDraftFiles: store.addFiles,
    setComposerDraftTerminalContexts: store.setTerminalContexts,
    setComposerDraftPreviewAnnotations: store.setPreviewAnnotations,
    setComposerDraftReviewComments: store.setReviewComments,
    setComposerDraftThreadContexts: store.setThreadContexts,
    composerRef: {
      current: {
        resetCursorState,
        validateProviderInput: () => true,
        getSendContext: () => {
          const draft = store.getComposerDraft(target);
          return {
            ...draft,
            images: draft?.images ?? [],
            files: draft?.files ?? [],
            terminalContexts: draft?.terminalContexts ?? [],
            previewAnnotations: draft?.previewAnnotations ?? [],
            reviewComments: draft?.reviewComments ?? [],
            threadContexts: draft?.threadContexts ?? [],
            providerAvailable: true,
            multipleModelSelections: null,
            selectedProvider: "claudeAgent",
            selectedModel: "model",
            selectedProviderModels: [],
            selectedPromptEffort: null,
            selectedModelSelection: { instanceId: "claudeAgent", model: "model" },
            interactionMode: "default",
            interactionModeEnabled: false,
          };
        },
      },
    },
  };
  const send = new Function(...Object.keys(base), `${handler}\nreturn onSend;`)(
    ...Object.values(base),
  ) as () => Promise<void>;
  return {
    send,
    started,
    result,
    failure,
    refs,
    startThreadTurn,
    persistSettings,
    resetCursorState,
    setThreadError,
    settingsStarted,
    settingsResult,
    delaySettings: () =>
      persistSettings.mockImplementation(async () => {
        settingsStarted.resolve();
        return await settingsResult.promise;
      }),
    get messages() {
      return messages;
    },
    refresh: (destination = target) => {
      const draft = store.getComposerDraft(destination);
      refs.promptRef.current = draft?.prompt ?? "";
      refs.composerImagesRef.current = draft?.images ?? [];
      refs.composerFilesRef.current = draft?.files ?? [];
      refs.composerTerminalContextsRef.current = draft?.terminalContexts ?? [];
    },
  };
}
