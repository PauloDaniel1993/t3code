import { ApprovalRequestId, type UserInputQuestion } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

function makeQuestion(index: number): UserInputQuestion {
  return {
    id: `question-${index}`,
    header: `Question ${index}`,
    question: `Question ${index}?`,
    options: [
      {
        label: `Answer ${index}`,
        description: `Answer ${index}`,
      },
    ],
    multiSelect: false,
  };
}

const questions = Array.from({ length: 10 }, (_, index) => makeQuestion(index + 1));

const pendingUserInput: PendingUserInput = {
  requestId: ApprovalRequestId.make("req-user-input-ten"),
  createdAt: "2026-04-01T00:00:01.000Z",
  questions,
};

describe("ComposerPendingUserInputPanel", () => {
  it("renders first and last positions for a ten-question prompt", () => {
    const firstMarkup = renderToStaticMarkup(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[pendingUserInput]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={() => {}}
        onAdvance={() => {}}
      />,
    );

    expect(firstMarkup).toContain("1/10");
    expect(firstMarkup).toContain("Question 1?");
    expect(firstMarkup).not.toContain("Question 10?");

    const lastMarkup = renderToStaticMarkup(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[pendingUserInput]}
        respondingRequestIds={[]}
        answers={Object.fromEntries(
          questions
            .slice(0, 9)
            .map((question, index) => [
              question.id,
              { selectedOptionLabels: [`Answer ${index + 1}`] },
            ]),
        )}
        questionIndex={9}
        onToggleOption={() => {}}
        onAdvance={() => {}}
      />,
    );

    expect(lastMarkup).toContain("10/10");
    expect(lastMarkup).toContain("Question 10?");
    expect(lastMarkup).not.toContain("Question 1?");
  });
});
