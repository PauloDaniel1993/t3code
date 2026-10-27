import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  EventId,
  NodeId,
  RunAttemptId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  OrchestrationV2AppThreadJson,
  latestProviderTurnForAttempt,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointJson,
  OrchestrationV2CheckpointScope,
  OrchestrationV2CheckpointScopeJson,
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2RpcSchemas,
  OrchestrationV2RunJson,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadShell,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShellJson,
  OrchestrationV2SubagentJson,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  ProviderReplayTranscript,
} from "./orchestrationV2.ts";

const decodePublicCommand = Schema.decodeUnknownSync(
  OrchestrationV2RpcSchemas.dispatchCommand.input,
);
const now = DateTime.makeUnsafe("2026-04-20T00:00:00.000Z");

const LegacyShellStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("synchronized") }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationV2ShellSnapshot,
  }),
]);
const decodeLegacyShellStreamItem = Schema.decodeUnknownSync(LegacyShellStreamItem);
const decodeShellStreamItem = Schema.decodeUnknownSync(OrchestrationV2ShellStreamItem);
const decodeOrchestrationV2Command = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeOrchestrationV2Checkpoint = Schema.decodeUnknownSync(OrchestrationV2Checkpoint);
const decodeOrchestrationV2CheckpointScope = Schema.decodeUnknownSync(
  OrchestrationV2CheckpointScope,
);
const decodeOrchestrationV2DomainEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const decodeOrchestrationV2ThreadShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);
const decodeOrchestrationV2TurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const decodeProviderReplayTranscript = Schema.decodeUnknownSync(ProviderReplayTranscript);
const decodeOrchestrationV2TurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const encodeOrchestrationV2TurnItemJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeOrchestrationV2Subagent = Schema.decodeUnknownSync(OrchestrationV2Subagent);
const encodeOrchestrationV2SubagentJson = Schema.encodeSync(OrchestrationV2SubagentJson);
const decodeOrchestrationV2ProviderThreadJson = Schema.decodeUnknownSync(
  OrchestrationV2ProviderThreadJson,
);
const encodeOrchestrationV2ProviderThreadJson = Schema.encodeSync(
  OrchestrationV2ProviderThreadJson,
);
const decodeOrchestrationV2ProviderThread = Schema.decodeUnknownSync(OrchestrationV2ProviderThread);
const decodeOrchestrationV2ProviderCapabilities = Schema.decodeUnknownSync(
  OrchestrationV2ProviderCapabilities,
);

