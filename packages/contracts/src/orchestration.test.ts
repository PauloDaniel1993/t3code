import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ChatAttachment,
  ClientOrchestrationCommand,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationLatestTurn,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  OrchestrationProposedPlan,
  PROVIDER_SEND_TURN_MAX_DOCUMENT_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  UploadChatAttachment,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadShell,
  ProjectCreateCommand,
  resolveThreadTaskLimits,
  ThreadMetaUpdatedPayload,
  ThreadTurnStartCommand,
  ThreadCreatedPayload,
  ThreadTurnDiff,
  ThreadTurnStartRequestedPayload,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);
const decodeFullThreadDiffInput = Schema.decodeUnknownEffect(OrchestrationGetFullThreadDiffInput);
const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);
const decodeProjectCreateCommand = Schema.decodeUnknownEffect(ProjectCreateCommand);
const decodeProjectCreatedPayload = Schema.decodeUnknownEffect(ProjectCreatedPayload);
const decodeProjectMetaUpdatedPayload = Schema.decodeUnknownEffect(ProjectMetaUpdatedPayload);
const decodeThreadTurnStartCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeOrchestrationLatestTurn = Schema.decodeUnknownEffect(OrchestrationLatestTurn);
const decodeOrchestrationProposedPlan = Schema.decodeUnknownEffect(OrchestrationProposedPlan);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeOrchestrationThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeOrchestrationThreadShell = Schema.decodeUnknownEffect(OrchestrationThreadShell);
const encodeThreadCreatedPayload = Schema.encodeEffect(ThreadCreatedPayload);

function getOptionValue(
  options: ReadonlyArray<{ id: string; value: unknown }> | undefined,
  id: string,
): unknown {
  return options?.find((option) => option.id === id)?.value;
}
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);
const decodeChatAttachments = Schema.decodeUnknownEffect(Schema.Array(ChatAttachment));
const encodeChatAttachments = Schema.encodeUnknownEffect(Schema.Array(ChatAttachment));
const decodeUploadChatAttachment = Schema.decodeUnknownEffect(UploadChatAttachment);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);

const roundedDataUrlCharLimit = (maxBytes: number): number =>
  Math.ceil((maxBytes * 4) / (3 * 1_000_000)) * 1_000_000;

it.effect("parses turn diff input when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    assert.strictEqual(parsed.fromTurnCount, 1);
    assert.strictEqual(parsed.toTurnCount, 2);
  }),
);

it.effect("parses turn diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    assert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

it.effect("parses full thread diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFullThreadDiffInput({
      threadId: "thread-1",
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    assert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

it.effect("rejects turn diff input when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects thread turn diff when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeThreadTurnDiff({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        diff: "patch",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims branded ids and command string fields at decode boundaries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: " cmd-1 ",
      projectId: " project-1 ",
      title: " Project Title ",
      workspaceRoot: " /tmp/workspace ",
      defaultModelSelection: {
        provider: "codex",
        model: " gpt-5.2 ",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.commandId, "cmd-1");
    assert.strictEqual(parsed.projectId, "project-1");
    assert.strictEqual(parsed.title, "Project Title");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.strictEqual(parsed.createWorkspaceRootIfMissing, undefined);
    assert.deepStrictEqual(parsed.defaultModelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.2",
    });
  }),
);

it.effect("decodes project.create with createWorkspaceRootIfMissing enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: "cmd-1",
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      createWorkspaceRootIfMissing: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.createWorkspaceRootIfMissing, true);
  }),
);

it.effect("decodes historical project.created payloads with a default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "codex");
  }),
);

it.effect("decodes project.meta-updated payloads with explicit default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectMetaUpdatedPayload({
      projectId: "project-1",
      defaultModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "claudeAgent");
  }),
);

