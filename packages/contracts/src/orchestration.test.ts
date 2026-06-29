// oxlint-disable t3code/no-manual-effect-runtime-in-tests
import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  OrchestrationProposedPlan,
  OrchestrationSession,
  ProjectCreateCommand,
  ThreadMessageSentPayload,
  ThreadMetaUpdatedPayload,
  ThreadTurnStartCommand,
  ThreadCreatedPayload,
  ThreadTurnDiff,
  ThreadTurnStartRequestedPayload,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const NodeAssert = {
  strictEqual: (actual: unknown, expected: unknown): void => {
    expect(actual).toBe(expected);
  },
  deepStrictEqual: (actual: unknown, expected: unknown): void => {
    expect(actual).toEqual(expected);
  },
  fail: (message: string): never => {
    throw new Error(message);
  },
};

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
const decodeOrchestrationMessage = Schema.decodeUnknownEffect(OrchestrationMessage);
const decodeOrchestrationProposedPlan = Schema.decodeUnknownEffect(OrchestrationProposedPlan);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
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
const decodeThreadMessageSentPayload = Schema.decodeUnknownEffect(ThreadMessageSentPayload);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);
function effectIt(name: string, body: () => Effect.Effect<unknown, object, never>): void {
  it(name, () => Effect.runPromise(body()));
}

effectIt("parses turn diff input when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    NodeAssert.strictEqual(parsed.fromTurnCount, 1);
    NodeAssert.strictEqual(parsed.toTurnCount, 2);
  }),
);

effectIt("parses turn diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    NodeAssert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

effectIt("parses full thread diff input with whitespace ignoring enabled", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFullThreadDiffInput({
      threadId: "thread-1",
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    NodeAssert.strictEqual(parsed.ignoreWhitespace, true);
  }),
);

effectIt("rejects turn diff input when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      }),
    );
    NodeAssert.strictEqual(result._tag, "Failure");
  }),
);

effectIt("rejects thread turn diff when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeThreadTurnDiff({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        diff: "patch",
      }),
    );
    NodeAssert.strictEqual(result._tag, "Failure");
  }),
);

effectIt("trims branded ids and command string fields at decode boundaries", () =>
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
    NodeAssert.strictEqual(parsed.commandId, "cmd-1");
    NodeAssert.strictEqual(parsed.projectId, "project-1");
    NodeAssert.strictEqual(parsed.title, "Project Title");
    NodeAssert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    NodeAssert.strictEqual(parsed.createWorkspaceRootIfMissing, undefined);
    NodeAssert.deepStrictEqual(parsed.defaultModelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.2",
    });
  }),
);

effectIt("decodes project.create with createWorkspaceRootIfMissing enabled", () =>
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

    NodeAssert.strictEqual(parsed.createWorkspaceRootIfMissing, true);
  }),
);

effectIt("decodes historical project.created payloads with a default provider", () =>
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
    NodeAssert.strictEqual(parsed.defaultModelSelection?.instanceId, "codex");
  }),
);

effectIt("decodes project.meta-updated payloads with explicit default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectMetaUpdatedPayload({
      projectId: "project-1",
      defaultModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    NodeAssert.strictEqual(parsed.defaultModelSelection?.instanceId, "claudeAgent");
  }),
);

effectIt("rejects command fields that become empty after trim", () =>
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
    NodeAssert.strictEqual(result._tag, "Failure");
  }),
);

effectIt("decodes thread.turn.start defaults for provider and runtime mode", () =>
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
    NodeAssert.strictEqual(parsed.modelSelection, undefined);
    NodeAssert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    NodeAssert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

effectIt("preserves explicit provider and runtime mode in thread.turn.start", () =>
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
    NodeAssert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    NodeAssert.strictEqual(parsed.runtimeMode, "full-access");
    NodeAssert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

effectIt("accepts bootstrap metadata in thread.turn.start", () =>
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
    NodeAssert.strictEqual(parsed.bootstrap?.createThread?.projectId, "project-1");
    NodeAssert.strictEqual(parsed.bootstrap?.prepareWorktree?.baseBranch, "main");
    NodeAssert.strictEqual(parsed.bootstrap?.prepareWorktree?.startFromOrigin, true);
    NodeAssert.strictEqual(parsed.bootstrap?.runSetupScript, true);
  }),
);

effectIt("decodes thread.created runtime mode for historical events", () =>
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

    NodeAssert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    NodeAssert.strictEqual(parsed.modelSelection.instanceId, "codex");
    NodeAssert.strictEqual(parsed.handoff, null);
  }),
);

