import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  MessageId,
  NodeId,
  OrchestratorMcpDelegateTaskInput,
  ProviderInstanceId,
  ProviderDriverKind,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  RuntimeRequestId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { makeThreadProjectionFixture } from "../test-fixtures";
import {
  buildDelegationTurnInput,
  deriveTaskTitle,
  getNewThreadTaskUnavailableReason,
  getNewThreadTaskModeNotice,
  TASK_PROMPT_MAX_LENGTH,
  TASK_TITLE_MAX_LENGTH,
  validateNewThreadTaskDraft,
  validateNewThreadTaskRequest,
} from "./NewThreadTaskDialog.logic";

const childModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex_secondary"),
  model: "gpt-6.1-sol",
  options: [
    { id: "reasoningEffort", value: "xhigh" },
    { id: "fastMode", value: true },
  ],
};

function buildInput(model = childModel) {
  const projection = makeThreadProjectionFixture();
  return buildDelegationTurnInput({
    thread: { ...projection.thread, runtimeMode: "approval-required", interactionMode: "plan" },
    draft: {
      title: 'Review "Windows" paths',
      prompt: "  Check C:\\repo\\src.\nReport failures.  ",
    },
    childModelSelection: model,
    commandId: CommandId.make("delegate-request"),
    messageId: MessageId.make("delegate-message"),
    createdAt: "2026-09-29T12:00:00.000Z",
  });
}

const decodeDelegationArguments = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);

function readDelegationArguments(text: string) {
  return decodeDelegationArguments(JSON.parse(text.split("```json\n")[1]!.split("\n```")[0]!));
}

describe("delegation request turn", () => {
  it("sends the selected instance, model and all traits in valid V2 delegation arguments", () => {
    expect(readDelegationArguments(buildInput().message.text)).toMatchObject({
      task: "Check C:\\repo\\src.\nReport failures.",
      title: 'Review "Windows" paths',
      target: {
        providerInstanceId: "codex_secondary",
        model: "gpt-6.1-sol",
        options: childModel.options,
      },
      mode: "async",
      runtimeMode: "inherit",
      interactionMode: "inherit",
      clientRequestId: "delegate-request",
    });
  });

  it("queues on the parent without changing its provider or permissions", () => {
    const input = buildInput();
    expect(input.threadId).toBe(makeThreadProjectionFixture().thread.id);
    expect(input.dispatchMode).toBe("queue");
    expect(input.runtimeMode).toBe("approval-required");
    expect(input.interactionMode).toBe("plan");
    expect(input.modelSelection).toBeUndefined();
    expect(input.bootstrap).toBeUndefined();
    expect(input.message.attachments).toEqual([]);
    expect(input.message.text).toContain("Do not append this thread's conversation history");
    expect(input.message.text).toContain("Do not silently substitute");
    expect(input.message.text).toContain("single delegate_task tool call");
    expect(input.message.text).not.toContain("orchestrator_capabilities");
  });

  it("clears inherited child traits when a different model has no overrides", () => {
    expect(
      readDelegationArguments(
        buildInput({ instanceId: childModel.instanceId, model: "other-model" }).message.text,
      ).target?.options,
    ).toEqual([]);
  });

  it("keeps all options when delegating to the parent's exact model", () => {
    const parent = makeThreadProjectionFixture().thread.modelSelection;
    const options = [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ];
    expect(
      readDelegationArguments(buildInput({ ...parent, options }).message.text).target?.options,
    ).toEqual(options);
  });
});

describe("task draft bounds", () => {
  it("fits the largest allowed draft even when every character needs JSON escaping", () => {
    const input = buildDelegationTurnInput({
      thread: makeThreadProjectionFixture().thread,
      draft: {
        title: "\u0001".repeat(TASK_TITLE_MAX_LENGTH),
        prompt: "\u0001".repeat(TASK_PROMPT_MAX_LENGTH),
      },
      childModelSelection: childModel,
      commandId: CommandId.make("00000000-0000-0000-0000-000000000000"),
      messageId: MessageId.make("message"),
      createdAt: "2026-09-29T12:00:00.000Z",
    });
    expect(input.message.text.length).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(
      JSON.parse(input.message.text.split("```json\n")[1]!.split("\n```")[0]!).task,
    ).toHaveLength(TASK_PROMPT_MAX_LENGTH);
  });

  it("checks the built message, including model options, against the composer limit", () => {
    const draft = { title: "", prompt: "Review this" };
    const model = {
      ...childModel,
      options: [{ id: "context", value: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS) }],
    };
    expect(validateNewThreadTaskRequest(draft, model)).toContain("120,000-character limit");
    expect(() =>
      buildDelegationTurnInput({
        thread: makeThreadProjectionFixture().thread,
        draft,
        childModelSelection: model,
        commandId: CommandId.make("request"),
        messageId: MessageId.make("message"),
        createdAt: "2026-09-29T12:00:00.000Z",
      }),
    ).toThrow("120,000-character limit");
  });

  it("explains the copying cost and rejects an oversized prefilled draft without truncation", () => {
    const prompt = "x".repeat(TASK_PROMPT_MAX_LENGTH + 1);
    expect(validateNewThreadTaskDraft({ title: "", prompt })).toContain("parent must repeat");
    expect(() =>
      buildDelegationTurnInput({
        thread: makeThreadProjectionFixture().thread,
        draft: { title: "", prompt },
        childModelSelection: childModel,
        commandId: CommandId.make("request"),
        messageId: MessageId.make("message"),
        createdAt: "2026-09-29T12:00:00.000Z",
      }),
    ).toThrow("12,000 characters");
  });

  it("rejects empty prompts and oversized arguments instead of truncating work", () => {
    expect(validateNewThreadTaskDraft({ title: "", prompt: " \n " })).not.toBeNull();
    expect(
      validateNewThreadTaskDraft({ title: "", prompt: "x".repeat(TASK_PROMPT_MAX_LENGTH + 1) }),
    ).not.toBeNull();
    expect(
      validateNewThreadTaskDraft({ title: "x".repeat(TASK_TITLE_MAX_LENGTH + 1), prompt: "Work" }),
    ).not.toBeNull();
    expect(
      validateNewThreadTaskDraft({
        title: "x".repeat(TASK_TITLE_MAX_LENGTH),
        prompt: "x".repeat(TASK_PROMPT_MAX_LENGTH),
      }),
    ).toBeNull();
  });

  it("derives a concise first-line title and honors explicit titles", () => {
    expect(deriveTaskTitle({ title: "", prompt: "  Check paths\nThen tests" })).toBe("Check paths");
    expect(deriveTaskTitle({ title: "", prompt: "x".repeat(100) })).toHaveLength(80);
    expect(deriveTaskTitle({ title: "  Custom title  ", prompt: "Check paths" })).toBe(
      "Custom title",
    );
  });
});