it.effect("rejects command fields that become empty after trim", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeProjectCreateCommand({
        type: "project.create",
        commandId: "cmd-1",
        projectId: "project-1",
        title: "  ",
        workspaceRoot: "/tmp/workspace",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes thread.turn.start defaults for provider and runtime mode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-1",
      threadId: "thread-1",
      message: {
        messageId: "msg-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection, undefined);
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("preserves explicit provider and runtime mode in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-2",
      threadId: "thread-1",
      message: {
        messageId: "msg-2",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    assert.strictEqual(parsed.runtimeMode, "full-access");
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("decodes valid persisted document and file attachment metadata", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeChatAttachments([
      {
        type: "document",
        id: "pdf-1",
        name: "design.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
      },
      {
        type: "file",
        id: "file-1",
        name: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
      },
    ]);

    assert.deepStrictEqual(
      parsed.map((attachment) => attachment.type),
      ["document", "file"],
    );
    assert.strictEqual(parsed[0]?.mimeType, "application/pdf");
    assert.strictEqual(parsed[1]?.sizeBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES);
  }),
);

it.effect("decodes valid document and file uploads", () =>
  Effect.gen(function* () {
    const document = yield* decodeUploadChatAttachment({
      type: "document",
      name: "design.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
      dataUrl: "data:application/pdf;base64,JVBERg==",
    });
    const file = yield* decodeUploadChatAttachment({
      type: "file",
      name: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: 4,
      dataUrl: "data:text/markdown;base64,dGVzdA==",
    });

    assert.strictEqual(document.type, "document");
    assert.strictEqual(file.type, "file");
  }),
);

it.effect("rejects empty document and file attachments", () =>
  Effect.gen(function* () {
    for (const attachment of [
      {
        type: "document",
        name: "empty.pdf",
        mimeType: "application/pdf",
        sizeBytes: 0,
        dataUrl: "data:application/pdf;base64,",
      },
      {
        type: "file",
        name: "empty.txt",
        mimeType: "text/plain",
        sizeBytes: 0,
        dataUrl: "data:text/plain;base64,",
      },
    ]) {
      const result = yield* Effect.exit(decodeUploadChatAttachment(attachment));
      assert.strictEqual(result._tag, "Failure");
    }
  }),
);

it.effect("enforces document and file decoded byte boundaries", () =>
  Effect.gen(function* () {
    const validDocument = yield* decodeUploadChatAttachment({
      type: "document",
      name: "boundary.pdf",
      mimeType: "application/pdf",
      sizeBytes: PROVIDER_SEND_TURN_MAX_DOCUMENT_BYTES,
      dataUrl: "data:application/pdf;base64,JVBERg==",
    });
    const validFile = yield* decodeUploadChatAttachment({
      type: "file",
      name: "boundary.txt",
      mimeType: "text/plain",
      sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
      dataUrl: "data:text/plain;base64,eA==",
    });
    assert.strictEqual(validDocument.sizeBytes, PROVIDER_SEND_TURN_MAX_DOCUMENT_BYTES);
    assert.strictEqual(validFile.sizeBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES);

    const oversizedDocument = yield* Effect.exit(
      decodeUploadChatAttachment({
        type: "document",
        name: "oversized.pdf",
        mimeType: "application/pdf",
        sizeBytes: PROVIDER_SEND_TURN_MAX_DOCUMENT_BYTES + 1,
        dataUrl: "data:application/pdf;base64,JVBERg==",
      }),
    );
    const oversizedFile = yield* Effect.exit(
      decodeUploadChatAttachment({
        type: "file",
        name: "oversized.txt",
        mimeType: "text/plain",
        sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
        dataUrl: "data:text/plain;base64,eA==",
      }),
    );
    assert.strictEqual(oversizedDocument._tag, "Failure");
    assert.strictEqual(oversizedFile._tag, "Failure");
  }),
);

it.effect("rejects document and file uploads over their encoded data URL caps", () =>
  Effect.gen(function* () {
    const oversizedDocument = yield* Effect.exit(
      decodeUploadChatAttachment({
        type: "document",
        name: "oversized.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        dataUrl: "x".repeat(roundedDataUrlCharLimit(PROVIDER_SEND_TURN_MAX_DOCUMENT_BYTES) + 1),
      }),
    );
    const oversizedFile = yield* Effect.exit(
      decodeUploadChatAttachment({
        type: "file",
        name: "oversized.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        dataUrl: "x".repeat(roundedDataUrlCharLimit(PROVIDER_SEND_TURN_MAX_FILE_BYTES) + 1),
      }),
    );
    assert.strictEqual(oversizedDocument._tag, "Failure");
    assert.strictEqual(oversizedFile._tag, "Failure");
  }),
);

it.effect("rejects non-canonical PDF MIME and malformed attachment variants", () =>
  Effect.gen(function* () {
    const nonCanonicalPdf = yield* Effect.exit(
      decodeUploadChatAttachment({
        type: "document",
        name: "design.pdf",
        mimeType: "Application/PDF",
        sizeBytes: 1,
        dataUrl: "data:application/pdf;base64,eA==",
      }),
    );
    const missingFileData = yield* Effect.exit(
      decodeUploadChatAttachment({
        type: "file",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
      }),
    );
    const unknownVariant = yield* Effect.exit(
      decodeUploadChatAttachment({
        type: "archive",
        name: "source.zip",
        mimeType: "application/zip",
        sizeBytes: 1,
        dataUrl: "data:application/zip;base64,eA==",
      }),
    );
    assert.strictEqual(nonCanonicalPdf._tag, "Failure");
    assert.strictEqual(missingFileData._tag, "Failure");
    assert.strictEqual(unknownVariant._tag, "Failure");
  }),
);

it.effect("round-trips mixed attachment order and discriminants", () =>
  Effect.gen(function* () {
    const input = [
      {
        type: "image",
        id: "image-1",
        name: "first.png",
        mimeType: "image/png",
        sizeBytes: 10,
      },
      {
        type: "document",
        id: "pdf-1",
        name: "second.pdf",
        mimeType: "application/pdf",
        sizeBytes: 20,
      },
      {
        type: "file",
        id: "file-1",
        name: "third.json",
        mimeType: "application/json",
        sizeBytes: 30,
      },
    ] as const;

    const decoded = yield* decodeChatAttachments(input);
    const encoded = yield* encodeChatAttachments(decoded);
    assert.deepStrictEqual(
      decoded.map((attachment) => attachment.type),
      ["image", "document", "file"],
    );
    assert.deepStrictEqual(encoded, input);
  }),
);

it.effect("rejects nine mixed upload attachments in a client turn command", () =>
  Effect.gen(function* () {
    const attachments = [
      ...Array.from({ length: 6 }, (_, index) => ({
        type: "image" as const,
        name: `image-${index}.png`,
        mimeType: "image/png",
        sizeBytes: 1,
        dataUrl: "data:image/png;base64,eA==",
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        type: "document" as const,
        name: `document-${index}.pdf`,
        mimeType: "application/pdf" as const,
        sizeBytes: 1,
        dataUrl: "data:application/pdf;base64,eA==",
      })),
      {
        type: "file" as const,
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        dataUrl: "data:text/plain;base64,eA==",
      },
    ];

    const result = yield* Effect.exit(
      decodeClientOrchestrationCommand({
        type: "thread.turn.start",
        commandId: "cmd-too-many-attachments",
        threadId: "thread-1",
        message: {
          messageId: "msg-too-many-attachments",
          role: "user",
          text: "",
          attachments,
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("accepts bootstrap metadata in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-bootstrap",
      threadId: "thread-1",
      message: {
        messageId: "msg-bootstrap",
        role: "user",
        text: "hello",
        attachments: [],
      },
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "Bootstrap thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        prepareWorktree: {
          projectCwd: "/tmp/workspace",
          baseBranch: "main",
          branch: "t3code/example",
          startFromOrigin: true,
        },
        runSetupScript: true,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.bootstrap?.createThread?.projectId, "project-1");
    assert.strictEqual(parsed.bootstrap?.prepareWorktree?.baseBranch, "main");
    assert.strictEqual(parsed.bootstrap?.prepareWorktree?.startFromOrigin, true);
    assert.strictEqual(parsed.bootstrap?.runSetupScript, true);
  }),
);

it.effect("decodes thread.created runtime mode for historical events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.modelSelection.instanceId, "codex");
  }),
);

it.effect("decodes thread.meta-updated payloads with explicit provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "claudeAgent");
  }),
);

it.effect("decodes thread archive and unarchive commands", () =>
  Effect.gen(function* () {
    const archive = yield* decodeOrchestrationCommand({
      type: "thread.archive",
      commandId: "cmd-archive-1",
      threadId: "thread-1",
    });
    const unarchive = yield* decodeOrchestrationCommand({
      type: "thread.unarchive",
      commandId: "cmd-unarchive-1",
      threadId: "thread-1",
    });

    assert.strictEqual(archive.type, "thread.archive");
    assert.strictEqual(unarchive.type, "thread.unarchive");
  }),
);

it.effect("decodes thread settle and unsettle commands", () =>
  Effect.gen(function* () {
    const settle = yield* decodeOrchestrationCommand({
      type: "thread.settle",
      commandId: "cmd-settle-1",
      threadId: "thread-1",
    });
    const unsettle = yield* decodeOrchestrationCommand({
      type: "thread.unsettle",
      commandId: "cmd-unsettle-1",
      threadId: "thread-1",
      reason: "user",
    });

    assert.strictEqual(settle.type, "thread.settle");
    assert.strictEqual(unsettle.type, "thread.unsettle");

    // "activity" is server-owned: it exists on the event, never on the
    // command, so a client cannot forge the neutral reset.
    const forged = yield* decodeOrchestrationCommand({
      type: "thread.unsettle",
      commandId: "cmd-unsettle-2",
      threadId: "thread-1",
      reason: "activity",
    }).pipe(Effect.flip);
    assert.ok(forged);
  }),
);

it.effect("defaults settled fields when decoding historical thread data", () =>
  Effect.gen(function* () {
    const common = {
      id: "thread-1",
      projectId: "project-1",
      title: "Historical thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      session: null,
    };
    const thread = yield* decodeOrchestrationThread({
      ...common,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
    const shell = yield* decodeOrchestrationThreadShell({
      ...common,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    });

    assert.strictEqual(thread.settledOverride, null);
    assert.strictEqual(thread.settledAt, null);
    assert.strictEqual(shell.settledOverride, null);
    assert.strictEqual(shell.settledAt, null);
  }),
);

it.effect("decodes thread archived and unarchived events", () =>
  Effect.gen(function* () {
    const archived = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-archive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.archived",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-archive-1",
      causationEventId: null,
      correlationId: "cmd-archive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        archivedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unarchived = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unarchive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unarchived",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unarchive-1",
      causationEventId: null,
      correlationId: "cmd-unarchive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    if (archived.type !== "thread.archived") {
      assert.fail(`Expected thread.archived event, received ${archived.type}.`);
    }
    assert.strictEqual(archived.payload.archivedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(unarchived.type, "thread.unarchived");
  }),
);

it.effect("decodes thread settled and unsettled events", () =>
  Effect.gen(function* () {
    const settled = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-settle-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.settled",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-settle-1",
      causationEventId: null,
      correlationId: "cmd-settle-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        settledAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unsettled = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unsettle-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unsettled",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unsettle-1",
      causationEventId: null,
      correlationId: "cmd-unsettle-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        reason: "user",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    assert.strictEqual(settled.type, "thread.settled");
    assert.strictEqual(unsettled.type, "thread.unsettled");
  }),
);

it.effect("accepts provider-scoped model options in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-options",
      threadId: "thread-1",
      message: {
        messageId: "msg-options",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    assert.strictEqual(getOptionValue(parsed.modelSelection?.options, "reasoningEffort"), "high");
    assert.strictEqual(getOptionValue(parsed.modelSelection?.options, "fastMode"), true);
  }),
);

it.effect("normalizes legacy object-shaped modelSelection.options on decode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Legacy options thread",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          effort: "max",
          fastMode: true,
          // Falsy/garbage entries are dropped, matching migration 026.
          emptyStr: "   ",
          nullish: null,
          nested: { foo: 1 },
        },
      },
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.modelSelection.instanceId, ProviderInstanceId.make("claudeAgent"));
    assert.deepStrictEqual(parsed.modelSelection.options, [
      { id: "effort", value: "max" },
      { id: "fastMode", value: true },
    ]);
  }),
);