effectIt("decodes thread.created handoff metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-target",
      projectId: "project-1",
      title: "Handoff: Source",
      modelSelection: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: "/tmp/workspace",
      handoff: {
        schemaVersion: 1,
        sourceThreadId: "thread-source",
        sourceTitle: "Source",
        sourceProviderInstanceId: "codex",
        targetProviderInstanceId: "deepseek",
        importedMessageCount: 2,
        bootstrapStatus: "pending",
        bootstrapMessageId: null,
        compression: {
          summaries: [
            {
              sourceMessageId: "msg-source-1",
              modelSelection: {
                provider: "deepseek",
                model: "deepseek-v4-flash",
              },
              sourceTextHash: "hash-1",
              summary: "Summary",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    NodeAssert.strictEqual(parsed.handoff?.sourceThreadId, "thread-source");
    NodeAssert.strictEqual(parsed.handoff?.targetProviderInstanceId, "deepseek");
    NodeAssert.strictEqual(
      parsed.handoff?.compression?.summaries[0]?.modelSelection.instanceId,
      "deepseek",
    );
  }),
);

effectIt("derives historical orchestration message source from role", () =>
  Effect.gen(function* () {
    const assistant = yield* decodeOrchestrationMessage({
      id: "msg-assistant",
      role: "assistant",
      text: "hello",
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const user = yield* decodeOrchestrationMessage({
      id: "msg-user",
      role: "user",
      text: "hello",
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const system = yield* decodeOrchestrationMessage({
      id: "msg-system",
      role: "system",
      text: "hello",
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    NodeAssert.strictEqual(assistant.source, "provider");
    NodeAssert.strictEqual(user.source, "user");
    NodeAssert.strictEqual(system.source, "system");
  }),
);

effectIt("preserves explicit imported message source metadata", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMessageSentPayload({
      threadId: "thread-target",
      messageId: "msg-imported",
      role: "assistant",
      text: "prior response",
      attachments: [],
      turnId: null,
      streaming: false,
      source: "handoff-import",
      sourceThreadId: "thread-source",
      sourceMessageId: "msg-source",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    NodeAssert.strictEqual(parsed.source, "handoff-import");
    NodeAssert.strictEqual(parsed.sourceThreadId, "thread-source");
    NodeAssert.strictEqual(parsed.sourceMessageId, "msg-source");
  }),
);

effectIt("derives historical thread.message-sent source from role", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMessageSentPayload({
      threadId: "thread-1",
      messageId: "msg-1",
      role: "assistant",
      text: "prior response",
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    NodeAssert.strictEqual(parsed.source, "provider");
  }),
);

effectIt("decodes thread.meta-updated payloads with explicit provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    NodeAssert.strictEqual(parsed.modelSelection?.instanceId, "claudeAgent");
  }),
);

effectIt("decodes thread archive and unarchive commands", () =>
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

    NodeAssert.strictEqual(archive.type, "thread.archive");
    NodeAssert.strictEqual(unarchive.type, "thread.unarchive");
  }),
);

effectIt("decodes thread handoff commands", () =>
  Effect.gen(function* () {
    const create = yield* decodeOrchestrationCommand({
      type: "thread.handoff.create",
      commandId: "cmd-handoff-create",
      sourceThreadId: "thread-source",
      targetThreadId: "thread-target",
      targetModelSelection: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const complete = yield* decodeOrchestrationCommand({
      type: "thread.handoff.bootstrap.complete",
      commandId: "server:handoff-bootstrap-complete:thread-target:msg-1",
      threadId: "thread-target",
      bootstrapMessageId: "msg-1",
      providerTurnId: "turn-provider-1",
      completedAt: "2026-01-01T00:00:01.000Z",
    });
    const skip = yield* decodeOrchestrationCommand({
      type: "thread.handoff.bootstrap.skip",
      commandId: "cmd-handoff-skip",
      threadId: "thread-target",
      reason: "No native message",
      skippedAt: "2026-01-01T00:00:01.000Z",
    });

    NodeAssert.strictEqual(create.type, "thread.handoff.create");
    if (create.type !== "thread.handoff.create") {
      NodeAssert.fail(`Expected handoff create command, received ${create.type}.`);
    }
    const handoffCreate = create as {
      readonly targetModelSelection: { readonly instanceId: string };
    };
    NodeAssert.strictEqual(handoffCreate.targetModelSelection.instanceId, "deepseek");
    NodeAssert.strictEqual(complete.type, "thread.handoff.bootstrap.complete");
    NodeAssert.strictEqual(skip.type, "thread.handoff.bootstrap.skip");
  }),
);

effectIt("decodes thread archived and unarchived events", () =>
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
      NodeAssert.fail(`Expected thread.archived event, received ${archived.type}.`);
    }
    const archivedEvent = archived as { readonly payload: { readonly archivedAt: string } };
    NodeAssert.strictEqual(archivedEvent.payload.archivedAt, "2026-01-01T00:00:00.000Z");
    NodeAssert.strictEqual(unarchived.type, "thread.unarchived");
  }),
);

effectIt("decodes thread handoff bootstrap events", () =>
  Effect.gen(function* () {
    const completed = yield* decodeOrchestrationEvent({
      sequence: 10,
      eventId: "event-handoff-completed",
      aggregateKind: "thread",
      aggregateId: "thread-target",
      type: "thread.handoff-bootstrap-completed",
      occurredAt: "2026-01-01T00:00:01.000Z",
      commandId: "server:handoff-bootstrap-complete:thread-target:msg-1",
      causationEventId: null,
      correlationId: "server:handoff-bootstrap-complete:thread-target:msg-1",
      metadata: {},
      payload: {
        threadId: "thread-target",
        bootstrapMessageId: "msg-1",
        providerTurnId: "turn-provider-1",
        completedAt: "2026-01-01T00:00:01.000Z",
      },
    });
    const skipped = yield* decodeOrchestrationEvent({
      sequence: 11,
      eventId: "event-handoff-skipped",
      aggregateKind: "thread",
      aggregateId: "thread-target",
      type: "thread.handoff-bootstrap-skipped",
      occurredAt: "2026-01-01T00:00:02.000Z",
      commandId: "cmd-handoff-skip",
      causationEventId: null,
      correlationId: "cmd-handoff-skip",
      metadata: {},
      payload: {
        threadId: "thread-target",
        reason: "No native message",
        skippedAt: "2026-01-01T00:00:02.000Z",
      },
    });

    NodeAssert.strictEqual(completed.type, "thread.handoff-bootstrap-completed");
    NodeAssert.strictEqual(skipped.type, "thread.handoff-bootstrap-skipped");
  }),
);

effectIt("accepts provider-scoped model options in thread.turn.start", () =>
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
    NodeAssert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    NodeAssert.strictEqual(
      getOptionValue(parsed.modelSelection?.options, "reasoningEffort"),
      "high",
    );
    NodeAssert.strictEqual(getOptionValue(parsed.modelSelection?.options, "fastMode"), true);
  }),
);

effectIt("normalizes legacy object-shaped modelSelection.options on decode", () =>
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

    NodeAssert.strictEqual(
      parsed.modelSelection.instanceId,
      ProviderInstanceId.make("claudeAgent"),
    );
    NodeAssert.deepStrictEqual(parsed.modelSelection.options, [
      { id: "effort", value: "max" },
      { id: "fastMode", value: true },
    ]);
  }),
);

