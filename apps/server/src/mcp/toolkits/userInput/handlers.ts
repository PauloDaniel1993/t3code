import type { UserInputQuestion } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProviderService from "../../../provider/Services/ProviderService.ts";
import { RequestUserInputAnswers, UserInputToolkit } from "./tools.ts";

const toFailureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const decodeRequestUserInputAnswers = Schema.decodeUnknownEffect(RequestUserInputAnswers);

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
      const rawAnswers = yield* providerService
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
      const answers = yield* decodeRequestUserInputAnswers(rawAnswers).pipe(
        Effect.mapError(() => "T3 Code returned an invalid structured user-input answer payload."),
      );
      return { answers };
    }),
});
