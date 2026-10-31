import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type {
  EnvironmentId,
  FlowRunSnapshot,
  FlowRunSummary,
  FlowStepRunState,
  FlowStepOutput,
  FlowOutputFields,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { reportFlowFailure } from "./flowErrors";
import {
  latestStepAttempts,
  flowStepInstanceKey,
  flowStepRunList,
} from "@t3tools/client-runtime/flows";
import { flowEnvironment } from "../../state/flows";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { TextField } from "./FlowFields";

function outputFieldsText(output: FlowOutputFields) {
  switch (output.kind) {
    case "agent":
      return JSON.stringify(output.fields, null, 2);
    case "command":
      return `Exit code: ${output.exitCode ?? "none"}\nTimed out: ${output.timedOut}\nOutput lines: ${output.lineCount}`;
    case "approval":
      return `${output.decision}${output.comment ? `\n${output.comment}` : ""}`;
    case "loop":
      return `${output.iterations} iterations · ${output.exitReason}`;
    case "map":
      return output.items.map((item, index) => `Item ${index + 1}: ${item.status}`).join("\n");
  }
}

function outputText(output: FlowStepOutput | null) {
  if (!output) return "No step output yet.";
  switch (output.kind) {
    case "agent":
    case "command":
      return output.text;
    case "approval":
    case "loop":
    case "map":
      return JSON.stringify(output, null, 2);
  }
}

export function FlowRunActions({
  environmentId,
  summary,
}: {
  environmentId: EnvironmentId;
  summary: FlowRunSummary;
}) {
  const stop = useAtomCommand(flowEnvironment.stop);
  const resume = useAtomCommand(flowEnvironment.resume);
  const canStop = useAtomValue(flowEnvironment.stop.permissionAtom(environmentId));
  const canResume = useAtomValue(flowEnvironment.resume.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const active = ["starting", "running", "waiting_approval"].includes(summary.status);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span role="status">{summary.status.replaceAll("_", " ")}</span>
      {active && (
        <Button
          size="xs"
          variant="outline"
          disabled={!canStop || busy}
          onClick={async () => {
            setBusy(true);
            reportFlowFailure(
              await stop({ environmentId, input: { flowRunId: summary.id } }),
              "Could not stop flow",
            );
            setBusy(false);
          }}
        >
          Stop
        </Button>
      )}
      {summary.status === "cancelled" && (
        <Button
          size="xs"
          variant="outline"
          disabled={!canResume || busy}
          onClick={async () => {
            setBusy(true);
            reportFlowFailure(
              await resume({ environmentId, input: { flowRunId: summary.id } }),
              "Could not resume flow",
            );
            setBusy(false);
          }}
        >
          Resume
        </Button>
      )}
    </div>
  );
}

export function StepRunInspector(props: {
  environmentId: EnvironmentId;
  snapshot: FlowRunSnapshot;
  stepRun: FlowStepRunState;
}) {
  return (
    <StepRunDetails
      key={`${props.stepRun.id}:${props.stepRun.status}:${props.stepRun.finishedAt}`}
      {...props}
    />
  );
}
function StepRunDetails({
  environmentId,
  snapshot,
  stepRun,
}: {
  environmentId: EnvironmentId;
  snapshot: FlowRunSnapshot;
  stepRun: FlowStepRunState;
}) {
  const fetchOutput = useAtomCommand(flowEnvironment.stepRunOutput);
  const retry = useAtomCommand(flowEnvironment.retryStep);
  const answer = useAtomCommand(flowEnvironment.answerApproval);
  const canRetry = useAtomValue(flowEnvironment.retryStep.permissionAtom(environmentId));
  const canAnswer = useAtomValue(flowEnvironment.answerApproval.permissionAtom(environmentId));
  const canRead = useAtomValue(flowEnvironment.stepRunOutput.permissionAtom(environmentId));
  const [comment, setComment] = useState("");
  const [output, setOutput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const approval = snapshot.approvals.find(
    (entry) => entry.stepRunId === stepRun.id && entry.decision === null,
  );
  return (
    <section className="flex flex-col gap-2 text-xs" aria-label="Step run details">
      <p>
        {stepRun.stepPath.join(" / ")} · {stepRun.status.replaceAll("_", " ")} · attempt{" "}
        {stepRun.attempt}
      </p>
      {stepRun.error && <p role="alert">{stepRun.error.message}</p>}
      {stepRun.threadId && (
        <Link to="/$environmentId/$threadId" params={{ environmentId, threadId: stepRun.threadId }}>
          Open step thread
        </Link>
      )}
      {stepRun.outputFields && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap">
          {outputFieldsText(stepRun.outputFields)}
        </pre>
      )}
      <Button
        size="xs"
        variant="outline"
        disabled={!canRead || busy}
        onClick={async () => {
          setBusy(true);
          const result = await fetchOutput({ environmentId, input: { stepRunId: stepRun.id } });
          if (result._tag === "Success") setOutput(outputText(result.value));
          reportFlowFailure(result, "Could not fetch step output");
          setBusy(false);
        }}
      >
        Fetch step output
      </Button>
      {output !== null && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{output}</pre>
      )}
      {(stepRun.status === "failed" || stepRun.status === "interrupted") &&
        latestStepAttempts(snapshot).get(flowStepInstanceKey(stepRun))?.id === stepRun.id && (
          <Button
            size="xs"
            variant="outline"
            disabled={!canRetry || busy}
            onClick={async () => {
              setBusy(true);
              reportFlowFailure(
                await retry({ environmentId, input: { stepRunId: stepRun.id } }),
                "Could not retry step",
              );
              setBusy(false);
            }}
          >
            Retry step
          </Button>
        )}
      {approval && (
        <>
          <p>{approval.prompt}</p>
          <TextField label="Approval comment" value={comment} onChange={setComment} />
          <div className="flex gap-2">
            {(["approve", "reject"] as const).map((decision) => (
              <Button
                key={decision}
                size="xs"
                disabled={!canAnswer || busy}
                onClick={async () => {
                  setBusy(true);
                  const result = await answer({
                    environmentId,
                    input: { stepRunId: stepRun.id, decision, ...(comment ? { comment } : {}) },
                  });
                  reportFlowFailure(result, "Could not answer approval");
                  setBusy(false);
                }}
              >
                {decision === "approve" ? "Approve" : "Reject"}
              </Button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function FlowRunTimeline({
  snapshot,
  selectedId,
  onSelect,
}: {
  snapshot: FlowRunSnapshot;
  selectedId?: string | null;
  onSelect: (step: FlowStepRunState) => void;
}) {
  const steps = flowStepRunList(snapshot);
  const start = Date.parse(snapshot.summary.startedAt ?? snapshot.summary.createdAt);
  const end = Math.max(
    start + 1,
    ...steps.map((step) => Date.parse(step.finishedAt ?? step.startedAt ?? step.createdAt)),
  );
  return (
    <ol className="flex flex-col gap-1">
      {steps.map((step) => {
        const from = Date.parse(step.startedAt ?? step.createdAt);
        const to = Date.parse(step.finishedAt ?? step.startedAt ?? step.createdAt);
        return (
          <li key={step.id}>
            <button
              type="button"
              onClick={() => onSelect(step)}
              aria-pressed={selectedId === step.id}
              className="flex w-full flex-col gap-1 rounded p-2 text-left text-xs hover:bg-accent aria-pressed:bg-accent"
            >
              <span style={{ paddingInlineStart: step.depth * 12 }}>
                {step.stepId} · {step.status.replaceAll("_", " ")} · attempt {step.attempt}{" "}
                {step.scopeLabel}
                {step.finishedAt && step.startedAt
                  ? ` · ${formatDuration(Math.max(0, to - from))}`
                  : ""}
              </span>
              <span className="h-1.5 w-full rounded bg-muted">
                <span
                  className="block h-full rounded bg-primary"
                  style={{
                    marginInlineStart: `${Math.max(0, ((from - start) / (end - start)) * 100)}%`,
                    width: `${Math.max(1, ((to - from) / (end - start)) * 100)}%`,
                  }}
                />
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