effectIt("normalizes legacy object-shaped defaultModelSelection.options on decode", () =>
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

    NodeAssert.deepStrictEqual(parsed.defaultModelSelection?.options, [
      { id: "reasoningEffort", value: "low" },
    ]);
  }),
);

effectIt(
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
      NodeAssert.deepStrictEqual(encoded.modelSelection.options, [{ id: "fastMode", value: true }]);
    }),
);

effectIt("accepts a title seed in thread.turn.start", () =>
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
    NodeAssert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

effectIt("accepts a source proposed plan reference in thread.turn.start", () =>
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
    NodeAssert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

effectIt(
  "decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      NodeAssert.strictEqual(parsed.modelSelection, undefined);
      NodeAssert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
      NodeAssert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      NodeAssert.strictEqual(parsed.sourceProposedPlan, undefined);
    }),
);

effectIt("decodes thread.turn-start-requested source proposed plan metadata when present", () =>
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
    NodeAssert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

effectIt("decodes thread.turn-start-requested title seed when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    NodeAssert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

effectIt("decodes latest turn source proposed plan metadata when present", () =>
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
    NodeAssert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

effectIt("decodes orchestration session runtime mode defaults", () =>
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
    NodeAssert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
  }),
);

effectIt("defaults proposed plan implementation metadata for historical rows", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    NodeAssert.strictEqual(parsed.implementedAt, null);
    NodeAssert.strictEqual(parsed.implementationThreadId, null);
  }),
);

effectIt("preserves proposed plan implementation metadata when present", () =>
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
    NodeAssert.strictEqual(parsed.implementedAt, "2026-01-02T00:00:00.000Z");
    NodeAssert.strictEqual(parsed.implementationThreadId, "thread-2");
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

effectIt("ModelSelection migrates legacy `provider` field to `instanceId`", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      model: "gpt-5-codex",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    NodeAssert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex"));
    NodeAssert.strictEqual(parsed.model, "gpt-5-codex");
    NodeAssert.deepStrictEqual(parsed.options, [{ id: "reasoningEffort", value: "high" }]);
  }),
);

effectIt("ModelSelection accepts an explicit instanceId routing key", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    NodeAssert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

effectIt("ModelSelection prefers explicit instanceId over legacy provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    NodeAssert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

effectIt(
  "ModelSelection decodes unknown driver kinds via legacy provider (rollback / fork invariant)",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeModelSelection({
        provider: "ollama",
        model: "llama3:70b",
        options: [{ id: "temperature", value: "0.4" }],
      });
      NodeAssert.strictEqual(parsed.instanceId, ProviderInstanceId.make("ollama"));
      NodeAssert.strictEqual(parsed.model, "llama3:70b");
    }),
);

effectIt("ModelSelection encodes to the canonical instanceId wire form", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeModelSelection({
      provider: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
    const encoded = yield* encodeModelSelection(decoded);
    NodeAssert.deepStrictEqual(encoded, {
      instanceId: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
  }),
);

effectIt("ModelSelection rejects malformed instance ids", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeModelSelection({
        instanceId: "1invalid", // must start with a letter
        model: "x",
      }),
    );
    NodeAssert.strictEqual(result._tag, "Failure");
  }),
);
