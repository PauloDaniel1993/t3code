import type { UserInputQuestion } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProviderService from "../../../provider/Services/ProviderService.ts";
import { UserInputToolkit } from "./tools.ts";

const toFailureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const requireUserInputCapability = Effect.gen(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("user-input")) {
    return yield* Effect.fail("MCP credential does not grant the user-input capability.");
  }
  return invocation;
});

export const UserInputToolkitHandlersLive = UserInputToolkit.toLayer({
  request_user_input: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireUserInputCapability;
      const providerService = yield* ProviderService.ProviderService;
      const answers = yield* providerService
        .requestUserInput({
          threadId: scope.threadId,
          providerInstanceId: scope.providerInstanceId,
          questions: input.questions.map(
            (question): UserInputQuestion => ({
              ...question,
              multiSelect: question.multiSelect === true,
            }),
          ),
        })
        .pipe(Effect.mapError(toFailureMessage));
      return { answers };
    }),
});
