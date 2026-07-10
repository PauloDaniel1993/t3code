import { ProviderUserInputAnswers } from "@t3tools/contracts";
import { MAX_USER_INPUT_QUESTIONS } from "@t3tools/shared/userInput";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProviderService from "../../../provider/Services/ProviderService.ts";

const NonEmptyText = Schema.String.check(Schema.isNonEmpty());

const UserInputQuestionOption = Schema.Struct({
  label: NonEmptyText.annotate({
    description: "Short label shown as the selectable option text.",
  }),
  description: NonEmptyText.annotate({
    description: "One short sentence explaining the impact or tradeoff for this option.",
  }),
}).annotate({
  description: "One selectable answer option for a structured user-input question.",
});

const RequestUserInputQuestion = Schema.Struct({
  id: NonEmptyText.annotate({
    description: "Stable snake_case identifier used as the key in the returned answers object.",
  }),
  header: NonEmptyText.check(Schema.isMaxLength(12)).annotate({
    description: "Short UI header label for the question, at most 12 characters.",
  }),
  question: NonEmptyText.annotate({
    description: "Single-sentence question to show to the user.",
  }),
  options: Schema.Array(UserInputQuestionOption).check(Schema.isMinLength(2)).annotate({
    description: "Two or more mutually exclusive answer options.",
  }),
  multiSelect: Schema.optional(
    Schema.Boolean.annotate({
      description: "Set true only when the user may select more than one option.",
    }),
  ),
}).annotate({
  description: "A single structured question for the T3 Code user-input UI.",
});

export const RequestUserInputParameters = Schema.Struct({
  questions: Schema.Array(RequestUserInputQuestion)
    .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_USER_INPUT_QUESTIONS))
    .annotate({
      description: `One to ${MAX_USER_INPUT_QUESTIONS} structured questions to ask in this request.`,
    }),
}).annotate({
  description: `Ask the user one to ${MAX_USER_INPUT_QUESTIONS} structured questions in the T3 Code UI.`,
});
export type RequestUserInputParameters = typeof RequestUserInputParameters.Type;

export const RequestUserInputResult = Schema.Struct({
  answers: ProviderUserInputAnswers.annotate({
    description: "Answer map keyed by question id.",
  }),
}).annotate({
  description: "Structured answers returned by the user.",
});
export type RequestUserInputResult = typeof RequestUserInputResult.Type;

const dependencies = [McpInvocationContext.McpInvocationContext, ProviderService.ProviderService];

export const RequestUserInputTool = Tool.make("request_user_input", {
  description: `Required T3 Code tool for asking the user up to ${MAX_USER_INPUT_QUESTIONS} structured questions through the T3 Code UI and waiting for their answers. Always use this when available instead of provider-native or host-injected question tools; split larger batches across multiple calls.`,
  parameters: RequestUserInputParameters,
  success: RequestUserInputResult,
  failure: Schema.String,
  dependencies,
})
  .annotate(Tool.Title, "Ask user questions in T3 Code")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const UserInputToolkit = Toolkit.make(RequestUserInputTool);
