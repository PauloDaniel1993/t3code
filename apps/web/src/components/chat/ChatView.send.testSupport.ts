import * as NodeModule from "node:module";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Runtime from "@t3tools/client-runtime/state/runtime";
import * as Model from "@t3tools/shared/model";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { truncate } from "@t3tools/shared/String";
import {
  MessageId,
  AuthOrchestrationOperateScope,
  DEFAULT_MODEL,
  type ScopedThreadRef,
  type ServerConfig,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
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
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import composerSendSource from "./useComposerSend.ts?raw";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { wasBootstrapThreadDeleted } from "@t3tools/client-runtime/errors";
import {
  prepareTurnAttachments,
  resolveMultipleModelTargets,
  restoreComposerDraft,
} from "./chatViewSend";

// Run the production handler itself, including its awaits and failure branches.
// Only the surrounding view's hook bindings are supplied by this headless harness;
// it avoids mounting unrelated timelines, terminals and browser panels.
const handlerStart = composerSendSource.indexOf("  const onSend = async (");
const handlerEnd = composerSendSource.indexOf("\n  return { onSend };", handlerStart);
if (handlerStart < 0 || handlerEnd < 0) throw new Error("Composer send handler was not found");
const handler = NodeModule.stripTypeScriptTypes(composerSendSource.slice(handlerStart, handlerEnd));

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
    environmentChangeRef: { current: null },
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
    deriveThreadTitleSeed,
    wasBootstrapThreadDeleted,
    prepareTurnAttachments,
    resolveMultipleModelTargets,
    restoreComposerDraft,
    readPendingEnvironmentChange: () => null,
    readEnvironmentPresentation: (id: ScopedThreadRef["environmentId"]) => ({
      serverConfig: (
        appAtomRegistry.get("configs" as never) as ReadonlyMap<
          ScopedThreadRef["environmentId"],
          ServerConfig
        >
      ).get(id),
    }),
    providerInstanceEntries: [],
    planModeEnabled: false,
    pendingApprovalsRef: { current: [] },
    respondingRequestIdsRef: { current: [] },
    queuedRunEdit: { isEditing: false },
    beginWorktreeSetup: vi.fn(),
    anchorNewTurn: vi.fn(),
    assistantCitationsToPlainText,
    truncate,
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    AuthOrchestrationOperateScope,
    DEFAULT_MODEL,
    readEnvironmentScope: () => true,
    sendQueuesBehindSetup: false,
    resumeCompactionTokens: null,
    keepFullHistory: false,
    setKeepFullHistory: vi.fn(),
    setSetupQueueSendThreadKey: vi.fn(),
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
