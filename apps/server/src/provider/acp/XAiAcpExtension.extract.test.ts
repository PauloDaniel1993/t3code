import { describe, expect, it } from "vite-plus/test";

import { extractXAiAskUserQuestions } from "./XAiAcpExtension.ts";

describe("XAiAcpExtension extraction", () => {
  it("preserves ten xAI ask_user_question prompts in order", () => {
    const questions = extractXAiAskUserQuestions({
      sessionId: "session-1",
      toolCallId: "tool-call-ten",
      mode: "default",
      questions: Array.from({ length: 10 }, (_, index) => ({
        id: `question-${index + 1}`,
        question: `Question ${index + 1}?`,
        options: [{ label: "Continue", description: "Continue" }],
      })),
    });

    expect(questions).toHaveLength(10);
    expect(questions.map((question) => question.id)).toEqual([
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
});