describe("orchestration V2 contracts", () => {
  it("decodes thread event types from a newer server as skippable items", () => {
    const decodeWireItems = Schema.decodeUnknownSync(
      Schema.toCodecJson(Schema.Array(OrchestrationV2RpcSchemas.subscribeThread.output)),
    );
    const detached = (id: string, sequence: number) => ({
      kind: "event",
      sequence,
      event: {
        id,
        type: "provider-session.detached",
        threadId: "thread-1",
        occurredAt: DateTime.formatIso(now),
        payload: { providerSessionId: "provider-session-1", detachedAt: DateTime.formatIso(now) },
      },
    });

    const items = decodeWireItems([
      detached("event-1", 1),
      {
        kind: "event",
        sequence: 2,
        event: {
          id: "event-2",
          type: "run.from-a-future-server",
          threadId: "thread-1",
          occurredAt: DateTime.formatIso(now),
          payload: { runId: "run-1" },
        },
      },
      detached("event-3", 3),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["event", "unknown-event", "event"]);
    expect(items[1]).toEqual({
      kind: "unknown-event",
      sequence: 2,
      eventType: "run.from-a-future-server",
    });
    expect(() =>
      decodeWireItems([
        { ...detached("event-4", 4), event: { ...detached("event-4", 4).event, payload: {} } },
      ]),
    ).toThrow();
  });

  it("skips turn item types from a newer server in snapshots and turn-item events", () => {
    const decodeWireItems = Schema.decodeUnknownSync(
      Schema.toCodecJson(Schema.Array(OrchestrationV2RpcSchemas.subscribeThread.output)),
    );
    const decodeHistoryPage = Schema.decodeUnknownSync(
      Schema.toCodecJson(OrchestrationV2ThreadHistoryPage),
    );
    const item = (id: string, type: string, extra: Record<string, unknown>) => ({
      id,
      type,
      threadId: "thread-1",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.formatIso(now),
      ...extra,
    });
    const known = item("item-known", "system_notice", { message: "Hello" });
    const future = item("item-future", "hologram", { beam: "ref-1" });
    const projected = (position: number, turnItem: { readonly id: string }) => ({
      position,
      visibility: "local",
      sourceThreadId: "thread-1",
      sourceItemId: turnItem.id,
      item: turnItem,
    });
    const projection = {
      thread: {
        createdBy: "user",
        creationSource: "web",
        id: "thread-1",
        projectId: "project-1",
        title: "Thread",
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
        forkedFrom: null,
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
        archivedAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [future, known],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [projected(0, future), projected(1, known)],
      updatedAt: DateTime.formatIso(now),
    };
    const turnItemEvent = (sequence: number, payload: unknown) => ({
      kind: "event",
      sequence,
      event: {
        id: `event-${sequence}`,
        type: "turn-item.updated",
        threadId: "thread-1",
        occurredAt: DateTime.formatIso(now),
        payload,
      },
    });

    const [snapshot, futureEvent, knownEvent] = decodeWireItems([
      { kind: "snapshot", snapshotSequence: 1, projection },
      turnItemEvent(2, future),
      turnItemEvent(3, known),
    ]);

    expect(snapshot).toMatchObject({ kind: "snapshot" });
    if (snapshot?.kind !== "snapshot") throw new Error("expected a snapshot");
    expect(snapshot.projection.turnItems.map((turnItem) => turnItem.id)).toEqual(["item-known"]);
    expect(snapshot.projection.visibleTurnItems.map((row) => row.item.id)).toEqual(["item-known"]);
    // The same snapshot with an ID table: refs resolve before unknown items are skipped.
    const tabled = (turnItem: { readonly id: string }, ref: number) => ({ ...turnItem, id: ref });
    const [tabledSnapshot] = decodeWireItems([
      {
        kind: "snapshot",
        snapshotSequence: 1,
        projection: {
          ...projection,
          turnItems: [tabled(future, 0), tabled(known, 1)],
          visibleTurnItems: [
            { ...projected(0, future), sourceItemId: 0, item: tabled(future, 0) },
            { ...projected(1, known), sourceItemId: 1, item: tabled(known, 1) },
          ],
        },
        ids: ["item-future", "item-known"],
      },
    ]);
    expect(tabledSnapshot).toEqual(snapshot);
    expect(futureEvent).toEqual({
      kind: "unknown-event",
      sequence: 2,
      eventType: "turn-item.updated",
    });
    expect(knownEvent).toMatchObject({
      kind: "event",
      event: { type: "turn-item.updated", payload: { id: "item-known", type: "system_notice" } },
    });
    expect(
      decodeHistoryPage({
        snapshotSequence: 1,
        items: [projected(0, future), projected(1, known)],
        nextCursor: null,
        hasMoreHistory: false,
      }).items.map((row) => row.item.id),
    ).toEqual(["item-known"]);

    const broken = item("item-broken", "system_notice", {});
    expect(() => decodeWireItems([turnItemEvent(4, broken)])).toThrow();
    expect(() =>
      decodeWireItems([
        {
          kind: "snapshot",
          snapshotSequence: 1,
          projection: { ...projection, turnItems: [broken] },
        },
      ]),
    ).toThrow();
  });

  it("decodes persisted capability snapshots that predate runtimePolicy", () => {
    const legacyCapabilities = {
      sessions: {
        supportsMultipleProviderThreadsPerSession: false,
        supportsModelSwitchInSession: false,
        supportsProviderSwitchingViaHandoff: true,
        supportsRuntimeModeSwitchInSession: false,
        pendingRequestsSurviveRestart: false,
      },
      threads: {
        canCreateEmptyThread: true,
        canReadThreadSnapshot: false,
        canRollbackThread: true,
        canForkThread: false,
        canForkFromTurn: false,
        canForkFromSubagentThread: false,
        exposesNativeThreadId: true,
      },
      turns: {
        exposesNativeTurnId: false,
        emitsTurnStarted: true,
        emitsTurnCompleted: true,
        supportsInterrupt: true,
        supportsActiveSteering: false,
        supportsSteeringByInterruptRestart: true,
        supportsQueuedMessages: true,
        terminalStatusQuality: "strong",
      },
      streaming: {
        streamsAssistantText: true,
        streamsReasoning: true,
        streamsToolOutput: true,
        streamsPlanText: false,
        emitsMessageCompleted: true,
      },
      tools: {
        exposesToolItemIds: true,
        emitsToolStarted: true,
        emitsToolCompleted: true,
        emitsToolOutput: true,
        supportsMcpTools: false,
        supportsDynamicToolCallbacks: false,
      },
      approvals: {
        supportsCommandApproval: true,
        supportsFileReadApproval: true,
        supportsFileChangeApproval: true,
        supportsApplyPatchApproval: false,
        approvalsHaveNativeRequestIds: false,
        approvalCallbacksAreLiveOnly: true,
        approvalsCanOriginateFromSubagents: false,
      },
      planning: {
        emitsPlanUpdated: true,
        emitsTodoList: true,
        emitsProposedPlan: false,
        supportsStructuredQuestions: true,
        planDeltasHaveItemIds: false,
      },
      subagents: {
        supportsSubagents: false,
        exposesSubagentThreadIds: false,
        emitsSubagentLifecycle: false,
        canWaitForSubagents: false,
        canCloseSubagents: false,
        canForkSubagentThread: false,
      },
      context: {
        acceptsSystemContext: false,
        acceptsDeveloperContext: false,
        acceptsSyntheticUserContext: true,
        canGenerateSummaries: true,
        canConsumeHandoffSummaries: true,
        supportsDeltaHandoff: true,
        supportsFullThreadHandoff: true,
        maxRecommendedHandoffChars: null,
      },
      checkpointing: {
        appCanCheckpointFilesystem: true,
        supportsNestedCheckpointScopes: true,
        providerCanRollbackConversation: true,
        providerRollbackReturnsSnapshot: true,
        providerCanReadConversationSnapshot: false,
      },
      identity: {
        nativeThreadIds: "strong",
        nativeTurnIds: "weak",
        nativeItemIds: "weak",
        nativeRequestIds: "weak",
      },
    };

    const decoded = decodeOrchestrationV2ProviderCapabilities(legacyCapabilities);
    expect(decoded.runtimePolicy).toEqual({ enforcement: "client-boundary" });

    const explicit = decodeOrchestrationV2ProviderCapabilities({
      ...legacyCapabilities,
      runtimePolicy: { enforcement: "native" },
    });
    expect(explicit.runtimePolicy).toEqual({ enforcement: "native" });

    // Absent folder access means unverified, and an access this build doesn't
    // know reads as absent rather than failing the session.
    expect(decoded.runtimePolicy).not.toHaveProperty("workspaceFolderAccess");
    for (const workspaceFolderAccess of ["supported", "unsupported", "unverified"] as const) {
      expect(
        decodeOrchestrationV2ProviderCapabilities({
          ...legacyCapabilities,
          runtimePolicy: { enforcement: "native", workspaceFolderAccess },
        }).runtimePolicy.workspaceFolderAccess,
      ).toBe(workspaceFolderAccess);
    }
    expect(
      decodeOrchestrationV2ProviderCapabilities({
        ...legacyCapabilities,
        runtimePolicy: { enforcement: "native", workspaceFolderAccess: "partial" },
      }).runtimePolicy,
    ).toEqual({ enforcement: "native" });
  });

  it("lets legacy snapshot decoders ignore enrichment metadata", () => {
    const decoded = decodeLegacyShellStreamItem({
      kind: "snapshot",
      snapshot: {
        schemaVersion: 1,
        snapshotSequence: 0,
        projects: [],
        threads: [],
        archivedThreads: [],
      },
      resolvedRepositoryIdentityRoots: ["/workspace/project"],
      enrichedProjectIds: ["project:workspace"],
    });

    expect(decoded.kind).toBe("snapshot");
    expect("resolvedRepositoryIdentityRoots" in decoded).toBe(false);
    expect("enrichedProjectIds" in decoded).toBe(false);
    const frame = decodeShellStreamItem({
      kind: "snapshot",
      snapshot: {
        schemaVersion: 1,
        snapshotSequence: 0,
        projects: [],
        threads: [],
        archivedThreads: [],
      },
      enrichedProjectIds: ["project:workspace"],
    });
    expect(frame.kind === "snapshot" && frame.enrichedProjectIds).toEqual(["project:workspace"]);
  });

  it("decodes nested checkpoint scopes without making child scopes advance app run count", () => {
    const rootScope = decodeOrchestrationV2CheckpointScope({
      id: "scope-root-1",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: "node-root-1",
      parentScopeId: null,
      providerThreadId: "provider-thread-1",
      kind: "root_run",
      ordinalWithinParent: 1,
      advancesAppRunCount: true,
      cwd: "/tmp/project",
      createdAt: now,
    });
    const childScope = decodeOrchestrationV2CheckpointScope({
      id: "scope-child-1",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: "node-child-1",
      parentScopeId: rootScope.id,
      providerThreadId: "provider-thread-child-1",
      kind: "subagent",
      ordinalWithinParent: 1,
      advancesAppRunCount: false,
      cwd: "/tmp/project",
      createdAt: now,
    });

    expect(rootScope.advancesAppRunCount).toBe(true);
    expect(childScope.parentScopeId).toBe(rootScope.id);
    expect(childScope.advancesAppRunCount).toBe(false);
  });

  it("decodes checkpoint captures that attach to scopes, nodes, and optional app run ordinals", () => {
    const checkpoint = decodeOrchestrationV2Checkpoint({
      id: "checkpoint-1",
      threadId: "thread-1",
      scopeId: "scope-child-1",
      runId: "run-1",
      nodeId: "node-child-1",
      parentCheckpointId: "checkpoint-root-1",
      ordinalWithinScope: 1,
      appRunOrdinal: null,
      ref: "git-ref-1",
      status: "ready",
      files: [{ path: "package.json", kind: "modified", additions: 2, deletions: 1 }],
      capturedAt: now,
    });

    expect(checkpoint.appRunOrdinal).toBeNull();
    expect(checkpoint.scopeId).toBe(CheckpointScopeId.make("scope-child-1"));
    expect(checkpoint.parentCheckpointId).toBe(CheckpointId.make("checkpoint-root-1"));
  });

  it("keeps checkpoint parts optional and stores each checkpoint's own part table", () => {
    const scopeJson = Schema.fromJsonString(OrchestrationV2CheckpointScopeJson);
    const checkpointJson = Schema.fromJsonString(OrchestrationV2CheckpointJson);
    const scope = {
      id: "scope-root-1",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: "node-root-1",
      parentScopeId: null,
      providerThreadId: "provider-thread-1",
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/srv/mono",
      createdAt: "2026-04-20T00:00:00.000Z",
    };
    const checkpoint = {
      id: "checkpoint-1",
      threadId: "thread-1",
      scopeId: "scope-root-1",
      runId: "run-1",
      nodeId: "node-root-1",
      parentCheckpointId: null,
      ordinalWithinScope: 1,
      appRunOrdinal: 1,
      ref: "refs/t3/orchestration-v2/checkpoints/a/ordinal/1",
      status: "error",
      files: [],
      capturedAt: "2026-04-20T00:00:00.000Z",
    };
    expect(Schema.decodeSync(scopeJson)(JSON.stringify(scope))).not.toHaveProperty("parts");
    expect(Schema.decodeSync(checkpointJson)(JSON.stringify(checkpoint))).not.toHaveProperty(
      "parts",
    );

    const primary = {
      key: "primary",
      cwd: "/srv/mono",
      vcs: "git",
      pathspecs: [":(literal)api", ":(exclude,literal)api/vendor"],
      folders: [{ folderPath: "/srv/mono/api", label: "api", relativePath: "api" }],
    } as const;
    const notes = {
      key: "0123456789abcdef",
      cwd: "/srv/notes",
      vcs: null,
      pathspecs: ["."],
      folders: [{ folderPath: "/srv/notes", label: "notes", relativePath: "" }],
    } as const;
    const withParts = Schema.decodeSync(checkpointJson)(
      JSON.stringify({
        ...checkpoint,
        parts: [
          { ...primary, ref: checkpoint.ref, status: "error" },
          { ...notes, ref: null, status: "missing" },
        ],
      }),
    );
    expect(withParts.parts?.map((part) => [part.key, part.ref, part.status])).toEqual([
      ["primary", checkpoint.ref, "error"],
      ["0123456789abcdef", null, "missing"],
    ]);
    expect(Schema.decodeSync(checkpointJson)(Schema.encodeSync(checkpointJson)(withParts))).toEqual(
      withParts,
    );
    expect(
      Schema.decodeSync(scopeJson)(JSON.stringify({ ...scope, parts: [primary, notes] })).parts,
    ).toEqual([primary, notes]);
  });

  it("decodes command and domain event shapes for command-to-projection tests", () => {
    const command = decodeOrchestrationV2Command({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: "command-1",
      threadId: "thread-1",
      messageId: "message-1",
      text: "hello",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    const event = decodeOrchestrationV2DomainEvent({
      id: "event-1",
      type: "run.created",
      threadId: "thread-1",
      runId: "run-1",
      occurredAt: now,
      payload: {
        id: "run-1",
        threadId: "thread-1",
        ordinal: 1,
        providerInstanceId: "codex",
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.4",
        },
        providerThreadId: "provider-thread-1",
        userMessageId: "message-1",
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });

    expect(command.commandId).toBe(CommandId.make("command-1"));
    expect(event.id).toBe(EventId.make("event-1"));
    if (event.type !== "run.created") {
      throw new Error(`Expected run.created, received ${event.type}.`);
    }
    expect(event.payload.id).toBe(RunId.make("run-1"));
  });

  it.each([
    { type: "root" },
    { type: "worktree", baseRef: "main", branch: "task/review", startFromOrigin: true },
  ])("decodes app-owned delegated tasks with $type workspaces", (workspaceStrategy) => {
    const command = decodeOrchestrationV2Command({
      type: "delegated_task.request",
      createdBy: "user",
      creationSource: "web",
      commandId: "command-delegate-1",
      parentThreadId: "thread-parent-1",
      parentRunId: "run-parent-1",
      parentNodeId: "node-parent-1",
      task: "Inspect the API boundary.",
      title: "API inspection",
      modelSelection: {
        instanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      workspaceStrategy,
    });

    expect(command.type).toBe("delegated_task.request");
    if (command.type !== "delegated_task.request") {
      throw new Error("expected delegated_task.request");
    }
    expect(command.parentThreadId).toBe(ThreadId.make("thread-parent-1"));
    expect(command.parentRunId).toBe(RunId.make("run-parent-1"));
    expect(command.parentNodeId).toBe(NodeId.make("node-parent-1"));
    expect(command.workspaceStrategy).toEqual(workspaceStrategy);
  });

  it.each([
    { type: "thread.stop", commandId: "stop-1", threadId: "thread-1", reason: "User stopped" },
    { type: "queued-run.start", commandId: "start-1", threadId: "thread-1", runId: "run-1" },
  ])("accepts public $type commands through the RPC schema", (command) => {
    expect(decodePublicCommand(command)).toEqual(command);
  });

  it("decodes delegated task wake-policy commands", () => {
    const command = decodeOrchestrationV2Command({
      type: "delegated_task.wake-policy",
      commandId: "command-delegate-wake-policy-1",
      parentThreadId: "thread-parent-1",
      taskId: "node-subagent-1",
      completionWake: "always",
    });

    expect(command.type).toBe("delegated_task.wake-policy");
    if (command.type !== "delegated_task.wake-policy") {
      throw new Error("expected delegated_task.wake-policy");
    }
    expect(command.parentThreadId).toBe(ThreadId.make("thread-parent-1"));
    expect(command.taskId).toBe(NodeId.make("node-subagent-1"));
    expect(command.completionWake).toBe("always");

    // The policy carries the whole decision, so it is required and closed.
    expect(() =>
      decodeOrchestrationV2Command({
        type: "delegated_task.wake-policy",
        commandId: "command-delegate-wake-policy-2",
        parentThreadId: "thread-parent-1",
        taskId: "node-subagent-1",
      }),
    ).toThrow();
    expect(() =>
      decodeOrchestrationV2Command({
        type: "delegated_task.wake-policy",
        commandId: "command-delegate-wake-policy-3",
        parentThreadId: "thread-parent-1",
        taskId: "node-subagent-1",
        completionWake: "sometimes",
      }),
    ).toThrow();
  });

  it("decodes durable created-thread timeline records", () => {
    const command = decodeOrchestrationV2Command({
      type: "thread.created.record",
      commandId: "command-thread-record-1",
      parentThreadId: "thread-parent-1",
      parentRunId: "run-parent-1",
      parentNodeId: "node-parent-1",
      targetThreadId: "thread-child-1",
      targetRunId: "run-child-1",
    });
    const item = decodeOrchestrationV2TurnItem({
      id: "turn-item-thread-created-1",
      type: "thread_created",
      threadId: "thread-parent-1",
      runId: "run-parent-1",
      nodeId: "node-parent-1",
      providerThreadId: "provider-thread-parent-1",
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 4,
      status: "completed",
      title: "Child thread",
      targetThreadId: "thread-child-1",
      targetRunId: "run-child-1",
      targetProviderInstanceId: "claude-default",
      targetModel: "claude-sonnet-4-6",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });

    expect(command.type).toBe("thread.created.record");
    if (command.type !== "thread.created.record") {
      throw new Error("expected thread.created.record");
    }
    expect(command.targetThreadId).toBe(ThreadId.make("thread-child-1"));
    expect(item.type).toBe("thread_created");
    if (item.type !== "thread_created") {
      throw new Error("expected thread_created");
    }
    expect(item.targetRunId).toBe(RunId.make("run-child-1"));
  });

  it("decodes provider-neutral replay transcripts", () => {
    const transcript = decodeProviderReplayTranscript({
      provider: "codex",
      protocol: "codex.app-server",
      version: "0.120.0",
      scenario: "simple",
      metadata: {
        source: "real-probe",
      },
      entries: [
        {
          type: "expect_outbound",
          label: "initialize",
          frame: { id: 1, method: "initialize" },
        },
        {
          type: "emit_inbound",
          label: "initialize-result",
          frame: { id: 1, result: { ok: true } },
        },
        {
          type: "runtime_exit",
          status: "success",
        },
      ],
    });

    expect(transcript.entries).toHaveLength(3);
    expect(transcript.protocol).toBe("codex.app-server");
  });

  it("decodes strictly typed turn items for known tools and dynamic fallback tools", () => {
    const fileChange = decodeOrchestrationV2TurnItem({
      id: "turn-item-file-change-1",
      type: "file_change",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: "node-file-change-1",
      providerThreadId: "provider-thread-1",
      providerTurnId: "provider-turn-1",
      nativeItemRef: { driver: "codex", nativeId: "item-file-change-1", strength: "strong" },
      parentItemId: null,
      ordinal: 3,
      status: "completed",
      title: "Edited package.json",
      fileName: "package.json",
      additions: 4,
      deletions: 2,
      diffStr: "@@ fixture diff",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    const dynamicTool = decodeOrchestrationV2TurnItem({
      id: "turn-item-dynamic-1",
      type: "dynamic_tool",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: "node-dynamic-1",
      providerThreadId: "provider-thread-1",
      providerTurnId: "provider-turn-1",
      nativeItemRef: { driver: "codex", nativeId: "item-dynamic-1", strength: "strong" },
      parentItemId: null,
      ordinal: 4,
      status: "completed",
      title: "Custom tool",
      toolName: "custom.lookup",
      input: { query: "fixture" },
      output: { ok: true },
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });

    expect(fileChange.type).toBe("file_change");
    if (fileChange.type !== "file_change") {
      throw new Error("expected file_change");
    }
    expect(fileChange.fileName).toBe("package.json");
    expect(fileChange.additions).toBe(4);
    expect(dynamicTool.id).toBe(TurnItemId.make("turn-item-dynamic-1"));
  });

  it("decodes bounded provider failures as expected error turn items", () => {
    const errorItem = decodeOrchestrationV2TurnItem({
      id: "turn-item-error-1",
      type: "error",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: "node-root-1",
      providerThreadId: "provider-thread-1",
      providerTurnId: "provider-turn-1",
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 199,
      status: "failed",
      title: "Provider error",
      failure: {
        class: "validation_error",
        message: "Invalid reasoning effort.",
        code: "invalid_request",
        retryable: false,
      },
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });

    expect(errorItem.type).toBe("error");
    if (errorItem.type !== "error") throw new Error("expected error item");
    expect(errorItem.failure.message).toBe("Invalid reasoning effort.");
    const usageLimited = decodeOrchestrationV2TurnItem({
      ...errorItem,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: { ...errorItem.failure, class: "usage_limit" },
    });
    expect(usageLimited.type === "error" && usageLimited.failure.class).toBe("usage_limit");
    expect(() =>
      decodeOrchestrationV2TurnItem({
        ...errorItem,
        failure: { ...errorItem.failure, message: "x".repeat(4_097) },
      }),
    ).toThrow();
  });

  it("decodes provider-native subagent lifecycle records and timeline items", () => {
    const subagent = decodeOrchestrationV2Subagent({
      id: "node-subagent-1",
      threadId: "thread-1",
      runId: "run-1",
      parentNodeId: "node-root-1",
      origin: "provider_native",
      createdBy: "agent",
      driver: "codex",
      providerInstanceId: "codex",
      providerThreadId: "provider-thread-subagent-1",
      childThreadId: null,
      nativeTaskRef: {
        driver: "codex",
        nativeId: "native-task-1",
        strength: "strong",
      },
      prompt: "Inspect package.json",
      title: "Package audit",
      model: "gpt-5.4",
      status: "completed",
      progress: "Inspecting package metadata",
      result: "Package is private.",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    const turnItem = decodeOrchestrationV2TurnItem({
      id: "turn-item-subagent-1",
      type: "subagent",
      threadId: "thread-1",
      runId: "run-1",
      nodeId: subagent.id,
      providerThreadId: subagent.providerThreadId,
      providerTurnId: "provider-turn-1",
      nativeItemRef: subagent.nativeTaskRef,
      parentItemId: null,
      ordinal: 2,
      status: "completed",
      title: subagent.title,
      subagentId: subagent.id,
      origin: subagent.origin,
      driver: subagent.driver,
      providerInstanceId: subagent.providerInstanceId,
      childThreadId: subagent.childThreadId,
      prompt: subagent.prompt,
      progress: subagent.progress,
      result: subagent.result,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });

    expect(subagent.origin).toBe("provider_native");
    expect(subagent.progress).toBe("Inspecting package metadata");
    expect(subagent.childThreadId).toBeNull();
    expect(turnItem.type).toBe("subagent");
    if (turnItem.type !== "subagent") throw new Error("expected subagent item");
    expect(turnItem.progress).toBe("Inspecting package metadata");
  });

  it.each(["  indented prompt\n", "\n \t\n"])(
    "preserves workflow prompt and result %j in stored and wire JSON",
    (preview) => {
      const subagent = {
        ...decodeOrchestrationV2Subagent({
          id: "workflow-coordinator",
          threadId: "thread-1",
          runId: "run-1",
          parentNodeId: "node-root-1",
          origin: "provider_native",
          createdBy: "agent",
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Run workflow",
          title: null,
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        }),
        workflow: {
          phases: [],
          agents: [
            {
              index: 1,
              label: "Member",
              state: "completed" as const,
              prompt: preview,
              result: preview,
            },
          ],
        },
      };
      const { workflow, ...coordinator } = subagent;
      const incoming = { ...encodeOrchestrationV2SubagentJson(coordinator), workflow };
      for (const codec of [
        OrchestrationV2SubagentJson,
        Schema.toCodecJson(OrchestrationV2Subagent),
      ]) {
        const encode = Schema.encodeSync(codec);
        const decode = Schema.decodeUnknownSync(codec);
        const json: unknown = JSON.parse(JSON.stringify(encode(subagent)));
        expect(json).toMatchObject({
          workflow: { agents: [{ prompt: preview, result: preview }] },
        });
        expect(decode(json).workflow?.agents[0]).toMatchObject({
          prompt: preview,
          result: preview,
        });
        expect(decode(incoming).workflow?.agents[0]).toMatchObject({
          prompt: preview,
          result: preview,
        });
      }
    },
  );

  it("decodes historical provider-thread JSON without pendingBackgroundTasks as empty roster", () => {
    const providerThread = decodeOrchestrationV2ProviderThreadJson({
      id: "provider-thread-1",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: "provider-session-1",
      appThreadId: "thread-1",
      ownerNodeId: null,
      nativeThreadRef: {
        driver: "claude",
        nativeId: "native-session-1",
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    });

    expect(providerThread.pendingBackgroundTasks).toEqual([]);
    expect(providerThread.contextUsage).toBeNull();
    expect(providerThread.nativeMetadata).toBeNull();

    const runtimeThread = decodeOrchestrationV2ProviderThread({
      id: "provider-thread-2",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: null,
      appThreadId: "thread-2",
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(runtimeThread.pendingBackgroundTasks).toEqual([]);
    expect(runtimeThread.contextUsage).toBeNull();
    expect(runtimeThread.nativeMetadata).toBeNull();
  });

  it("decodes historical thread shell JSON without pendingBackgroundTasks as empty roster", () => {
    const shell = decodeOrchestrationV2ThreadShell({
      createdBy: "user",
      creationSource: "web",
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      providerInstanceId: "claudeAgent",
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: "thread-1",
      },
      forkedFrom: null,
      activeProviderThreadId: "provider-thread-1",
      latestRunId: "run-1",
      activeRunId: null,
      status: "completed",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    });

    expect(shell.pendingBackgroundTasks).toEqual([]);
    expect(shell.legacyImportedAt).toBeUndefined();
    const imported = decodeOrchestrationV2ThreadShell({
      ...shell,
      historyOrigin: "v1_import",
      latestTaskDeliveredAt: "2026-04-19T00:00:00.000Z",
      legacyImportedAt: "2026-04-20T00:00:00.000Z",
    });
    expect(imported.latestTaskDeliveredAt).toBe("2026-04-19T00:00:00.000Z");
    expect(imported.legacyImportedAt).toBe("2026-04-20T00:00:00.000Z");
    expect(shell).not.toHaveProperty("workspaceFolderCount");
    expect(shell).not.toHaveProperty("worktrees");
  });

  it("keeps a thread's folder snapshot and worktree set optional on the wire", () => {
    const decodeThread = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);
    const encodeThread = Schema.encodeSync(OrchestrationV2AppThreadJson);
    const legacy = {
      createdBy: "user",
      creationSource: "web",
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
      forkedFrom: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
    };
    const plain = decodeThread(legacy);
    expect(plain).not.toHaveProperty("workspaceFolders");
    expect(plain).not.toHaveProperty("worktrees");

    const binding = {
      branch: "t3code/feature",
      worktreePath: "/wt/feature/repo/web",
      workspaceFolders: [
        { path: "/repo/web", name: "web", label: "web", checkoutRoot: "/repo" },
        { uri: "vscode-remote://ssh-remote+box/srv", name: "srv", label: "srv" },
      ],
      worktrees: [{ repositoryRoot: "/repo", path: "/wt/feature/repo", branch: "t3code/feature" }],
    };
    const bound = decodeThread(encodeThread(decodeThread({ ...legacy, ...binding })));
    expect(bound.workspaceFolders).toEqual(binding.workspaceFolders);
    expect(bound.worktrees).toEqual(binding.worktrees);

    const decodeRun = Schema.decodeUnknownSync(OrchestrationV2RunJson);
    const run = {
      id: "run-1",
      threadId: "thread-1",
      ordinal: 1,
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
      providerThreadId: null,
      userMessageId: "message-1",
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      requestedAt: "2026-04-20T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    expect(decodeRun(run)).not.toHaveProperty("unavailableFolderPaths");
    expect(
      decodeRun({ ...run, unavailableFolderPaths: ["/srv/notes"] }).unavailableFolderPaths,
    ).toEqual(["/srv/notes"]);

    // Clearing a set is an explicit null, distinct from leaving it unchanged.
    const cleared = decodeOrchestrationV2Command({
      type: "thread.metadata.update",
      commandId: "command-1",
      threadId: "thread-1",
      worktrees: null,
    });
    expect(cleared).toHaveProperty("worktrees", null);
  });
});

it("preserves tool cancellation and denial metadata through persisted and wire schemas", () => {
  for (const kind of ["cancelled", "denied", undefined]) {
    const item = decodeOrchestrationV2TurnItem({
      id: "tool-result",
      threadId: "thread",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "dynamic_tool",
      toolName: "task_status",
      input: { taskId: "child" },
      status: kind === "cancelled" ? "cancelled" : "failed",
      ...(kind === undefined ? {} : { toolNonExecutionKind: kind }),
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      output: "Tool did not execute",
    });
    const wire = encodeOrchestrationV2TurnItemJson(item);
    expect(wire.toolNonExecutionKind).toBe(kind);
    expect(decodeOrchestrationV2TurnItemJson(wire)).toEqual(item);
  }
});

it("round-trips typed notifications and keeps work outcome separate from item status", () => {
  const now = DateTime.makeUnsafe("2026-09-09T00:00:00Z");
  const base = {
    id: "notification",
    threadId: "parent",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    type: "notification",
    outcome: "failed",
    summary: "Build failed",
    detail: "Exit code 1",
  };
  for (const source of [
    { kind: "delegated_task", taskIds: ["task-1", "task-2"] },
    { kind: "delegated_task", taskIds: ["task-1"], childThreadId: "child" },
    { kind: "subagent", childThreadId: "child" },
    { kind: "subagent" },
    { kind: "command" },
    { kind: "monitor" },
    { kind: "background_task" },
  ]) {
    const runtime = decodeOrchestrationV2TurnItem({ ...base, source, updatedAt: now });
    const wire = encodeOrchestrationV2TurnItemJson(runtime);
    expect(decodeOrchestrationV2TurnItemJson(wire)).toEqual(runtime);
    expect(runtime).toMatchObject({ status: "completed", outcome: "failed", source });
    expect(runtime).not.toHaveProperty("messageId");
    expect(() =>
      decodeOrchestrationV2TurnItem({ ...base, source, summary: "", updatedAt: now }),
    ).toThrow();
  }
  // A known kind with fields that do not decode is a real defect, not a newer kind.
  expect(() =>
    decodeOrchestrationV2TurnItem({ ...base, source: { kind: "delegated_task" }, updatedAt: now }),
  ).toThrow();
  expect(() =>
    decodeOrchestrationV2TurnItem({
      ...base,
      source: { kind: "subagent", childThreadId: 7 },
      updatedAt: now,
    }),
  ).toThrow();
});

describe("thread open stats", () => {
  it("reads a thread whose open stats this build cannot read, without them", () => {
    const shell = {
      id: "thread-test",
      projectId: "project-test",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: "thread-test", parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "mobile",
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    };
    const decode = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);
    const opens = { openedAt: 1, score: 1, picks: [{ query: "upl", at: 1 }] };
    expect(decode({ ...shell, opens }).opens).toEqual(opens);
    expect(decode({ ...shell, opens: { openedAt: "2026-10-01", score: 1 } }).opens).toBeNull();
  });
});

describe("background work kinds from older or newer servers", () => {
  const storedNotification = (source: unknown) => ({
    id: "notification",
    threadId: "parent",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-09-09T00:00:00.000Z",
    type: "notification",
    outcome: "completed",
    summary: "Background activity updated",
    source,
  });

  it("decodes notification sources stored before specific kinds existed", () => {
    const sourceOf = (source: unknown) => {
      const item = decodeOrchestrationV2TurnItemJson(storedNotification(source));
      return item.type === "notification" ? item.source : undefined;
    };
    expect(
      sourceOf({ kind: "background_task", nativeRef: { driver: "claude", nativeId: "task-1" } }),
    ).toEqual({ kind: "background_task" });
    expect(sourceOf({ kind: "background_command" })).toEqual({ kind: "command" });
    expect(sourceOf({ kind: "monitor" })).toEqual({ kind: "monitor" });
  });

  it("sends and stores sources that clients from before specific kinds still decode", () => {
    const PreSpecificKindsNotification = Schema.Struct({
      type: Schema.Literal("notification"),
      source: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("delegated_task"), taskIds: Schema.Array(NodeId) }),
        Schema.Struct({
          kind: Schema.Literals(["background_task", "background_command", "monitor"]),
          nativeRef: Schema.optional(Schema.Unknown),
        }),
      ]),
      outcome: Schema.Literals(["completed", "failed", "cancelled", "updated", "unknown"]),
      summary: Schema.String,
      detail: Schema.optional(Schema.String),
    });
    const decodePreSpecificKinds = Schema.decodeUnknownSync(PreSpecificKindsNotification);
    const sendOverWire = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2TurnItem));
    const cases = [
      [{ kind: "subagent", childThreadId: "child" }, { kind: "background_task" }],
      [{ kind: "subagent" }, { kind: "background_task" }],
      [{ kind: "command" }, { kind: "background_command" }],
      [{ kind: "monitor" }, { kind: "monitor" }],
      [{ kind: "background_task" }, { kind: "background_task" }],
      [
        { kind: "delegated_task", taskIds: ["task-1"], childThreadId: "child" },
        { kind: "delegated_task", taskIds: ["task-1"] },
      ],
    ] as const;
    for (const [source, preSpecificKindsSource] of cases) {
      const item = decodeOrchestrationV2TurnItemJson(storedNotification(source));
      for (const encoded of [encodeOrchestrationV2TurnItemJson(item), sendOverWire(item)]) {
        expect(decodePreSpecificKinds(encoded).source).toEqual(preSpecificKindsSource);
        expect(decodeOrchestrationV2TurnItemJson(encoded)).toEqual(item);
      }
      expect(item).toMatchObject({ source });
    }
  });

  it("decodes a notification source kind from a newer server as generic background work", () => {
    const item = decodeOrchestrationV2TurnItemJson(
      storedNotification({ kind: "workflow", workflowId: "wf-1" }),
    );
    expect(item).toMatchObject({ type: "notification", source: { kind: "background_task" } });
  });

  it("decodes rosters stored before kinds existed, and kinds from a newer server, as generic tasks", () => {
    const providerThread = decodeOrchestrationV2ProviderThreadJson({
      id: "provider-thread-1",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: null,
      appThreadId: "thread-1",
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      pendingBackgroundTasks: [
        { taskId: "bg-1", description: "Background sleep", taskType: "local_bash" },
        { taskId: "bg-2" },
        { taskId: "bg-3", description: "Nightly", kind: "workflow", schedule: "0 3 * * *" },
        { taskId: "bg-4", description: "npm test", kind: "command" },
        { taskId: "bg-5", kind: "subagent", childThreadId: "thread-child" },
        { taskId: "bg-6", kind: "subagent", providerInstanceId: "claudeAgent" },
      ],
    });
    expect(providerThread.pendingBackgroundTasks).toEqual([
      { taskId: "bg-1", description: "Background sleep", kind: "background_task" },
      { taskId: "bg-2", kind: "background_task" },
      { taskId: "bg-3", description: "Nightly", kind: "background_task" },
      { taskId: "bg-4", description: "npm test", kind: "command" },
      { taskId: "bg-5", kind: "subagent", childThreadId: "thread-child" },
      { taskId: "bg-6", kind: "subagent", providerInstanceId: "claudeAgent" },
    ]);
    const encoded = encodeOrchestrationV2ProviderThreadJson(providerThread).pendingBackgroundTasks;
    expect(encoded).toEqual(providerThread.pendingBackgroundTasks);
    const decodePreKindsRoster = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          taskId: TrimmedNonEmptyString,
          description: Schema.optional(TrimmedNonEmptyString),
          taskType: Schema.optional(TrimmedNonEmptyString),
        }),
      ),
    );
    expect(decodePreKindsRoster(encoded).map((task) => task.taskId)).toEqual([
      "bg-1",
      "bg-2",
      "bg-3",
      "bg-4",
      "bg-5",
      "bg-6",
    ]);
    expect(() =>
      decodeOrchestrationV2ProviderThreadJson({
        ...encodeOrchestrationV2ProviderThreadJson(providerThread),
        pendingBackgroundTasks: [{ taskId: "", kind: "command" }],
      }),
    ).toThrow();
  });
});

describe("latestProviderTurnForAttempt", () => {
  it("returns the attempt's highest-ordinal turn, as a Codex goal run spans several", () => {
    const turns = [
      { id: "first", runAttemptId: RunAttemptId.make("goal-attempt"), ordinal: 3 },
      { id: "other", runAttemptId: RunAttemptId.make("other-attempt"), ordinal: 9 },
      { id: "last", runAttemptId: RunAttemptId.make("goal-attempt"), ordinal: 5 },
      { id: "subagent", runAttemptId: null, ordinal: 7 },
    ];
    expect(latestProviderTurnForAttempt(turns, RunAttemptId.make("goal-attempt"))?.id).toBe("last");
    expect(latestProviderTurnForAttempt(turns, null)).toBeUndefined();
  });
});