it.effect("normalizes legacy object-shaped defaultModelSelection.options on decode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Legacy default project",
      workspaceRoot: "/tmp/legacy",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
        options: { reasoningEffort: "low" },
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.deepStrictEqual(parsed.defaultModelSelection?.options, [
      { id: "reasoningEffort", value: "low" },
    ]);
  }),
);

it.effect(
  "normalizes legacy object-shaped options on decode and re-encodes as canonical array",
  () =>
    Effect.gen(function* () {
      const decoded = yield* decodeThreadCreatedPayload({
        threadId: "thread-1",
        projectId: "project-1",
        title: "Round trip thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
          options: { fastMode: true },
        },
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const encoded = yield* encodeThreadCreatedPayload(decoded);
      assert.deepStrictEqual(encoded.modelSelection.options, [{ id: "fastMode", value: true }]);
    }),
);

it.effect("accepts a title seed in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-title-seed",
      threadId: "thread-1",
      message: {
        messageId: "msg-title-seed",
        role: "user",
        text: "hello",
        attachments: [],
      },
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("accepts a source proposed plan reference in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-source-plan",
      threadId: "thread-2",
      message: {
        messageId: "msg-source-plan",
        role: "user",
        text: "implement this",
        attachments: [],
      },
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect(
  "decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(parsed.modelSelection, undefined);
      assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
      assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      assert.strictEqual(parsed.sourceProposedPlan, undefined);
    }),
);

it.effect("decodes thread.turn-start-requested source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes thread.turn-start-requested title seed when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("decodes latest turn source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationLatestTurn({
      turnId: "turn-2",
      state: "running",
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes orchestration session runtime mode defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "idle",
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
  }),
);

it.effect("defaults proposed plan implementation metadata for historical rows", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, null);
    assert.strictEqual(parsed.implementationThreadId, null);
  }),
);

