import {
  EnvironmentId,
  MessageId,
  ProjectId,
  type PreviewAnnotationPayload,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ChatMessage, Thread, ThreadShell } from "../types";
import type { ElementContextDraft } from "../lib/elementContext";
import type { TerminalContextDraft } from "../lib/terminalContext";
import type { ReviewCommentContext } from "../reviewCommentContext";
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLoadingThreadFromShell,
  buildThreadTurnInterruptInput,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  getStartedThreadModelChangeBlockReason,
  hasEnvironmentReconnectWarningGraceElapsed,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  mergeFailedSendDraft,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  removeOptimisticUserMessage,
  resolveThreadErrorBannerState,
  resolveBackgroundDraftWorkspaceOptions,
  resolveDraftPromotionNavigationTarget,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  resolveDraftHeroState,
  scheduleEnvironmentReconnectWarning,
  startNewThreadForProject,
  revokeUserMessagePreviewUrls,
  shouldDockDraftHeroForSubmission,
  shouldShowBranchMismatchBanner,
  shouldWriteThreadErrorToCurrentServerThread,
} from "./ChatView.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

function makeTerminalContext(
  id: string,
  overrides: Partial<TerminalContextDraft> = {},
): TerminalContextDraft {
  return {
    id,
    threadId,
    terminalId: "terminal-1",
    terminalLabel: "Terminal 1",
    lineStart: 1,
    lineEnd: 2,
    text: "terminal output",
    createdAt: now,
    ...overrides,
  };
}

function makeElementContext(
  id: string,
  overrides: Partial<ElementContextDraft> = {},
): ElementContextDraft {
  return {
    id,
    threadId,
    pickedAt: now,
    pageUrl: "http://localhost:3000",
    pageTitle: "Preview",
    tagName: "button",
    selector: "button.save",
    htmlPreview: "<button>Save</button>",
    componentName: "SaveButton",
    source: null,
    styles: "",
    ...overrides,
  };
}

function makePreviewAnnotation(
  id: string,
  overrides: Partial<PreviewAnnotationPayload> = {},
): PreviewAnnotationPayload {
  return {
    id,
    pageUrl: "http://localhost:3000",
    pageTitle: "Preview",
    comment: "Review this change.",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: now,
    ...overrides,
  };
}

function makeReviewComment(
  id: string,
  overrides: Partial<ReviewCommentContext> = {},
): ReviewCommentContext {
  return {
    id,
    sectionId: "file:src/example.ts",
    sectionTitle: "File comment",
    filePath: "src/example.ts",
    startIndex: 0,
    endIndex: 1,
    rangeLabel: "L1 to L2",
    text: "Please update this.",
    diff: "@@ -1,2 +1,2 @@\n example",
    ...overrides,
  };
}

describe("draft hero submission transition", () => {
  it("does not dock the composer before a background submission", () => {
    expect(
      shouldDockDraftHeroForSubmission({
        isDraftHeroState: true,
        activeThreadKey: "environment-local:thread-1",
        submissionIntent: "background",
      }),
    ).toBe(false);
  });

  it("keeps the composer in the hero layout until navigation after server promotion", () => {
    expect(
      resolveDraftHeroState({
        isLocalDraftThread: false,
        hasTimelineEntries: true,
        isWorking: true,
        draftHeroDockRequested: false,
        backgroundSubmissionPending: true,
      }),
    ).toBe(true);
  });

  it("does not auto-navigate a background submission after server promotion", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef: { environmentId, threadId },
        serverThreadStarted: true,
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });
});