describe("inherited modes", () => {
  it("explains that plan parents may refuse and cannot create an implementing child", () => {
    const notice = getNewThreadTaskModeNotice(
      { runtimeMode: "full-access", interactionMode: "plan" },
      ProviderDriverKind.make("codex"),
    );
    expect(notice).toContain("may refuse delegation");
    expect(notice).toContain("only plans");
  });

  it("explains required approval and Claude read-only denial without escalating permissions", () => {
    const notice = getNewThreadTaskModeNotice(
      { runtimeMode: "approval-required", interactionMode: "default" },
      ProviderDriverKind.make("claudeAgent"),
    );
    expect(notice).toContain("parent will ask for approval");
    expect(notice).toContain("denied if approvals are disabled");
    expect(
      getNewThreadTaskModeNotice(
        { runtimeMode: "full-access", interactionMode: "default" },
        ProviderDriverKind.make("codex"),
      ),
    ).toBeNull();
  });
});

function availability(
  overrides: {
    projection?: OrchestrationV2ThreadProjection | null;
    status?: "cached" | "live";
    connected?: boolean;
    providers?: Parameters<typeof getNewThreadTaskUnavailableReason>[0]["providers"];
  } = {},
) {
  return getNewThreadTaskUnavailableReason({
    projection: makeThreadProjectionFixture(),
    status: "live",
    connected: true,
    providers: [{ instanceId: ProviderInstanceId.make("codex"), enabled: true, status: "ready" }],
    ...overrides,
  });
}

describe("shared entry point guards", () => {
  it("allows a live idle parent and requires its exact provider instance", () => {
    expect(availability()).toBeNull();
    expect(
      availability({
        providers: [
          {
            instanceId: ProviderInstanceId.make("codex_secondary"),
            enabled: true,
            status: "ready",
          },
        ],
      }),
    ).not.toBeNull();
  });

  it("blocks offline, unsynchronized and draft threads", () => {
    expect(availability({ connected: false })).not.toBeNull();
    expect(availability({ status: "cached" })).not.toBeNull();
    expect(availability({ projection: null })).not.toBeNull();
  });

  it("blocks archived and deleted threads", () => {
    const projection = makeThreadProjectionFixture();
    const now = DateTime.makeUnsafe("2026-09-29T12:00:00.000Z");
    expect(
      availability({
        projection: { ...projection, thread: { ...projection.thread, archivedAt: now } },
      }),
    ).not.toBeNull();
    expect(
      availability({
        projection: { ...projection, thread: { ...projection.thread, deletedAt: now } },
      }),
    ).not.toBeNull();
  });

  it("allows app-owned nested delegation and blocks provider-native children", () => {
    const projection = makeThreadProjectionFixture();
    const thread = {
      ...projection.thread,
      lineage: {
        ...projection.thread.lineage,
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
      },
    };
    expect(
      availability({ projection: { ...projection, thread: { ...thread, creationSource: "mcp" } } }),
    ).toBeNull();
    expect(
      availability({
        projection: { ...projection, thread: { ...thread, creationSource: "provider" } },
      }),
    ).not.toBeNull();
  });

  it("requires pending input to be resolved before requesting delegation", () => {
    const projection = makeThreadProjectionFixture();
    const request = {
      id: RuntimeRequestId.make("request"),
      nodeId: NodeId.make("node"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability: { type: "message" as const },
      createdAt: projection.thread.createdAt,
      resolvedAt: null,
    };
    expect(
      availability({ projection: { ...projection, runtimeRequests: [request] } }),
    ).not.toBeNull();
    expect(
      availability({
        projection: { ...projection, runtimeRequests: [{ ...request, status: "resolved" }] },
      }),
    ).toBeNull();
  });

  it("blocks disabled, unavailable and failed parent providers", () => {
    const provider = {
      instanceId: ProviderInstanceId.make("codex"),
      enabled: true,
      status: "ready" as const,
    };
    expect(availability({ providers: [{ ...provider, enabled: false }] })).not.toBeNull();
    expect(
      availability({ providers: [{ ...provider, availability: "unavailable" }] }),
    ).not.toBeNull();
    expect(availability({ providers: [{ ...provider, status: "error" }] })).not.toBeNull();
  });
});
