import { type UserInputQuestion } from "@t3tools/contracts";
import React, { useMemo, useState } from "react";
import ReactDOM from "react-dom/client";

import { ComposerPendingUserInputPanel } from "../components/chat/ComposerPendingUserInputPanel";
import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import type { PendingUserInput } from "../session-logic";
import "../index.css";

const questions = [
  {
    id: "priority",
    header: "Priority",
    question: "Which product priority should guide this validation?",
    options: [
      {
        label: "Reliability",
        description: "Prefer predictable behavior and robust failure handling.",
      },
      { label: "Performance", description: "Prefer responsiveness and efficient execution." },
      { label: "Usability", description: "Prefer a clear and approachable user experience." },
    ],
    multiSelect: false,
  },
  {
    id: "surface",
    header: "Surface",
    question: "Which client should be treated as the primary experience?",
    options: [
      { label: "Web", description: "Use the browser client as the primary experience." },
      { label: "Mobile", description: "Use the native mobile client as the primary experience." },
      { label: "Both", description: "Treat web and mobile as equally important." },
    ],
    multiSelect: false,
  },
  {
    id: "release",
    header: "Release",
    question: "How should this feature be released?",
    options: [
      { label: "Directly", description: "Enable it for everyone when the change lands." },
      { label: "Feature flag", description: "Roll it out behind a configurable flag." },
      {
        label: "Internal first",
        description: "Validate it with internal users before broad release.",
      },
    ],
    multiSelect: false,
  },
  {
    id: "clients",
    header: "Clients",
    question: "Which clients should support multi-select replies?",
    options: [
      { label: "Web", description: "Support multi-select in the web client." },
      { label: "Mobile", description: "Support multi-select in the mobile client." },
      { label: "Desktop", description: "Support multi-select in the desktop client." },
    ],
    multiSelect: true,
  },
  {
    id: "coverage",
    header: "Coverage",
    question: "Which validation layers should cover multi-select replies?",
    options: [
      { label: "Schema", description: "Validate the MCP request and response contract." },
      { label: "Unit tests", description: "Cover shared answer-building and toggle behavior." },
      { label: "UI tests", description: "Verify selection and submission in client interfaces." },
    ],
    multiSelect: true,
  },
] satisfies ReadonlyArray<UserInputQuestion>;

const prompt: PendingUserInput = {
  requestId: "multi-select-harness" as PendingUserInput["requestId"],
  createdAt: new Date().toISOString(),
  questions,
};

function MultiSelectHarness() {
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [submittedAnswers, setSubmittedAnswers] = useState<Record<
    string,
    string | string[]
  > | null>(null);
  const activeQuestion = questions[questionIndex] ?? null;
  const resolvedAnswers = useMemo(
    () => buildPendingUserInputAnswers(questions, answers),
    [answers],
  );

  const toggleOption = (questionId: string, optionLabel: string) => {
    const question = questions.find((entry) => entry.id === questionId);
    if (!question) return;
    setAnswers((current) => ({
      ...current,
      [questionId]: togglePendingUserInputOptionSelection(
        question,
        current[questionId],
        optionLabel,
      ),
    }));
  };

  const advance = () => {
    if (questionIndex < questions.length - 1) {
      setQuestionIndex((current) => current + 1);
      return;
    }
    setSubmittedAnswers(resolvedAnswers);
  };

  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <div className="mx-auto max-w-3xl space-y-5">
        <header className="space-y-2">
          <p className="text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            Live component harness
          </p>
          <h1 className="text-2xl font-semibold">MCP multi-select user input</h1>
          <p className="text-sm text-muted-foreground">
            The first three questions auto-advance. The last two remain open until you select
            Continue or Submit.
          </p>
        </header>

        <section className="rounded-[20px] border border-border bg-card shadow-sm">
          <ComposerPendingUserInputPanel
            pendingUserInputs={[prompt]}
            respondingRequestIds={[]}
            answers={answers}
            questionIndex={questionIndex}
            onToggleOption={toggleOption}
            onAdvance={advance}
          />
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
            <button
              className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40"
              disabled={questionIndex === 0}
              onClick={() => setQuestionIndex((current) => Math.max(0, current - 1))}
              type="button"
            >
              Back
            </button>
            <button
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
              disabled={
                activeQuestion === null ||
                (activeQuestion.multiSelect && !answers[activeQuestion.id])
              }
              onClick={advance}
              type="button"
            >
              {questionIndex === questions.length - 1 ? "Submit answers" : "Continue"}
            </button>
          </div>
        </section>

        {submittedAnswers ? (
          <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-4 text-xs">
            {JSON.stringify(submittedAnswers, null, 2)}
          </pre>
        ) : null}
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MultiSelectHarness />
  </React.StrictMode>,
);