describe("environment reconnect warning grace", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a persistent reconnect after the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    scheduleEnvironmentReconnectWarning(showWarning);
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS - 1);
    expect(showWarning).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(showWarning).toHaveBeenCalledOnce();
  });

  it("cancels the warning when the connection recovers during the grace period", () => {
    vi.useFakeTimers();
    const showWarning = vi.fn();

    const cancel = scheduleEnvironmentReconnectWarning(showWarning);
    cancel();
    vi.advanceTimersByTime(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);

    expect(showWarning).not.toHaveBeenCalled();
  });

  it("does not reuse elapsed grace from another environment", () => {
    const anotherEnvironmentId = EnvironmentId.make("environment-remote");

    expect(hasEnvironmentReconnectWarningGraceElapsed(environmentId, environmentId)).toBe(true);
    expect(hasEnvironmentReconnectWarningGraceElapsed(anotherEnvironmentId, environmentId)).toBe(
      false,
    );
  });
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  threadId,
  status: "ready" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("buildLoadingThreadFromShell", () => {
  it("preserves shell metadata and supplies empty detail collections", () => {
    const shell = {
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      session: null,
      latestUserMessageAt: now,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } satisfies ThreadShell;

    expect(buildLoadingThreadFromShell(shell)).toMatchObject({
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      branch: "main",
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
  });
});

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("buildThreadTurnInterruptInput", () => {
  it("targets the session's active running turn", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId });
  });

  it("omits a turn id when the session is not running", () => {
    expect(buildThreadTurnInterruptInput(makeThread({ session: readySession }))).toEqual({
      threadId,
    });
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      attachmentCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      attachmentCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      attachmentCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats PDF-only, file-only, and mixed attachment drafts as sendable", () => {
    for (const attachmentCount of [1, 2, 8]) {
      expect(
        deriveComposerSendState({
          prompt: "",
          attachmentCount,
          terminalContexts: [],
        }).hasSendableContent,
      ).toBe(true);
    }
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        attachmentCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("mergeFailedSendDraft", () => {
  it("fully restores a failed send into an empty composer", () => {
    const failedAttachment = { id: "failed-attachment", name: "failed.png" };

    expect(
      mergeFailedSendDraft({
        currentPrompt: "",
        failedPrompt: "Retry this request",
        currentAttachments: [],
        failedAttachments: [failedAttachment],
      }),
    ).toEqual({
      prompt: "Retry this request",
      attachments: [failedAttachment],
      restoredFailedAttachments: [failedAttachment],
      droppedFailedAttachments: [],
      restoredFailedText: true,
      terminalContexts: [],
      elementContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      maxAttachments: 8,
    });
  });

  it("preserves concurrent text and contexts while restoring a failed send", () => {
    const currentAttachment = { id: "current-attachment", name: "new.png" };
    const duplicateFailedAttachment = { id: "current-attachment", name: "new-copy.png" };
    const failedAttachment = { id: "failed-attachment", name: "failed.png" };
    const overflowAttachment = { id: "overflow-attachment", name: "overflow.png" };
    const currentTerminalContext = makeTerminalContext("terminal-current");
    const duplicateFailedTerminalContext = makeTerminalContext("terminal-duplicate");
    const failedTerminalContext = makeTerminalContext("terminal-failed", {
      lineStart: 3,
      lineEnd: 4,
    });
    const currentElementContext = makeElementContext("element-current");
    const duplicateFailedElementContext = makeElementContext("element-duplicate", {
      htmlPreview: "<button>Updated save</button>",
    });
    const failedElementContext = makeElementContext("element-failed", {
      selector: "button.cancel",
      componentName: "CancelButton",
    });
    const currentPreviewAnnotation = makePreviewAnnotation("preview-current");
    const duplicateFailedPreviewAnnotation = makePreviewAnnotation("preview-current", {
      comment: "Updated failed annotation.",
    });
    const failedPreviewAnnotation = makePreviewAnnotation("preview-failed");
    const currentReviewComment = makeReviewComment("review-current");
    const duplicateFailedReviewComment = makeReviewComment("review-current", {
      text: "Updated failed review comment.",
    });
    const failedReviewComment = makeReviewComment("review-failed");
    const merged = mergeFailedSendDraft({
      currentPrompt: "New text typed while sending",
      failedPrompt: "Failed text",
      currentAttachments: [currentAttachment],
      failedAttachments: [duplicateFailedAttachment, failedAttachment, overflowAttachment],
      currentTerminalContexts: [currentTerminalContext],
      failedTerminalContexts: [duplicateFailedTerminalContext, failedTerminalContext],
      currentElementContexts: [currentElementContext],
      failedElementContexts: [duplicateFailedElementContext, failedElementContext],
      currentPreviewAnnotations: [currentPreviewAnnotation],
      failedPreviewAnnotations: [duplicateFailedPreviewAnnotation, failedPreviewAnnotation],
      currentReviewComments: [currentReviewComment],
      failedReviewComments: [duplicateFailedReviewComment, failedReviewComment],
      maxAttachments: 2,
    });
    const optimisticMessage = {
      id: MessageId.make("optimistic-message"),
      role: "user" as const,
      text: "Failed text",
      attachments: [
        {
          type: "image" as const,
          id: "failed-attachment",
          name: "failed.png",
          mimeType: "image/png",
          sizeBytes: 1,
          previewUrl: "blob:failed-attachment",
        },
      ],
      turnId: null,
      createdAt: now,
      updatedAt: now,
      streaming: false,
    } satisfies ChatMessage;

    expect(merged.prompt).toBe("New text typed while sending\n\nFailed text");
    expect(merged.attachments).toEqual([currentAttachment, failedAttachment]);
    expect(merged.restoredFailedAttachments).toEqual([failedAttachment]);
    expect(merged.droppedFailedAttachments).toEqual([overflowAttachment]);
    expect(merged.terminalContexts).toEqual([currentTerminalContext, failedTerminalContext]);
    expect(merged.elementContexts).toEqual([currentElementContext, failedElementContext]);
    expect(merged.previewAnnotations).toEqual([currentPreviewAnnotation, failedPreviewAnnotation]);
    expect(merged.reviewComments).toEqual([currentReviewComment, failedReviewComment]);
    expect(removeOptimisticUserMessage([optimisticMessage], optimisticMessage.id).messages).toEqual(
      [],
    );
  });

  it("does not duplicate an identical failed prompt", () => {
    const attachment = { id: "attachment", name: "attachment.png" };

    const merged = mergeFailedSendDraft({
      currentPrompt: "Same text",
      failedPrompt: "Same text",
      currentAttachments: [attachment],
      failedAttachments: [],
    });

    expect(merged.prompt).toBe("Same text");
    expect(merged.restoredFailedText).toBe(false);
  });

  it("keeps current attachments at the cap and reports failed attachment overflow", () => {
    const currentAttachments = Array.from({ length: 7 }, (_, index) => ({
      id: `current-${index}`,
      name: `current-${index}.txt`,
    }));
    const restoredAttachment = { id: "failed-0", name: "restored.png" };
    const droppedAttachments = [
      { id: "failed-1", name: "dropped-one.pdf" },
      { id: "failed-2", name: "dropped-two.txt" },
    ];

    const merged = mergeFailedSendDraft({
      currentPrompt: "",
      failedPrompt: "Failed text",
      currentAttachments,
      failedAttachments: [restoredAttachment, ...droppedAttachments],
    });

    expect(merged.attachments).toEqual([...currentAttachments, restoredAttachment]);
    expect(merged.restoredFailedAttachments).toEqual([restoredAttachment]);
    expect(merged.droppedFailedAttachments).toEqual(droppedAttachments);
  });

  it("revokes a removed optimistic image preview exactly once", () => {
    const optimisticMessage = {
      id: MessageId.make("optimistic-message"),
      role: "user" as const,
      text: "Failed text",
      attachments: [
        {
          type: "image" as const,
          id: "failed-attachment",
          name: "failed.png",
          mimeType: "image/png",
          sizeBytes: 1,
          previewUrl: "blob:failed-attachment",
        },
      ],
      turnId: null,
      createdAt: now,
      updatedAt: now,
      streaming: false,
    } satisfies ChatMessage;
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    try {
      const cleanup = removeOptimisticUserMessage([optimisticMessage], optimisticMessage.id);
      expect(cleanup.removedMessage).toBe(optimisticMessage);
      if (cleanup.removedMessage) {
        revokeUserMessagePreviewUrls(cleanup.removedMessage);
      }
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith("blob:failed-attachment");
    } finally {
      revoke.mockRestore();
    }
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("getStartedThreadModelChangeBlockReason", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      instanceId: ProviderInstanceId.make("grok"),
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows model changes before a provider session has started", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: false,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toBeNull();
  });

  it("allows unchanged model selections for restricted providers", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toBeNull();
  });

  it("blocks started-session model changes when either provider requires a new thread", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toEqual({
      title: "Start a new chat to change models",
      description:
        "This provider does not allow switching models after a conversation has started.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("resolveBackgroundDraftWorkspaceOptions", () => {
  it("keeps New worktree selected without reusing the launched worktree", () => {
    expect(
      resolveBackgroundDraftWorkspaceOptions({
        envMode: "worktree",
        branch: "main",
        startFromOrigin: true,
      }),
    ).toEqual({
      envMode: "worktree",
      branch: "main",
      worktreePath: null,
      startFromOrigin: true,
    });
  });
});

describe("branchMismatchKey", () => {
  it("builds a key from thread id and both branches", () => {
    expect(branchMismatchKey("thread-1", { threadBranch: "feat/a", currentBranch: "feat/b" })).toBe(
      "thread-1:feat/a:feat/b",
    );
  });

  it("returns null without a thread or mismatch", () => {
    expect(branchMismatchKey(null, { threadBranch: "a", currentBranch: "b" })).toBeNull();
    expect(branchMismatchKey("thread-1", null)).toBeNull();
  });
});

describe("shouldShowBranchMismatchBanner", () => {
  const base = {
    hasMismatch: true,
    isDismissed: false,
    composerHasContent: false,
    wasShownForCurrentMismatch: false,
  };

  it("stays hidden during passive browsing (even though the composer autofocuses)", () => {
    expect(shouldShowBranchMismatchBanner(base)).toBe(false);
  });

  it("shows once the composer has draft content", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, composerHasContent: true })).toBe(true);
  });

  it("stays mounted after the draft clears once shown for the current mismatch", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, wasShownForCurrentMismatch: true })).toBe(
      true,
    );
  });

  it("never shows when dismissed or without a mismatch", () => {
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, isDismissed: true }),
    ).toBe(false);
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, hasMismatch: false }),
    ).toBe(false);
  });
});

