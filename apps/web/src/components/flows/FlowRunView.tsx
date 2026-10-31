import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type {
  EnvironmentId,
  FlowRunSnapshot,
  FlowRunSummary,
  FlowStepRunState,
} from "@t3tools/contracts";
import { flowStepRunList } from "@t3tools/client-runtime/flows";
import { flowEnvironment } from "../../state/flows";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { TextField } from "./FlowFields";

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
            await stop({ environmentId, input: { flowRunId: summary.id } });
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
            await resume({ environmentId, input: { flowRunId: summary.id } });
            setBusy(false);
          }}
        >
          Resume
        </Button>
      )}
    </div>
  );
}

export function StepRunInspector({
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
          {JSON.stringify(stepRun.outputFields, null, 2)}
        </pre>
      )}
      <Button
        size="xs"
        variant="outline"
        disabled={!canRead || busy}
        onClick={async () => {
          setBusy(true);
          const result = await fetchOutput({ environmentId, input: { stepRunId: stepRun.id } });
          if (result._tag === "Success")
            setOutput(
              result.value === null
                ? "No step output yet."
                : "text" in result.value && typeof result.value.text === "string"
                  ? result.value.text
                  : JSON.stringify(result.value, null, 2),
            );
          setBusy(false);
        }}
      >
        Fetch step output
      </Button>
      {output !== null && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{output}</pre>
      )}
      {(stepRun.status === "failed" || stepRun.status === "interrupted") && (
        <Button
          size="xs"
          variant="outline"
          disabled={!canRetry || busy}
          onClick={async () => {
            setBusy(true);
            await retry({ environmentId, input: { stepRunId: stepRun.id } });
            setBusy(false);
          }}
        >
          Retry step
        </Button>
      )}
      {approval && (
        <>
          <p>{approval.prompt}</p>
          <TextField label="Approval comment" value={comment} onChange={setComment} />{" "}
          <div className="flex gap-2">
            {(["approve", "reject"] as const).map((decision) => (
              <Button
                key={decision}
                size="xs"
                disabled={!canAnswer || busy}
                onClick={async () => {
                  setBusy(true);
                  await answer({
                    environmentId,
                    input: { stepRunId: stepRun.id, decision, ...(comment ? { comment } : {}) },
                  });
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
  onSelect,
}: {
  snapshot: FlowRunSnapshot;
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
          <li key={step.id} style={{ paddingInlineStart: step.depth * 12 }}>
            <button
              type="button"
              onClick={() => onSelect(step)}
              className="flex w-full flex-col gap-1 rounded p-2 text-left text-xs hover:bg-accent"
            >
              <span>
                {step.stepId} · {step.status.replaceAll("_", " ")} · attempt {step.attempt}{" "}
                {step.iterationLabel} {step.itemLabel}
                {step.finishedAt && step.startedAt ? ` · ${Math.max(0, to - from)} ms` : ""}
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