it.effect("preserves proposed plan implementation metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-2",
      turnId: "turn-2",
      planMarkdown: "# Plan",
      implementedAt: "2026-01-02T00:00:00.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, "2026-01-02T00:00:00.000Z");
    assert.strictEqual(parsed.implementationThreadId, "thread-2");
  }),
);

// ── ModelSelection: instance-keyed wire shape + legacy decoder ────────
//
// `ModelSelection` is routing-keyed on `instanceId` — never a driver kind.
// Persisted and in-flight payloads from pre-instance builds carry a
// `provider` field whose value was a driver kind; those payloads are migrated
// at the wire boundary by
// promoting `provider` to the default instance id for that driver
// (built-in drivers use the driver kind slug as their default instance id, so
// the migration is a 1:1 rename).
//
// These tests pin the rollback/fork tolerance invariant: legacy payloads
// decode cleanly for fork-provided drivers, and the decoded form uses
// `instanceId` uniformly regardless of origin.

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const encodeModelSelection = Schema.encodeUnknownEffect(ModelSelection);

it.effect("ModelSelection migrates legacy `provider` field to `instanceId`", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      model: "gpt-5-codex",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex"));
    assert.strictEqual(parsed.model, "gpt-5-codex");
    assert.deepStrictEqual(parsed.options, [{ id: "reasoningEffort", value: "high" }]);
  }),
);