describe("session branch mismatch dismissal", () => {
  it("tracks dismissed keys and treats other keys as active", () => {
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(false);
    dismissBranchMismatchForSession("t1:a:b");
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(true);
    expect(isBranchMismatchDismissedForSession("t1:a:c")).toBe(false);
    expect(isBranchMismatchDismissedForSession(null)).toBe(false);
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("reconcileRetainedMountedThreadIds", () => {
  it("retains hidden open threads and adds the active open thread", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden")],
        openThreadIds: [ThreadId.make("thread-hidden")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("can retain the active thread as hidden when it is inactive", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-active")],
        openThreadIds: [ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make("thread-active")]);
  });

  it("evicts the oldest hidden threads beyond the configured cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("writes errors for a shell-derived active server thread", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
  });

  it("requires an active server thread matching the environment, route, and target", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("startNewThreadForProject", () => {
  it("starts a thread through the supplied shared handler for the active project", () => {
    const calls: Array<{ environmentId: EnvironmentId; projectId: ProjectId }> = [];
    const projectRef = { environmentId, projectId };

    expect(
      startNewThreadForProject(projectRef, (nextProjectRef) => {
        calls.push(nextProjectRef);
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(calls).toEqual([projectRef]);
  });

  it("does nothing when the active project is unavailable", () => {
    let called = false;

    expect(
      startNewThreadForProject(null, () => {
        called = true;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});

describe("resolveThreadErrorBannerState", () => {
  it("hides the dismissed session error across rerenders", () => {
    const visible = resolveThreadErrorBannerState({
      threadKey: "environment-local:thread-1",
      localError: null,
      sessionError: "Provider work was interrupted.",
      sessionUpdatedAt: now,
      dismissedSessionErrorKey: null,
    });

    expect(visible.error).toBe("Provider work was interrupted.");
    expect(visible.sessionErrorKey).not.toBeNull();
    expect(
      resolveThreadErrorBannerState({
        threadKey: "environment-local:thread-1",
        localError: null,
        sessionError: "Provider work was interrupted.",
        sessionUpdatedAt: now,
        dismissedSessionErrorKey: visible.sessionErrorKey,
      }).error,
    ).toBeNull();
  });

  it("shows a new session error instance and never hides a client-local error", () => {
    const dismissed = resolveThreadErrorBannerState({
      threadKey: "environment-local:thread-1",
      localError: null,
      sessionError: "Provider work was interrupted.",
      sessionUpdatedAt: now,
      dismissedSessionErrorKey: null,
    }).sessionErrorKey;
    const nextUpdatedAt = "2026-03-29T00:01:00.000Z";

    expect(
      resolveThreadErrorBannerState({
        threadKey: "environment-local:thread-1",
        localError: null,
        sessionError: "Provider work was interrupted.",
        sessionUpdatedAt: nextUpdatedAt,
        dismissedSessionErrorKey: dismissed,
      }).error,
    ).toBe("Provider work was interrupted.");
    expect(
      resolveThreadErrorBannerState({
        threadKey: "environment-local:thread-1",
        localError: "Failed to send message.",
        sessionError: "Provider work was interrupted.",
        sessionUpdatedAt: now,
        dismissedSessionErrorKey: dismissed,
      }),
    ).toEqual({ error: "Failed to send message.", sessionErrorKey: null });
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: completedTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("keeps a follow-up active while its provider session is starting", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "connecting",
        latestTurn: completedTurn,
        latestUserMessageId: MessageId.make("message-followup"),
        session: {
          ...readySession,
          status: "starting",
          updatedAt: "2026-03-29T00:01:00.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const newerTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: newerTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      state: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: TurnId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: runningTurn.turnId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running turn", () => {
    const runningTurn = {
      ...completedTurn,
      state: "running" as const,
      completedAt: null,
    };
    const runningSession = {
      ...readySession,
      status: "running" as const,
      activeTurnId: runningTurn.turnId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestTurn: runningTurn,
        session: runningSession,
        messages: [
          {
            id: MessageId.make("message-before-steer"),
            role: "user",
            text: "Initial prompt",
            turnId: runningTurn.turnId,
            createdAt: runningTurn.requestedAt,
            updatedAt: runningTurn.requestedAt,
            streaming: false,
          },
        ],
      }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: MessageId.make("message-steer"),
        session: runningSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestTurn: null,
      latestUserMessageId: localDispatch.latestUserMessageId,
      session: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });
});
