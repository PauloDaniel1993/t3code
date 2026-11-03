import { Alert, AlertDescription } from "../ui/alert";
import type {
  EnvironmentId,
  FlowRunSnapshot,
  FlowStep,
  FlowStepRunState,
  FlowValue,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { Fragment, useState } from "react";
import { flowResultStepRuns } from "@t3tools/client-runtime/flows";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useEnvironmentQuery } from "../../state/query";
import { flowEnvironment } from "../../state/flows";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import {
  FlowRunActions,
  FlowRunTimeline,
  StepRunInspector,
  outputFieldsText,
  useStepRunOutput,
} from "./FlowRunView";
import { useFlowPanelRequest } from "./flowPanelState";

function useFlowRunLookup(threadRef: ScopedThreadRef | null) {
  return useEnvironmentQuery(
    threadRef
      ? flowEnvironment.runForThread({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
}

export function useFlowRunThreadRole(threadRef: ScopedThreadRef | null) {
  return useFlowRunLookup(threadRef).data?.role ?? null;
}

function FieldValue({ value, enumField }: { value: FlowValue; enumField: boolean }) {
  if (Array.isArray(value)) {
    const seen = new Map<string, number>();
    return (
      <ul className="flex list-disc flex-col gap-1 ps-4">
        {value.map((item) => {
          const occurrence = (seen.get(item) ?? 0) + 1;
          seen.set(item, occurrence);
          return <li key={`${occurrence}:${item}`}>{item}</li>;
        })}
      </ul>
    );
  }
  if (enumField || typeof value === "boolean")
    return (
      <Badge variant="outline" size="sm">
        {String(value)}
      </Badge>
    );
  return <>{String(value)}</>;
}

function FinalStepResult({
  environmentId,
  step,
  stepRun,
}: {
  environmentId: EnvironmentId;
  step: FlowStep;
  stepRun: FlowStepRunState;
}) {
  const stepOutput = useStepRunOutput(environmentId, stepRun.id);
  const fields = stepRun.outputFields?.kind === "agent" ? stepRun.outputFields.fields : {};
  const declared = step.kind === "agent" ? (step.outputs ?? []) : [];
  const text =
    stepOutput.output?.kind === "agent" || stepOutput.output?.kind === "command"
      ? stepOutput.output.text.trim()
      : "";
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{step.id}</span>
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
      </div>
      {Object.keys(fields).length > 0 && (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          {Object.entries(fields).map(([name, value]) => (
            <Fragment key={name}>
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="min-w-0">
                <FieldValue
                  value={value}
                  enumField={declared.some((field) => field.name === name && field.type === "enum")}
                />
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {stepRun.outputFields &&
        (stepRun.outputFields.kind === "approval" ||
          stepRun.outputFields.kind === "loop" ||
          stepRun.outputFields.kind === "map") && (
          <p className="whitespace-pre-wrap text-sm">{outputFieldsText(stepRun.outputFields)}</p>
        )}
      {stepOutput.loading && <Skeleton className="h-16 w-full" />}
      {stepOutput.error && (
        <p role="alert" className="text-xs text-destructive">
          {stepOutput.error}
        </p>
      )}
      {text &&
        (stepOutput.output?.kind === "agent" ? (
          <div className="border-t border-border pt-3 text-sm">
            <ChatMarkdown
              text={text}
              cwd={undefined}
              environmentId={environmentId}
              isStreaming={false}
              headingLevelOffset={3}
            />
          </div>
        ) : (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-xs">
            {text}
          </pre>
        ))}
    </article>
  );
}

function FlowRunResult({
  environmentId,
  snapshot,
}: {
  environmentId: EnvironmentId;
  snapshot: FlowRunSnapshot;
}) {
  const finals = flowResultStepRuns(snapshot);
  if (finals.length === 0) return null;
  return (
    <section aria-label="Flow run result" className="flex flex-col gap-3">
      <h3 className="text-xs font-medium text-muted-foreground">Result</h3>
      {finals.map(({ step, stepRun }) => (
        <FinalStepResult
          key={`${stepRun.id}:${stepRun.finishedAt}`}
          environmentId={environmentId}
          step={step}
          stepRun={stepRun}
        />
      ))}
    </section>
  );
}

/** `page` fills a flow run thread that has no messages; otherwise the card heads the chat. */
export function FlowRunThreadCard({
  threadRef,
  page = false,
}: {
  threadRef: ScopedThreadRef;
  page?: boolean;
}) {
  const lookup = useFlowRunLookup(threadRef);
  const id = lookup.data?.flowRunId;
  const detail = useEnvironmentQuery(
    id
      ? flowEnvironment.run({ environmentId: threadRef.environmentId, input: { flowRunId: id } })
      : null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const snapshot = detail.data;
  if (!snapshot) return id && detail.error ? <p role="alert">{detail.error}</p> : null;
  const { summary } = snapshot;
  const openInPanel = () =>
    useFlowPanelRequest
      .getState()
      .open(threadRef, { flowId: summary.flowId, flowRunId: summary.id });
  if (lookup.data?.role === "step_thread")
    return (
      <Alert variant="info">
        <AlertDescription>
          <InlineButton tone="default" onClick={openInPanel}>
            Part of {summary.flowTitle} · run {summary.runNumber}
          </InlineButton>
        </AlertDescription>
      </Alert>
    );
  const selected = snapshot.stepRuns.find((step) => step.id === selectedId);
  const timeline = (
    <>
      <FlowRunTimeline
        selectedId={selectedId}
        snapshot={snapshot}
        onSelect={(step) => setSelectedId(step.id)}
      />
      {selected && (
        <StepRunInspector
          key={selected.id}
          environmentId={threadRef.environmentId}
          snapshot={snapshot}
          stepRun={selected}
        />
      )}
    </>
  );
  if (!page)
    return (
      <section
        aria-label="Flow run"
        className="max-h-80 shrink-0 overflow-auto border-b border-border p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">
            {summary.flowTitle} · Flow run {summary.runNumber}
          </h2>
          <Button size="xs" variant="outline" onClick={openInPanel}>
            Open in Flow panel
          </Button>
        </div>
        <FlowRunActions environmentId={threadRef.environmentId} summary={summary} />
        {timeline}
      </section>
    );
  const startedAt = Date.parse(summary.startedAt ?? summary.createdAt);
  return (
    <section
      aria-label="Flow run"
      className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-6 px-4 py-6"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 className="truncate text-base font-semibold">{summary.flowTitle}</h2>
          <p className="text-xs text-muted-foreground">
            Flow run {summary.runNumber}
            {summary.finishedAt &&
              ` · took ${formatDuration(Date.parse(summary.finishedAt) - startedAt)}`}
          </p>
          <FlowRunActions environmentId={threadRef.environmentId} summary={summary} />
        </div>
        <Button size="xs" variant="outline" onClick={openInPanel}>
          Open in Flow panel
        </Button>
      </header>
      <FlowRunResult environmentId={threadRef.environmentId} snapshot={snapshot} />
      <section aria-label="Step runs" className="flex flex-col gap-3">
        <h3 className="text-xs font-medium text-muted-foreground">Steps</h3>
        {timeline}
      </section>
    </section>
  );
}
