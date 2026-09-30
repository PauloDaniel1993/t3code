import { describe, expect, it } from "vite-plus/test";
import { CommandId, MessageId, PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { makeThreadProjectionFixture } from "../test-fixtures";
import { buildDelegationTurnInput, TASK_PROMPT_MAX_LENGTH } from "./NewThreadTaskDialog.logic";
import { prepareNewThreadTaskRequest } from "./NewThreadTaskHost.logic";

function input(includeThreadContext?: boolean) {
  const thread = makeThreadProjectionFixture().thread;
  return {
    thread,
    draft: {
      title: "Review",
      prompt: "Check Windows paths",
      ...(includeThreadContext === undefined ? {} : { includeThreadContext }),
    },
    childModelSelection: thread.modelSelection,
    commandId: CommandId.make("00000000-0000-0000-0000-000000000001"),
    messageId: MessageId.make("message"),
    createdAt: "2026-09-29T12:00:00.000Z",
  };
}

describe("optional parent context summary", () => {
  it("defaults to prompt only and keeps the original instruction after opting out", () => {
    const defaultText = buildDelegationTurnInput(input()).message.text;
    expect(defaultText).toContain("Do not append this thread's conversation history");
    expect(defaultText).not.toContain("Append your own concise summary");
    expect(buildDelegationTurnInput(input(false)).message.text).toBe(defaultText);
  });

  it("opts into a bounded summary while preserving the task text and every other argument", () => {
    const text = buildDelegationTurnInput(input(true)).message.text;
    expect(text).toContain("Append your own concise summary");
    expect(text).toContain("4000 additional characters");
    expect(text).toContain("at most 16000 characters");
    expect(text).toContain("Do not copy the conversation transcript");
    expect(text).toContain("Preserve every other JSON argument exactly");
    const args = JSON.parse(text.split("```json\n")[1]!.split("\n```")[0]!);
    expect(args.task).toBe("Check Windows paths");
    expect(args).not.toHaveProperty("includeThreadContext");
    expect(args.runtimeMode).toBe("inherit");
    expect(args.interactionMode).toBe("inherit");
  });

  it("keeps the maximum draft within the composer limit with summary instructions enabled", () => {
    const params = input(true);
    const text = buildDelegationTurnInput({
      ...params,
      draft: { ...params.draft, prompt: "\u0001".repeat(TASK_PROMPT_MAX_LENGTH) },
    }).message.text;
    expect(text.length).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
  });

  it("starts a fresh request if the summary choice changes before retry", () => {
    const params = input();
    const first = prepareNewThreadTaskRequest(null, params, () => ({
      commandId: params.commandId,
      messageId: params.messageId,
      createdAt: params.createdAt,
    }));
    const retry = prepareNewThreadTaskRequest(
      first,
      { ...params, draft: { ...params.draft, includeThreadContext: true } },
      () => ({
        commandId: CommandId.make("context-request"),
        messageId: MessageId.make("context-message"),
        createdAt: params.createdAt,
      }),
    );
    expect(retry.input.commandId).toBe("context-request");
    expect(retry.input.message.text).toContain("Append your own concise summary");
  });
});
