import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import { OrchestrationV2DispatchCommandError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { buildDelegationTurnInput } from "./NewThreadTaskDialog.logic";

export interface NewThreadTaskRequest {
  readonly key: string;
  readonly input: StartThreadTurnInput;
}

type DelegationInput = Parameters<typeof buildDelegationTurnInput>[0];

/** An uncertain retry reuses the entire command; editing work or inherited modes starts another. */
export function prepareNewThreadTaskRequest(
  previous: NewThreadTaskRequest | null,
  input: Omit<DelegationInput, "commandId" | "messageId" | "createdAt">,
  createIdentity: () => Pick<DelegationInput, "commandId" | "messageId" | "createdAt">,
): NewThreadTaskRequest {
  const key = JSON.stringify({
    threadId: input.thread.id,
    runtimeMode: input.thread.runtimeMode,
    interactionMode: input.thread.interactionMode,
    draft: input.draft,
    childModelSelection: input.childModelSelection,
  });
  return previous?.key === key
    ? previous
    : { key, input: buildDelegationTurnInput({ ...input, ...createIdentity() }) };
}

const isRejectedCommand = Schema.is(OrchestrationV2DispatchCommandError);

/** Rejections have durable receipts, so a corrected retry needs a fresh command. */
export function retainNewThreadTaskRequestForRetry(
  request: NewThreadTaskRequest,
  error: unknown,
): NewThreadTaskRequest | null {
  return isRejectedCommand(error) ? null : request;
}
