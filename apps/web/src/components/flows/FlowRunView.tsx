import { ExternalLink, RefreshCw, RotateCcw } from "lucide-react";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { FlowStepStatus, flowStatusBar } from "./FlowStepStatus";
import { cn } from "../../lib/utils";
import { useState, useEffect, useEffectEvent } from "react";
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

export function outputFieldsText(output: FlowOutputFields) {
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

export function useStepRunOutput(environmentId: EnvironmentId, stepRunId: FlowStepRunState["id"]) {
  const fetchOutput = useAtomCommand(flowEnvironment.stepRunOutput);
  const canRead = useAtomValue(flowEnvironment.stepRunOutput.permissionAtom(environmentId));
  const [output, setOutput] = useState<FlowStepOutput | null>(null);
  const [loading, setLoading] = useState(canRead);
  const [error, setError] = useState<string | null>(null);
  const read = useEffectEvent(async (active: () => boolean) => {
    setError(null);
    const result = await fetchOutput({ environmentId, input: { stepRunId } });
    if (!active()) return;
    if (result._tag === "Success") setOutput(result.value);
    else setError(reportFlowFailure(result, "Could not fetch step output"));
    setLoading(false);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads persisted output when a step run is opened
  useEffect(() => {
    if (!canRead) return;
    let active = true;
    // oxlint-disable-next-line react/set-state-in-effect -- publishes output only after the request resolves
    void read(() => active);
    return () => {
      active = false;
    };
  }, [canRead]);
  const refresh = () => {
    setLoading(true);
    void read(() => true);
  };
  return { output, loading, error, canRead, refresh };
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
      <FlowStepStatus status={summary.status} />
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
      {summary.status === "cancelled" && summary.startedAt !== null && (
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
  const retry = useAtomCommand(flowEnvironment.retryStep);
  const answer = useAtomCommand(flowEnvironment.answerApproval);
  const canRetry = useAtomValue(flowEnvironment.retryStep.permissionAtom(environmentId));
  const canAnswer = useAtomValue(flowEnvironment.answerApproval.permissionAtom(environmentId));
  const [comment, setComment] = useState("");
  const stepOutput = useStepRunOutput(environmentId, stepRun.id);
  const output = stepOutput.loading ? null : outputText(stepOutput.output);
  const [busy, setBusy] = useState(false);
  const approval = snapshot.approvals.find(
    (entry) => entry.stepRunId === stepRun.id && entry.decision === null,
  );
  return (
    <section className="flex flex-col gap-2 text-xs" aria-label="Step run details">
      <div className="flex items-center gap-2">
        <FlowStepStatus status={stepRun.status} />
        <Badge variant="secondary" size="sm">
          Attempt {stepRun.attempt}
        </Badge>
      </div>
      <p className="text-2xs text-muted-foreground">{stepRun.stepPath.join(" / ")}</p>
      {stepRun.error && <p role="alert">{stepRun.error.message}</p>}
      {stepRun.threadId && (
        <Button
          variant="link"
          size="xs"
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: stepRun.threadId }}
            />
          }
        >
          <ExternalLink />
          Open step thread
        </Button>
      )}
      {stepRun.outputFields && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-xs">
          {outputFieldsText(stepRun.outputFields)}
        </pre>
      )}
      <div className="flex items-center justify-between">
        <span className="text-2xs font-medium text-muted-foreground">OUTPUT</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Refresh step output"
                disabled={!stepOutput.canRead || stepOutput.loading}
                onClick={stepOutput.refresh}
              />
            }
          >
            <RefreshCw />
          </TooltipTrigger>
          <TooltipPopup>Refresh step output</TooltipPopup>
        </Tooltip>
      </div>
      {stepOutput.loading && <Skeleton className="h-16 w-full" />}
      {stepOutput.error && (
        <p role="alert" className="text-destructive">
          {stepOutput.error}
        </p>
      )}
      {output !== null && !stepOutput.error && stepOutput.canRead && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-xs">
          {output}
        </pre>
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
            <RotateCcw /> Retry step
          </Button>
        )}
      {approval && (
        <>
          <p>{approval.prompt}</p>
          <TextField label="Approval comment" multiline value={comment} onChange={setComment} />
          <div className="flex gap-2">
            {(["approve", "reject"] as const).map((decision) => (
              <Button
                key={decision}
                size="xs"
                variant={decision === "approve" ? "default" : "outline"}
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
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 text-3xs text-muted-foreground">
        <span>Step run</span>
        <div className="flex justify-between">
          <span>0s</span>
          <span>{formatDuration((end - start) / 2)}</span>
          <span>{formatDuration(end - start)}</span>
        </div>
      </div>
      <ol className="flex flex-col gap-1">
        {steps.map((step) => {
          const from = Date.parse(step.startedAt ?? step.createdAt);
          const to = Date.parse(step.finishedAt ?? step.startedAt ?? step.createdAt);
          const left = Math.min(99, Math.max(0, ((from - start) / (end - start)) * 100));
          return (
            <li key={step.id}>
              <button
                type="button"
                onClick={() => onSelect(step)}
                aria-pressed={selectedId === step.id}
                className="grid w-full grid-cols-[7rem_minmax(0,1fr)] items-center gap-2 rounded-md p-2 text-left text-xs hover:bg-accent/60 aria-pressed:bg-accent/60"
              >
                <span
                  className="min-w-0"
                  style={{ paddingInlineStart: Math.min(step.depth, 4) * 12 }}
                >
                  <span className="block truncate font-medium">{step.stepId}</span>
                  <span className="block truncate text-3xs text-muted-foreground">
                    Attempt {step.attempt} {step.scopeLabel}
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="relative block h-5 overflow-hidden rounded bg-muted/50">
                    <span
                      className={cn(
                        "absolute inset-y-1 rounded-sm opacity-80",
                        flowStatusBar(step.status),
                      )}
                      style={{
                        left: `${left}%`,
                        width: `${Math.min(100 - left, Math.max(1, ((to - from) / (end - start)) * 100))}%`,
                      }}
                    />
                  </span>
                  <span className="mt-1 flex items-center justify-between gap-1">
                    <FlowStepStatus status={step.status} />
                    <span className="text-3xs text-muted-foreground">
                      {formatDuration(Math.max(0, to - from))}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
