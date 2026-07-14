import { describe, expect, it } from "vite-plus/test";

import { MAX_USER_INPUT_QUESTIONS, validateUserInputQuestionBatch } from "./userInput.ts";

const makeQuestion = (index: number) => ({
  id: `question-${index}`,
  header: `Question ${index}`,
  question: `Question ${index}?`,
  options: [{ label: "Continue", description: "Continue" }],
  multiSelect: false,
});

describe("validateUserInputQuestionBatch", () => {
  it("accepts one to ten questions and preserves order", () => {
    const questions = Array.from({ length: MAX_USER_INPUT_QUESTIONS }, (_, index) =>
      makeQuestion(index + 1),
    );

    const validation = validateUserInputQuestionBatch(questions);

    expect(validation._tag).toBe("Valid");
    if (validation._tag !== "Valid") {
      return;
    }
    expect(validation.questions.map((question) => question.id)).toEqual([
      "question-1",
      "question-2",
      "question-3",
      "question-4",
      "question-5",
      "question-6",
      "question-7",
      "question-8",
      "question-9",
      "question-10",
    ]);
  });

  it("rejects empty batches", () => {
    expect(validateUserInputQuestionBatch([])).toEqual({
      _tag: "Invalid",
      reason: "empty",
      count: 0,
      max: MAX_USER_INPUT_QUESTIONS,
      message: "request_user_input requires 1 to 10 questions; received 0.",
    });
  });

  it("rejects more than ten questions with a provider-visible message", () => {
    const validation = validateUserInputQuestionBatch(
      Array.from({ length: MAX_USER_INPUT_QUESTIONS + 1 }, (_, index) => makeQuestion(index + 1)),
    );

    expect(validation).toMatchObject({
      _tag: "Invalid",
      reason: "too_many",
      count: 11,
      max: MAX_USER_INPUT_QUESTIONS,
    });
    if (validation._tag !== "Invalid") {
      return;
    }
    expect(validation.message).toContain("1 to 10");
    expect(validation.message).toContain("11");
  });
});
