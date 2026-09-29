import { describe, expect, it, vi } from "vite-plus/test";
import { CommandId, MessageId, OrchestrationV2DispatchCommandError } from "@t3tools/contracts";
import { makeThreadProjectionFixture } from "../test-fixtures";
import {
  prepareNewThreadTaskRequest,
  retainNewThreadTaskRequestForRetry,
} from "./NewThreadTaskHost.logic";

function scenario() {
  let ordinal = 0;
  const createIdentity = vi.fn(() => ({
    commandId: CommandId.make(`command-${++ordinal}`),
    messageId: MessageId.make(`message-${ordinal}`),
    createdAt: `2026-09-29T12:00:0${ordinal}.000Z`,
  }));
  const thread = makeThreadProjectionFixture().thread;
  const input = {
    thread,
    draft: { title: "Review", prompt: "Review the paths" },
    childModelSelection: thread.modelSelection,
  };
  const request = prepareNewThreadTaskRequest(null, input, createIdentity);
  return { input, request, createIdentity };
}

describe("delegation retry identity", () => {
  it("reuses the command, message, timestamp and child request id after an interruption", () => {
    const { input, request, createIdentity } = scenario();
    const retry = prepareNewThreadTaskRequest(request, input, createIdentity);
    expect(retry.input).toBe(request.input);
    expect(createIdentity).toHaveBeenCalledTimes(1);
    expect(retry.input.message.text).toContain('"clientRequestId": "command-1"');
  });

  it("retains an uncertain transport failure so a retry cannot create another child", () => {
    const { input, request, createIdentity } = scenario();
    const retained = retainNewThreadTaskRequestForRetry(
      request,
      new Error("Connection lost before acknowledgement"),
    );
    expect(prepareNewThreadTaskRequest(retained, input, createIdentity).input).toBe(request.input);
    expect(createIdentity).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh command after a server rejection with a durable receipt", () => {
    const { input, request, createIdentity } = scenario();
    const error = new OrchestrationV2DispatchCommandError({
      commandId: request.input.commandId!,
      commandType: "message.dispatch",
      message: "Provider unavailable",
    });
    const retained = retainNewThreadTaskRequestForRetry(request, error);
    expect(retained).toBeNull();
    const retry = prepareNewThreadTaskRequest(retained, input, createIdentity);
    expect(retry.input.commandId).toBe("command-2");
    expect(retry.input.message.messageId).toBe("message-2");
    expect(retry.input.message.text).toContain('"clientRequestId": "command-2"');
  });

  it.each(["title", "prompt"] as const)("starts a fresh command after editing %s", (field) => {
    const { input, request, createIdentity } = scenario();
    const retry = prepareNewThreadTaskRequest(
      request,
      { ...input, draft: { ...input.draft, [field]: "Changed work" } },
      createIdentity,
    );
    expect(retry.input.commandId).toBe("command-2");
    expect(retry.input.message.text).toContain("Changed work");
  });

  it("starts a fresh command after changing the child model or reasoning", () => {
    const { input, request, createIdentity } = scenario();
    const retry = prepareNewThreadTaskRequest(
      request,
      {
        ...input,
        childModelSelection: {
          ...input.childModelSelection,
          model: "another-model",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
      createIdentity,
    );
    expect(retry.input.commandId).toBe("command-2");
    expect(retry.input.message.text).toContain("another-model");
  });

  it("refreshes inherited permissions if they change between attempts", () => {
    const { input, request, createIdentity } = scenario();
    const retry = prepareNewThreadTaskRequest(
      request,
      {
        ...input,
        thread: { ...input.thread, interactionMode: "plan", runtimeMode: "approval-required" },
      },
      createIdentity,
    );
    expect(retry.input.commandId).toBe("command-2");
    expect(retry.input.runtimeMode).toBe("approval-required");
    expect(retry.input.interactionMode).toBe("plan");
  });
});
