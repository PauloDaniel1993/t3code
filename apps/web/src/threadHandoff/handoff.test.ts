import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../providerInstances";
import {
  buildHandoffDraftCopy,
  buildHandoffTargetOptions,
  countImportableHandoffMessages,
  getHandoffSourceDisabledReason,
  resolveInitialHandoffTarget,
} from "./handoff";

const message = (input: Partial<OrchestrationMessage> = {}): OrchestrationMessage => ({
  id: MessageId.make("message-1"),
  role: "user",
  text: "hello",
  attachments: [],
  turnId: null,
  streaming: false,
  source: "user",
  createdAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:00:00.000Z",
  ...input,
});

function entry(input: {
  readonly instanceId: string;
  readonly status?: "ready" | "warning" | "error" | "disabled";
  readonly enabled?: boolean;
  readonly models?: ReadonlyArray<{ slug: string; name: string }>;
}): ProviderInstanceEntry {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const driverKind = ProviderDriverKind.make(input.instanceId);
  const models = (input.models ?? [{ slug: `${input.instanceId}-model`, name: "Model" }]).map(
    (model) => ({
      ...model,
      isCustom: false,
      capabilities: null,
    }),
  );
  return {
    instanceId,
    driverKind,
    displayName: input.instanceId,
    enabled: input.enabled ?? true,
    installed: true,
    status: input.status ?? "ready",
    isDefault: true,
    isAvailable: true,
    snapshot: {
      instanceId,
      driver: driverKind,
      enabled: input.enabled ?? true,
      installed: true,
      version: null,
      status: input.status ?? "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-06-06T00:00:00.000Z",
      models,
      slashCommands: [],
      skills: [],
    },
    models,
  };
}

describe("thread handoff helpers", () => {
  it("counts completed text and attachment messages only", () => {
    expect(
      countImportableHandoffMessages([
        message(),
        message({ text: "   " }),
        message({
          text: "",
          attachments: [
            {
              type: "image",
              id: "a1",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        }),
        message({ streaming: true }),
      ]),
    ).toBe(2);
  });

  it("disables source handoff for draft, running, waiting, and empty threads", () => {
    expect(
      getHandoffSourceDisabledReason({
        isServerThread: false,
        thread: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
      }),
    ).toContain("server threads");
    expect(
      getHandoffSourceDisabledReason({
        isServerThread: true,
        thread: {
          id: ThreadId.make("thread-1"),
          archivedAt: null,
          deletedAt: null,
          messages: [message()],
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: null,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-06-06T00:00:00.000Z",
          },
          latestTurn: null,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
      }),
    ).toContain("current turn");
    expect(
      getHandoffSourceDisabledReason({
        isServerThread: true,
        thread: {
          id: "thread-1",
          archivedAt: null,
          deletedAt: null,
          messages: [],
          session: null,
          latestTurn: null,
        },
        hasPendingApproval: false,
        hasPendingUserInput: true,
      }),
    ).toContain("pending provider prompt");
  });

  it("selects the preferred ready target and disables the current instance", () => {
    const options = buildHandoffTargetOptions({
      entries: [
        entry({ instanceId: "codex" }),
        entry({ instanceId: "deepseek", models: [{ slug: "deepseek-v4-pro", name: "DeepSeek" }] }),
        entry({ instanceId: "grok", status: "error" }),
      ],
      sourceInstanceId: ProviderInstanceId.make("codex"),
      modelOptionsByInstance: new Map([
        [ProviderInstanceId.make("deepseek"), [{ slug: "deepseek-v4-pro" }]],
      ]),
      stickyModelSelectionByProvider: {
        [ProviderInstanceId.make("deepseek")]: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-pro",
        },
      },
    });

    expect(options.find((option) => option.entry.instanceId === "codex")?.disabledReason).toContain(
      "Already using",
    );
    expect(resolveInitialHandoffTarget(options, ProviderInstanceId.make("deepseek"))).toMatchObject(
      {
        modelSelection: {
          instanceId: "deepseek",
          model: "deepseek-v4-pro",
        },
      },
    );
  });

  it("copies only non-empty unsent prompt text", () => {
    expect(buildHandoffDraftCopy({ prompt: "continue this  " })).toEqual({
      prompt: "continue this",
    });
    expect(buildHandoffDraftCopy({ prompt: "   " })).toBeNull();
  });
});