it.effect("ModelSelection accepts an explicit instanceId routing key", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect("ModelSelection prefers explicit instanceId over legacy provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect(
  "ModelSelection decodes unknown driver kinds via legacy provider (rollback / fork invariant)",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeModelSelection({
        provider: "ollama",
        model: "llama3:70b",
        options: [{ id: "temperature", value: "0.4" }],
      });
      assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("ollama"));
      assert.strictEqual(parsed.model, "llama3:70b");
    }),
);

it.effect("ModelSelection encodes to the canonical instanceId wire form", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeModelSelection({
      provider: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
    const encoded = yield* encodeModelSelection(decoded);
    assert.deepStrictEqual(encoded, {
      instanceId: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
  }),
);

it.effect("ModelSelection rejects malformed instance ids", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeModelSelection({
        instanceId: "1invalid", // must start with a letter
        model: "x",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it("resolveThreadTaskLimits derives the lifetime cap from the concurrent one", () => {
  assert.deepStrictEqual(resolveThreadTaskLimits({}), { maxRunning: 5, maxTotal: 25 });
  assert.deepStrictEqual(resolveThreadTaskLimits({ maxRunning: 12 }), {
    maxRunning: 12,
    maxTotal: 60,
  });
  // An explicit total wins; null and undefined both mean "derive it".
  assert.deepStrictEqual(resolveThreadTaskLimits({ maxRunning: 12, maxTotal: 13 }), {
    maxRunning: 12,
    maxTotal: 13,
  });
  assert.deepStrictEqual(resolveThreadTaskLimits({ maxRunning: 3, maxTotal: null }), {
    maxRunning: 3,
    maxTotal: 15,
  });
});
