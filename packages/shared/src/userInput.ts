import type { UserInputQuestion } from "@t3tools/contracts";

export const MAX_USER_INPUT_QUESTIONS = 10;

export type UserInputQuestionBatchValidation =
  | {
      readonly _tag: "Valid";
      readonly questions: ReadonlyArray<UserInputQuestion>;
    }
  | {
      readonly _tag: "Invalid";
      readonly reason: "empty" | "too_many";
      readonly count: number;
      readonly max: typeof MAX_USER_INPUT_QUESTIONS;
      readonly message: string;
    };

export function formatUserInputQuestionBatchValidationError(
  count: number,
  max = MAX_USER_INPUT_QUESTIONS,
): string {
  return `request_user_input requires 1 to ${max} questions; received ${count}.`;
}

export function validateUserInputQuestionBatch(
  questions: ReadonlyArray<UserInputQuestion>,
): UserInputQuestionBatchValidation {
  const count = questions.length;
  if (count === 0) {
    return {
      _tag: "Invalid",
      reason: "empty",
      count,
      max: MAX_USER_INPUT_QUESTIONS,
      message: formatUserInputQuestionBatchValidationError(count),
    };
  }
  if (count > MAX_USER_INPUT_QUESTIONS) {
    return {
      _tag: "Invalid",
      reason: "too_many",
      count,
      max: MAX_USER_INPUT_QUESTIONS,
      message: formatUserInputQuestionBatchValidationError(count),
    };
  }
  return {
    _tag: "Valid",
    questions,
  };
}
