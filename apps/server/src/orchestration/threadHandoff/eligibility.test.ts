import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getHandoffSourceRejectionDetail,
  hasNativeMessageAfterPreviousImports,
  isImportableHandoffMessage,
  makeImportedHandoffMessageId,
  validateReadyHandoffTargetModel,
} from "./eligibility.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeMessage(
  id: string,
  overrides: Partial<OrchestrationMessage> = {},
): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role: "user",
    text: "hello",
    turnId: null,
    streaming: false,
    source: "user",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.make("thread-source"),
    projectId: ProjectId.make("project-1"),
    title: "Source thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    handoff: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
    messages: [makeMessage("message-1")],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("deepseek"),
    driver: ProviderDriverKind.make("deepseek"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: {
      status: "authenticated",
    },
    checkedAt: NOW,
    models: [
      {
        slug: "deepseek-chat",
        name: "DeepSeek Chat",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("thread handoff eligibility", () => {
  it("builds deterministic imported message ids", () => {
    expect(
      makeImportedHandoffMessageId({
        targetThreadId: ThreadId.make("thread-target"),
        sourceMessageId: MessageId.make("source-message-1"),
      }),
    ).toBe("handoff:thread-target:source-message-1");
  });

  it("filters importable handoff messages by streaming, text, and attachments", () => {
    expect(isImportableHandoffMessage(makeMessage("text", { text: "hello" }))).toBe(true);
    expect(isImportableHandoffMessage(makeMessage("empty", { text: "   " }))).toBe(false);
    expect(isImportableHandoffMessage(makeMessage("streaming", { streaming: true }))).toBe(false);
    expect(
      isImportableHandoffMessage(
        makeMessage("attachment", {
          text: "",
          attachments: [
            {
              type: "image",
              id: "att-1",
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: 512,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("requires a native message after prior handoff imports before chaining again", () => {
    expect(
      hasNativeMessageAfterPreviousImports({
        messages: [
          makeMessage("imported", {
            source: "handoff-import",
            sourceThreadId: ThreadId.make("thread-old"),
            sourceMessageId: MessageId.make("old-message"),
          }),
        ],
      }),
    ).toBe(false);
    expect(
      hasNativeMessageAfterPreviousImports({
        messages: [
          makeMessage("imported", { source: "handoff-import" }),
          makeMessage("native", { source: "user" }),
        ],
      }),
    ).toBe(true);
  });

  it("rejects source threads with unresolved approval or user-input requests", () => {
    expect(
      getHandoffSourceRejectionDetail(
        makeThread({
          activities: [
            {
              id: EventId.make("activity-approval"),
              tone: "approval",
              kind: "approval.requested",
              summary: "Approve command",
              payload: {
                requestId: "approval-1",
                requestKind: "command",
              },
              turnId: null,
              sequence: 1,
              createdAt: NOW,
            },
          ],
        }),
      ),
    ).toContain("pending approval");

    expect(
      getHandoffSourceRejectionDetail(
        makeThread({
          activities: [
            {
              id: EventId.make("activity-input"),
              tone: "approval",
              kind: "user-input.requested",
              summary: "Choose option",
              payload: {
                requestId: "input-1",
                questions: [],
              },
              turnId: null,
              sequence: 1,
              createdAt: NOW,
            },
          ],
        }),
      ),
    ).toContain("waiting for provider input");
  });

  it("allows source threads after pending requests are resolved or marked stale", () => {
    expect(
      getHandoffSourceRejectionDetail(
        makeThread({
          activities: [
            {
              id: EventId.make("activity-approval-requested"),
              tone: "approval",
              kind: "approval.requested",
              summary: "Approve command",
              payload: {
                requestId: "approval-1",
                requestKind: "command",
              },
              turnId: null,
              sequence: 1,
              createdAt: NOW,
            },
            {
              id: EventId.make("activity-approval-resolved"),
              tone: "approval",
              kind: "approval.resolved",
              summary: "Approved",
              payload: {
                requestId: "approval-1",
              },
              turnId: null,
              sequence: 2,
              createdAt: NOW,
            },
            {
              id: EventId.make("activity-input-requested"),
              tone: "approval",
              kind: "user-input.requested",
              summary: "Choose option",
              payload: {
                requestId: "input-1",
                questions: [],
              },
              turnId: null,
              sequence: 3,
              createdAt: NOW,
            },
            {
              id: EventId.make("activity-input-stale"),
              tone: "error",
              kind: "provider.user-input.respond.failed",
              summary: "Stale",
              payload: {
                requestId: "input-1",
                detail: "unknown pending user input request",
              },
              turnId: null,
              sequence: 4,
              createdAt: NOW,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("validates ready handoff target models against provider snapshots", () => {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("deepseek"),
      model: "deepseek-chat",
    };

    expect(
      validateReadyHandoffTargetModel({
        providers: [makeProvider()],
        modelSelection,
      }),
    ).toEqual({ ok: true });
    expect(
      validateReadyHandoffTargetModel({
        providers: [],
        modelSelection,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateReadyHandoffTargetModel({
        providers: [makeProvider({ status: "error" })],
        modelSelection,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateReadyHandoffTargetModel({
        providers: [makeProvider({ models: [] })],
        modelSelection,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateReadyHandoffTargetModel({
        providers: [makeProvider()],
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "missing-model",
        },
      }),
    ).toMatchObject({ ok: false });
  });
});
